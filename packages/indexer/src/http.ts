/**
 * Web requests linked to the server routes that answer them (ARCHITECTURE.md §3, Web requests).
 *
 * `collectHttpSites` reads one parsed file (file-local, cached with the extraction): the routes it defines, the
 * requests it makes and the prefixes it mounts routers under, each with a literal or template path.
 * `resolveRequests` runs once per build, after all references are known: it adds the mount prefixes to the
 * routes, matches every request by method and normalised path, and returns `request` references from the
 * symbol making the call to the route's handler. They are always heuristic: a matching path is a hint that the
 * call reaches that handler, not proof (a proxy, a base URL or another server may answer it).
 *
 * Detected:
 * - TS/JS routes: `<router>.get|post|put|patch|delete|head|options|all(path, ..., handler)` in a file that imports
 *   express, koa, hono, fastify, restify or polka, or on a receiver named `app`, `router`, `server` or `fastify`;
 *   Next.js `app/**\/route.ts` exports (`GET`, `POST`, ...) and `pages/api/**` default exports. Mounts:
 *   `<router>.use|route(prefix, child)`, `new Router({ prefix })`.
 * - TS/JS requests: `fetch`, `axios`, `ky`, `got`, `useSWR` and `$fetch` calls, and `.get/.post/...` on
 *   `axios`, `ky`, `got`, `superagent`, `request(...)` or a receiver named like a client (`api`, `http`,
 *   `client`, `...Client`, `...Api`).
 * - Python routes: `@<router>.get|post|...(path)` and `@<router>.route|api_route(path, methods=[...])`
 *   decorators; mounts: `APIRouter(prefix=)`, `Blueprint(..., url_prefix=)`, `include_router(child, prefix=)`,
 *   `register_blueprint(child, url_prefix=)`. Requests: `.get/.post/...` and `.request(method, url)` on
 *   `requests`, `httpx`, `session`, `client` (and `..._client`, `..._session`).
 * - Go routes: `HandleFunc` / `Handle` (with a `"GET /path"` pattern or none), chi `Get/Post/...` and
 *   `Method(m, path, h)`, gin and echo `GET/POST/...`; mounts: `g := r.Group(prefix)` and chi
 *   `r.Route(prefix, func(r chi.Router) {...})`. Requests: `http.Get/Head/Post/PostForm`,
 *   `http.NewRequest(WithContext)`, and `Get/Head/Post` on a receiver named `...client`.
 *
 * Paths: `:id`, `{id}`, `<int:id>`, `[id]` and `${...}` / f-string / `%s` holes are one parameter;
 * `*`, `{p...}`, `{p:path}`, `<path:p>` and `[...p]` the rest of the path. The query string and the hash
 * are dropped. An absolute URL keeps its path only for a local or example host (`localhost`, `127.0.0.1`,
 * `example.com`, ...); a request to any other host is left out. A string constant at the top of the file reads
 * as its value (`${API_BASE}/greeting`); any other leading `${base}` before the first `/` is dropped (a
 * configured origin). A catch-all route that matches no literal segment (a single-page fallback) links nothing.
 */
import type { Node } from "web-tree-sitter";
import type { FilePath, Reference, SymbolId } from "@xpl/core";
import { nodeSpan, spanContains, spanLineCount } from "./ast.js";
import { SymbolLookup, type SymbolEntry } from "./symbols.js";
import type { FileContext, Span } from "./languages/types.js";

/**
 * Where a route's handler is: a name to resolve through the references at that span, code inside a function
 * the route itself defines (an inline callback, a decorated function), or a top-level symbol of the file.
 */
export type HttpHandler = { ref: Span } | { inside: Span } | { symbol: string };
/** A router variable: its name in the file, and the span of the use (resolved through the references). */
export interface HttpRouter {
  name: string;
  site: Span;
}

/** File-local HTTP facts; plain JSON for the extraction cache. Paths are normalised (`normalizePath`). */
export interface HttpSites {
  file: FilePath;
  routes: { method: string; path: string; router?: HttpRouter; handler: HttpHandler }[];
  requests: { method: string; path: string; site: Span }[];
  /** Routes registered on `router` (a name in this file, or the span of a use) answer under `prefix`. */
  mounts: { prefix: string; router: string | Span; parent?: HttpRouter }[];
}

// ─── Paths ────────────────────────────────────────────────────────────────────────────────────────

/** Stands for a part of a path the code computes (`${id}`, `{id}` of an f-string, `%s`). */
const HOLE = "\u0000";
const PARAM = "{}";
const REST = "{*}";
const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const PRINTF_VERB = /%[-#0 +]*\d*(?:\.\d+)?[a-zA-Z]/g;

/**
 * The string constants at the top of the file being collected (`const API_BASE = "/api/chat"`, `API = "/api"`,
 * Go `const base = "/v1"`), read by name in a path: `` `${API_BASE}/greeting` `` is `/api/chat/greeting`. Set by
 * `collectHttpSites` for the duration of one file.
 */
let constants = new Map<string, string>();

function fileConstants(root: Node): Map<string, string> {
  constants = new Map();
  const declarations = (node: Node): Node[] =>
    node.type === "export_statement"
      ? node.namedChildren.flatMap(declarations)
      : node.type === "expression_statement"
        ? node.namedChildren.filter((c) => c.type === "assignment") // Python
        : node.type === "lexical_declaration" && node.text.startsWith("const")
          ? node.namedChildren.filter((c) => c.type === "variable_declarator")
          : node.type === "const_declaration" // Go
            ? node.namedChildren.filter((c) => c.type === "const_spec")
            : [];
  for (const d of root.namedChildren.flatMap(declarations)) {
    const name = d.childForFieldName("name") ?? d.childForFieldName("left");
    const value = d.childForFieldName("value") ?? d.childForFieldName("right");
    const text = pathValue(value?.type === "expression_list" ? value.namedChildren[0] : value);
    if (name?.type === "identifier" && text !== undefined && !text.includes(HOLE))
      constants.set(name.text, text);
  }
  return constants;
}

/** The text of a string built from literals, with holes for what is computed; undefined for anything else. */
function pathValue(node: Node | null | undefined, depth = 0): string | undefined {
  if (!node || depth > 8) return undefined;
  switch (node.type) {
    case "identifier":
      return constants.get(node.text);
    case "string":
    case "template_string":
    case "interpreted_string_literal":
    case "raw_string_literal": {
      let out = "";
      for (const c of node.namedChildren) {
        if (c.type === "template_substitution" || c.type === "interpolation") {
          const inner = c.namedChildren.length === 1 ? c.namedChildren[0] : undefined;
          out += (inner?.type === "identifier" && constants.get(inner.text)) || HOLE;
        } else if (c.type !== "string_start" && c.type !== "string_end") out += c.text;
      }
      return out;
    }
    case "concatenated_string": {
      const parts = node.namedChildren.map((c) => pathValue(c, depth + 1));
      return parts.every((p) => p !== undefined) ? parts.join("") : undefined;
    }
    case "parenthesized_expression":
      return pathValue(node.namedChildren[0], depth + 1);
    case "binary_expression":
    case "binary_operator": {
      const op = node.childForFieldName("operator")?.text;
      const left = pathValue(node.childForFieldName("left"), depth + 1);
      if (op === "%") return left?.replace(PRINTF_VERB, HOLE);
      if (op !== "+") return undefined;
      const right = pathValue(node.childForFieldName("right"), depth + 1);
      return left === undefined && right === undefined
        ? undefined
        : (left ?? HOLE) + (right ?? HOLE);
    }
    case "call":
    case "call_expression": {
      const fn = node.childForFieldName("function");
      if (fn?.text === "fmt.Sprintf")
        return pathValue(argumentsOf(node)[0], depth + 1)?.replace(PRINTF_VERB, HOLE);
      if (fn?.type === "attribute" && fn.childForFieldName("attribute")?.text === "format")
        return pathValue(fn.childForFieldName("object"), depth + 1)?.replace(/\{[^}]*\}/g, HOLE);
      return undefined;
    }
  }
  return undefined;
}

/** A host whose URL stays in this repository: local, a test domain, or a computed one. */
function localHost(authority: string): boolean {
  if (authority.includes(HOLE)) return true;
  const host = authority.replace(/^.*@/, "").replace(/:\d*$/, "").toLowerCase();
  return (
    /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(host) ||
    /\.(?:localhost|local|test|example)$/.test(host) ||
    /(?:^|\.)example\.(?:com|org|net)$/.test(host)
  );
}

function segment(raw: string): string {
  if (raw.includes(HOLE)) return PARAM;
  if (/^\*|^\{\w*(?:\.\.\.|:path)\}$|^<path:\w+>$|^\[\[?\.\.\./.test(raw)) return REST;
  if (/^:|[{<[]/.test(raw)) return PARAM;
  return raw;
}

/**
 * `/orders/{}` for `"/orders/:id"`, `` `/orders/${id}?x=1` `` or `"http://localhost:3000/orders/<int:id>"`;
 * undefined when it is not a path of this repository's server (another host, no leading `/`). A route path may
 * be empty (`@router.get("")`): it is the router's own prefix.
 */
function normalizePath(value: string, route = false): string | undefined {
  let v = value.trim();
  if (v.startsWith(HOLE)) {
    v = v.slice(1);
    if (!v.startsWith("/") || v.startsWith("//")) return undefined;
  }
  const absolute = /^(?:[a-z]+:)?\/\/([^/?#]*)(.*)$/i.exec(v);
  if (absolute) {
    if (!localHost(absolute[1]!)) return undefined;
    v = absolute[2] || "/";
  }
  if (route && v === "") v = "/";
  if (!v.startsWith("/")) return undefined;
  const segments = v
    .split(/[?#]/)[0]!
    .split("/")
    .filter((s) => s !== "" && s !== "{$}")
    .map(segment);
  return "/" + segments.join("/");
}

function joinPath(prefix: string, path: string): string {
  if (prefix === "" || prefix === "/") return path;
  return path === "/" ? prefix : prefix + path;
}

/** How many literal segments of the route the request matches; undefined when it does not match. */
function matchScore(request: readonly string[], route: readonly string[]): number | undefined {
  let literal = 0;
  for (let i = 0; i < route.length; i++) {
    const r = route[i]!;
    if (r === REST) return i < request.length ? literal : undefined;
    const q = request[i];
    if (q === undefined) return undefined;
    if (r === PARAM) continue;
    if (q !== r) return undefined; // a computed request segment never matches a literal route segment
    literal++;
  }
  return request.length === route.length ? literal : undefined;
}

const segmentsOf = (path: string) => path.split("/").filter(Boolean);

// ─── Collection ───────────────────────────────────────────────────────────────────────────────────

function argumentsOf(call: Node): Node[] {
  return (
    call.childForFieldName("arguments")?.namedChildren.filter((c) => c.type !== "comment") ?? []
  );
}

/** Python: positional arguments, and keyword arguments by name. */
function pythonArguments(call: Node): { positional: Node[]; keyword: Map<string, Node> } {
  const positional: Node[] = [];
  const keyword = new Map<string, Node>();
  for (const arg of argumentsOf(call)) {
    if (arg.type !== "keyword_argument") positional.push(arg);
    else {
      const name = arg.childForFieldName("name")?.text;
      const value = arg.childForFieldName("value");
      if (name && value) keyword.set(name, value);
    }
  }
  return { positional, keyword };
}

/** The last name of a receiver chain: `api` for `api`, `http` for `this.http`, `request` for `request(app)`. */
function receiverName(node: Node | null | undefined): string {
  if (!node) return "";
  switch (node.type) {
    case "identifier":
      return node.text;
    case "member_expression":
      return node.childForFieldName("property")?.text ?? "";
    case "attribute":
      return node.childForFieldName("attribute")?.text ?? "";
    case "selector_expression":
      return node.childForFieldName("field")?.text ?? "";
    case "call":
    case "call_expression":
      return receiverName(node.childForFieldName("function"));
  }
  return "";
}

/** `{ method: "POST" }` -> the `"POST"` node (a shorthand `{ method }` -> the name). */
function property(object: Node | undefined, key: string): Node | undefined {
  if (object?.type !== "object") return undefined;
  for (const pair of object.namedChildren) {
    if (pair.type === "shorthand_property_identifier" && pair.text === key) return pair;
    if (pair.type !== "pair") continue;
    const name = pair.childForFieldName("key");
    const text = name?.type === "property_identifier" ? name.text : pathValue(name);
    if (text === key) return pair.childForFieldName("value") ?? undefined;
  }
  return undefined;
}

/** An HTTP method from a literal (`"post"`, `http.MethodPost`); `*` (any) when it is computed. */
function methodOf(node: Node | undefined): string {
  if (node?.type === "selector_expression" && node.text.startsWith("http.Method"))
    return node.text.slice("http.Method".length).toUpperCase();
  const value = pathValue(node);
  return value === undefined || value.includes(HOLE) ? "*" : value.toUpperCase();
}

const SERVER_IMPORT =
  /(?:from\s*|require\(\s*)["'](?:express|koa|@koa\/router|koa-router|hono(?:\/[\w/-]+)?|fastify|restify|polka)["']/;
const SERVER_RECEIVERS = new Set(["app", "router", "server", "fastify"]);
const TS_CLIENT =
  /^(?:axios|ky|got|superagent|request|http|api|client|\$axios|\$http|\$api)$|(?:Client|Api|API|Http)$/;
const TS_CALLS = new Set([
  "fetch",
  "axios",
  "ky",
  "got",
  "useSWR",
  "useSWRImmutable",
  "$fetch",
  "ofetch",
]);
const TS_HANDLERS = new Set([
  "arrow_function",
  "function_expression",
  "function",
  "identifier",
  "member_expression",
  "call_expression",
]);
const PY_CLIENT = /^(?:requests|httpx|session|client|http|api)$|_(?:client|session)$/i;
const GO_METHODS: Record<string, string> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
  Head: "HEAD",
  Options: "OPTIONS",
};
const HTTP_METHOD_NAMES = new Set(Object.values(GO_METHODS));

interface Emit {
  request(url: Node | undefined, method: string, call: Node): void;
  route(
    method: string,
    path: string | undefined,
    receiver: Node | null | undefined,
    handler: HttpHandler,
    prefix?: string,
  ): void;
  mount(prefix: string | undefined, router: string | Span, parent?: Node | null): void;
  span(node: Node): Span;
}

/** The routes, requests and mounts of one file (TS/JS, Python, Go); undefined when it has none. */
export function collectHttpSites(ctx: FileContext): HttpSites | undefined {
  const collect = {
    typescript: collectTs,
    tsx: collectTs,
    javascript: collectTs,
    python: collectPython,
    go: collectGo,
  }[ctx.language as string];
  if (!collect) return undefined;
  const sites: HttpSites = { file: ctx.file, routes: [], requests: [], mounts: [] };
  fileConstants(ctx.tree.rootNode);
  const span = (node: Node) => nodeSpan(node, ctx.lines);
  const routerOf = (node: Node | null | undefined) =>
    node?.type === "identifier" ? { name: node.text, site: span(node) } : undefined;
  collect(ctx, {
    span,
    request(url, method, call) {
      const value = pathValue(url);
      const path = value === undefined ? undefined : normalizePath(value);
      if (!path) return;
      // Like a call site: the whole call, or only the callee when the call spans more than 10 lines.
      const whole = span(call);
      const fn = call.childForFieldName("function");
      sites.requests.push({
        method,
        path,
        site: spanLineCount(whole) > 10 && fn ? span(fn) : whole,
      });
    },
    route(method, path, receiver, handler, prefix = "") {
      const normal = path === undefined ? undefined : normalizePath(path, true);
      if (normal === undefined) return;
      const router = routerOf(receiver);
      sites.routes.push({
        method,
        path: joinPath(prefix, normal),
        handler,
        ...(router ? { router } : {}),
      });
    },
    mount(prefix, router, parent) {
      const normal = prefix === undefined ? undefined : normalizePath(prefix, true);
      if (normal === undefined) return;
      const of = routerOf(parent);
      sites.mounts.push({ prefix: normal, router, ...(of ? { parent: of } : {}) });
    },
  });
  return sites.routes.length + sites.requests.length + sites.mounts.length > 0 ? sites : undefined;
}

function visit(node: Node, fn: (node: Node) => boolean | void): void {
  if (fn(node) === false) return;
  for (const child of node.namedChildren) visit(child, fn);
}

function collectTs(ctx: FileContext, emit: Emit): void {
  const server = SERVER_IMPORT.test(ctx.source);
  const handler = (node: Node): HttpHandler =>
    ["arrow_function", "function_expression", "function"].includes(node.type)
      ? { inside: emit.span(node) }
      : { ref: emit.span(node) };
  // Next.js: `app/api/orders/[id]/route.ts` exports GET, POST, ...; `pages/api/users/index.ts` a default handler.
  const appRoute = /(?:^|\/)app\/((?:[^/]+\/)*)route\.[cm]?[jt]sx?$/.exec(ctx.file);
  const pagesApi = /(?:^|\/)pages\/(api(?:\/[^/]+)*?)(?:\/index)?\.[cm]?[jt]sx?$/.exec(ctx.file);
  if (appRoute || pagesApi) {
    const dir = appRoute
      ? appRoute[1]!
          .split("/")
          .filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@")) // route groups, parallel slots
          .join("/")
      : pagesApi![1]!;
    for (const statement of ctx.tree.rootNode.namedChildren) {
      if (statement.type !== "export_statement") continue;
      const declaration = statement.childForFieldName("declaration");
      const names = !declaration
        ? []
        : declaration.type === "lexical_declaration"
          ? declaration.namedChildren.map((d) => d.childForFieldName("name")?.text)
          : [declaration.childForFieldName("name")?.text];
      if (appRoute) {
        for (const name of names)
          if (name && HTTP_METHOD_NAMES.has(name))
            emit.route(name, `/${dir}`, null, { symbol: name });
      } else if (statement.children.some((c) => c.type === "default")) {
        const value = statement.childForFieldName("value");
        const name = names[0] ?? (value?.type === "identifier" ? value.text : "");
        emit.route("*", `/${dir}`, null, { symbol: name });
      }
    }
  }
  visit(ctx.tree.rootNode, (node) => {
    if (node.type === "variable_declarator") {
      // `const router = new Router({ prefix: "/api" })` (koa-router)
      const value = node.childForFieldName("value");
      const name = node.childForFieldName("name");
      if (value?.type === "new_expression" && name?.type === "identifier") {
        const prefix = property(argumentsOf(value)[0], "prefix");
        if (prefix && /Router$/.test(value.childForFieldName("constructor")?.text ?? ""))
          emit.mount(pathValue(prefix), name.text);
      }
      return;
    }
    if (node.type !== "call_expression") return;
    const fn = node.childForFieldName("function");
    const args = argumentsOf(node);
    if (fn?.type === "identifier" && TS_CALLS.has(fn.text)) {
      let url: Node | undefined = args[0];
      let init: Node | undefined = fn.text.startsWith("useSWR") ? undefined : args[1]; // SWR: (key, fetcher)
      if (url?.type === "object") [init, url] = [url, property(url, "url")]; // axios({ url, method })
      const method = property(init, "method");
      emit.request(
        url,
        !init ? "GET" : init.type !== "object" ? "*" : method ? methodOf(method) : "GET",
        node,
      );
      return;
    }
    if (fn?.type !== "member_expression") return;
    const name = fn.childForFieldName("property")?.text ?? "";
    const receiver = fn.childForFieldName("object");
    const last = args.at(-1);
    if (METHODS.includes(name) || name === "all") {
      if (
        args.length >= 2 &&
        last &&
        TS_HANDLERS.has(last.type) &&
        (server || SERVER_RECEIVERS.has(receiverName(receiver)))
      )
        emit.route(
          name === "all" ? "*" : name.toUpperCase(),
          pathValue(args[0]),
          receiver,
          handler(last),
        );
      else if (TS_CLIENT.test(receiverName(receiver)))
        emit.request(args[0], name.toUpperCase(), node);
    } else if ((name === "use" || name === "route") && args.length >= 2 && last) {
      // `app.use("/api", orders)`, `router.use("/api", orders.routes())` (koa-router), `app.route("/api", sub)` (hono)
      const child =
        last.type === "call_expression"
          ? last.childForFieldName("function")?.childForFieldName("object")
          : last;
      if (child && ["identifier", "member_expression"].includes(child.type))
        emit.mount(pathValue(args[0]), emit.span(child), receiver);
    }
  });
}

function collectPython(ctx: FileContext, emit: Emit): void {
  const each = (node: Node): boolean | void => {
    if (node.type === "decorated_definition") {
      const definition = node.childForFieldName("definition");
      const name = definition?.childForFieldName("name");
      if (!definition || !name) return;
      for (const decorator of node.namedChildren) {
        const call = decorator.type === "decorator" ? decorator.namedChildren[0] : undefined;
        const fn = call?.type === "call" ? call.childForFieldName("function") : undefined;
        if (!call || fn?.type !== "attribute") continue;
        const attr = fn.childForFieldName("attribute")?.text ?? "";
        const receiver = fn.childForFieldName("object");
        const { positional, keyword } = pythonArguments(call);
        const path = pathValue(positional[0] ?? keyword.get("path") ?? keyword.get("rule"));
        const handler = { inside: emit.span(name) };
        if (METHODS.includes(attr)) emit.route(attr.toUpperCase(), path, receiver, handler);
        else if (attr === "route" || attr === "api_route") {
          const methods = keyword.get("methods");
          const list = !methods
            ? ["GET"]
            : methods.type === "list"
              ? methods.namedChildren.map(methodOf)
              : ["*"];
          for (const method of list) emit.route(method, path, receiver, handler);
        }
      }
      visit(definition, each);
      return false; // the decorators are routes, not requests
    }
    if (node.type === "assignment") {
      // `router = APIRouter(prefix="/items")`, `bp = Blueprint("users", __name__, url_prefix="/users")`
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (left?.type === "identifier" && right?.type === "call") {
        const ctor = receiverName(right.childForFieldName("function"));
        const prefix = pythonArguments(right).keyword.get(
          ctor === "Blueprint" ? "url_prefix" : "prefix",
        );
        if ((ctor === "APIRouter" || ctor === "Blueprint") && prefix)
          emit.mount(pathValue(prefix), left.text);
      }
      return;
    }
    if (node.type !== "call") return;
    const fn = node.childForFieldName("function");
    if (fn?.type !== "attribute") return;
    const attr = fn.childForFieldName("attribute")?.text ?? "";
    const receiver = fn.childForFieldName("object");
    const { positional, keyword } = pythonArguments(node);
    if (attr === "include_router" || attr === "register_blueprint") {
      const child = positional[0];
      const prefix = keyword.get(attr === "include_router" ? "prefix" : "url_prefix");
      if (child && ["identifier", "attribute"].includes(child.type))
        emit.mount(prefix ? pathValue(prefix) : "", emit.span(child), receiver);
    } else if (PY_CLIENT.test(receiverName(receiver))) {
      if (METHODS.includes(attr))
        emit.request(positional[0] ?? keyword.get("url"), attr.toUpperCase(), node);
      else if (attr === "request")
        emit.request(
          positional[1] ?? keyword.get("url"),
          methodOf(positional[0] ?? keyword.get("method")),
          node,
        );
    }
  };
  visit(ctx.tree.rootNode, each);
}

function collectGo(ctx: FileContext, emit: Emit): void {
  const echo = /"github\.com\/labstack\/echo/.test(ctx.source);
  const handler = (node: Node): HttpHandler => {
    if (node.type === "func_literal") return { inside: emit.span(node) };
    if (
      node.type === "call_expression" &&
      node.childForFieldName("function")?.text === "http.HandlerFunc"
    ) {
      const inner = argumentsOf(node)[0];
      if (inner) return handler(inner);
    }
    return { ref: emit.span(node) };
  };
  const walk = (root: Node, prefix: string): void =>
    visit(root, (node) => {
      if (node.type !== "call_expression") return;
      const fn = node.childForFieldName("function");
      if (fn?.type !== "selector_expression") return;
      const field = fn.childForFieldName("field")?.text ?? "";
      const operand = fn.childForFieldName("operand");
      const args = argumentsOf(node);
      if (operand?.text === "http") {
        if (["Get", "Head", "Post", "PostForm"].includes(field))
          return emit.request(args[0], field === "PostForm" ? "POST" : GO_METHODS[field]!, node);
        if (field === "NewRequest" || field === "NewRequestWithContext") {
          const at = field === "NewRequest" ? 0 : 1;
          return emit.request(args[at + 1], methodOf(args[at]), node);
        }
      }
      if (/client$/i.test(receiverName(operand)) && ["Get", "Head", "Post"].includes(field)) {
        if (args.length === (field === "Post" ? 3 : 1))
          return emit.request(args[0], GO_METHODS[field]!, node);
      }
      if ((field === "HandleFunc" || field === "Handle") && args.length === 2) {
        // net/http patterns: "/orders/{id}", "GET /orders/{id}", "GET example.com/orders"
        const pattern = /^(?:([A-Z]+)\s+)?[^/\s]*(\/.*)?$/.exec(pathValue(args[0]) ?? "");
        if (pattern?.[2])
          emit.route(pattern[1] ?? "*", pattern[2], operand, handler(args[1]!), prefix);
      } else if (GO_METHODS[field] && args.length === 2) {
        emit.route(GO_METHODS[field]!, pathValue(args[0]), operand, handler(args[1]!), prefix); // chi
      } else if ((HTTP_METHOD_NAMES.has(field) || field === "Any") && args.length >= 2) {
        // gin: (path, handlers...) with the handler last; echo: (path, handler, middleware...)
        const h = echo ? args[1]! : args.at(-1)!;
        emit.route(field === "Any" ? "*" : field, pathValue(args[0]), operand, handler(h), prefix);
      } else if ((field === "Method" || field === "MethodFunc") && args.length === 3) {
        emit.route(methodOf(args[0]), pathValue(args[1]), operand, handler(args[2]!), prefix);
      } else if (field === "Route" && args.length === 2 && args[1]!.type === "func_literal") {
        // chi: `r.Route("/v1", func(r chi.Router) { r.Get("/users", h) })`
        const inner = pathValue(args[0]);
        const normal = inner === undefined ? undefined : normalizePath(inner, true);
        if (normal !== undefined) {
          walk(args[1]!, joinPath(prefix, normal));
          return false;
        }
      } else if (field === "Group" && args.length >= 1) {
        // gin, echo: `api := r.Group("/api")`
        const declaration = node.parent?.parent;
        const target =
          declaration?.type === "short_var_declaration" ||
          declaration?.type === "assignment_statement"
            ? declaration.childForFieldName("left")?.namedChildren[0]
            : undefined;
        const value = pathValue(args[0]);
        const normal = value === undefined ? undefined : normalizePath(value, true);
        if (target?.type === "identifier" && normal !== undefined)
          emit.mount(joinPath(prefix, normal), target.text, operand);
      }
    });
  walk(ctx.tree.rootNode, "");
}

// ─── Resolution ───────────────────────────────────────────────────────────────────────────────────

/** Most prefixes one router gets through its mounts (a router mounted in many places). */
const MAX_PREFIXES = 16;

/**
 * `request` references from every request to the routes that answer it: the method agrees (or one side is
 * any) and the path matches; of several matches, those with the most literal segments win (`/orders/latest`
 * over `/orders/:id`), then those whose method is the request's own.
 */
export function resolveRequests(
  sites: readonly HttpSites[],
  entries: readonly SymbolEntry[],
  refs: readonly Reference[],
): Reference[] {
  if (!sites.some((s) => s.requests.length > 0)) return [];
  const lookup = new SymbolLookup(entries);
  const byFile = new Map<FilePath, Reference[]>();
  for (const ref of refs) {
    const file = ref.from.slice(0, ref.from.indexOf("#"));
    const list = byFile.get(file);
    if (list) list.push(ref);
    else byFile.set(file, [ref]);
  }
  /** What the name at `span` refers to: the widest reference whose site ends where the span ends. */
  const resolved = (file: FilePath, span: Span): SymbolId | undefined => {
    let best: Reference | undefined;
    for (const ref of byFile.get(file) ?? []) {
      const site = ref.site;
      if (site.endLine !== span.endLine || site.endCol !== span.endCol) continue;
      if (!spanContains(span, site.startLine, site.startCol ?? 1)) continue;
      if (
        !best ||
        site.startLine < best.site.startLine ||
        (site.startLine === best.site.startLine && (site.startCol ?? 1) < (best.site.startCol ?? 1))
      )
        best = ref;
    }
    return best?.to;
  };
  const routerKey = (file: FilePath, router: HttpRouter) =>
    resolved(file, router.site) ?? `${file}#${router.name}`;

  const mounts = new Map<string, { prefix: string; parent?: string }[]>();
  for (const s of sites)
    for (const m of s.mounts) {
      const key =
        typeof m.router === "string" ? `${s.file}#${m.router}` : resolved(s.file, m.router);
      if (!key) continue;
      const parent = m.parent ? routerKey(s.file, m.parent) : undefined;
      const list = mounts.get(key) ?? [];
      list.push({ prefix: m.prefix, ...(parent ? { parent } : {}) });
      mounts.set(key, list);
    }
  const prefixes = (key: string | undefined, seen: ReadonlySet<string>): string[] => {
    const list = key && !seen.has(key) ? mounts.get(key) : undefined;
    if (!list) return [""];
    const next = new Set(seen).add(key!);
    // A mount without a parent is the router's own prefix (`APIRouter(prefix=)`); the others attach it to a
    // parent router, under the parent's own prefixes.
    const own = list.find((m) => !m.parent)?.prefix ?? "";
    const attached = list.filter((m) => m.parent);
    const above = attached.length
      ? attached.flatMap((m) => prefixes(m.parent, next).map((p) => joinPath(p, m.prefix)))
      : [""];
    return above.map((p) => joinPath(p, own)).slice(0, MAX_PREFIXES);
  };

  const routes = sites.flatMap((s) =>
    s.routes.flatMap((r) => {
      const h = r.handler;
      const to =
        "symbol" in h
          ? lookup.get(`${s.file}#${h.symbol}`)
            ? `${s.file}#${h.symbol}`
            : `${s.file}#`
          : "ref" in h
            ? (resolved(s.file, h.ref) ?? lookup.fromId(s.file, h.ref.startLine, h.ref.startCol))
            : lookup.fromId(s.file, h.inside.startLine, h.inside.startCol);
      const under = new Set(prefixes(r.router && routerKey(s.file, r.router), new Set()));
      return [...under].map((p) => ({
        method: r.method,
        segments: segmentsOf(joinPath(p, r.path)),
        to,
      }));
    }),
  );

  const out: Reference[] = [];
  for (const s of sites)
    for (const q of s.requests) {
      const segments = segmentsOf(q.path);
      let best = -1;
      let targets: SymbolId[] = [];
      for (const r of routes) {
        if (q.method !== "*" && r.method !== "*" && q.method !== r.method) continue;
        const literal = matchScore(segments, r.segments);
        // A catch-all that matches no literal segment (`/{full_path:path}`, `app.get("*")`) is a single-page
        // fallback or a proxy: it answers every path, so it tells nothing about this one.
        if (literal === undefined || (literal === 0 && r.segments.includes(REST))) continue;
        const score = literal * 2 + (q.method === r.method ? 1 : 0);
        if (score > best) [best, targets] = [score, [r.to]];
        else if (score === best) targets.push(r.to);
      }
      const from = lookup.fromId(s.file, q.site.startLine, q.site.startCol);
      for (const to of new Set(targets))
        if (to !== from)
          out.push({ from, to, kind: "request", site: q.site, resolution: "heuristic" });
    }
  return out;
}
