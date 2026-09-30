import { posix } from "node:path";
import type { Node } from "web-tree-sitter";
import { globToRegExp, type ResourceReference } from "@xpl/core";
import { SymbolLookup, type SymbolEntry } from "./symbols.js";
import { nodeSpan } from "./ast.js";
import type { FileContext } from "./languages/types.js";

export interface ResourceSite {
  file: string;
  path: string;
  kind: "loads" | "discovers";
  site: ResourceReference["site"];
  resolution: ResourceReference["resolution"];
}

type PathValue = { path: string; inferred: boolean };
const EXTERNAL_PATH = /^(?:[a-z]+:|\/|\\)/i;

function literal(node: Node): string | undefined {
  const text = node.text;
  if (!/string|template/.test(node.type)) return undefined;
  if (
    !/^(?:"[^]*"|'[^]*'|`[^]*`)$/.test(text) ||
    text.includes("${") ||
    node.type.includes("interpolation")
  )
    return undefined;
  if (text.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }
  if (text.startsWith("`")) return text.slice(1, -1);
  if (/\\[^'\\]/.test(text)) return undefined;
  return text.slice(1, -1).replace(/\\(['\\])/g, "$1");
}

function callee(node: Node): Node | null {
  return node.childForFieldName("function") ?? node.childForFieldName("constructor");
}

function receiver(node: Node): Node | null {
  return (
    node.childForFieldName("object") ??
    node.childForFieldName("value") ??
    node.childForFieldName("operand")
  );
}

function evaluate(node: Node | null, ctx: FileContext, depth = 0): PathValue | undefined {
  if (!node || depth > 12) return undefined;
  const text = literal(node);
  if (text !== undefined) return { path: text, inferred: false };
  if (node.type === "identifier") {
    if (node.text === "__dirname") return { path: posix.dirname(ctx.file), inferred: false };
    if (node.text === "__file__") return { path: ctx.file, inferred: false };
    return undefined;
  }
  if (node.type === "parenthesized_expression")
    return evaluate(node.namedChildren[0] ?? null, ctx, depth + 1);
  if (["attribute", "member_expression", "selector_expression"].includes(node.type)) {
    const name =
      node.childForFieldName("attribute") ??
      node.childForFieldName("property") ??
      node.childForFieldName("field");
    const base = evaluate(receiver(node), ctx, depth + 1);
    if (!base) return undefined;
    if (name?.text === "parent") return { ...base, path: posix.dirname(base.path) };
    if (["pathname", "href"].includes(name?.text ?? "")) return base;
  }
  if (["binary_expression", "binary_operator", "boolean_operator"].includes(node.type)) {
    const left = evaluate(node.childForFieldName("left"), ctx, depth + 1);
    const right = evaluate(node.childForFieldName("right"), ctx, depth + 1);
    const operator =
      node.childForFieldName("operator")?.text ??
      node.children.find((child) => !child.isNamed)?.text;
    if (left && right && operator === "/")
      return EXTERNAL_PATH.test(right.path)
        ? undefined
        : { path: posix.join(left.path, right.path), inferred: left.inferred || right.inferred };
    if (left && right && operator === "+")
      return { path: left.path + right.path, inferred: left.inferred || right.inferred };
    if (["??", "||", "or"].includes(operator ?? "") && right) return { ...right, inferred: true };
  }
  if (["call", "call_expression", "new_expression"].includes(node.type)) {
    const fn = callee(node);
    const name = fn?.text.split(".").pop();
    const args = node.childForFieldName("arguments")?.namedChildren ?? [];
    if (name === "Path" || name === "PurePath") return evaluate(args[0] ?? null, ctx, depth + 1);
    if (name === "URL" && args[1]?.text === "import.meta.url") {
      const value = evaluate(args[0] ?? null, ctx, depth + 1);
      return value && !EXTERNAL_PATH.test(value.path)
        ? { ...value, path: posix.join(posix.dirname(ctx.file), value.path) }
        : undefined;
    }
    if (name === "join" || name === "joinpath" || name === "resolve") {
      const values = args.map((arg) => evaluate(arg, ctx, depth + 1));
      if (name === "joinpath" && fn) values.unshift(evaluate(receiver(fn), ctx, depth + 1));
      if (values.length === 0 || values.some((value) => !value)) return undefined;
      if (
        (name !== "join" || ctx.language === "python") &&
        values.some((value) => EXTERNAL_PATH.test(value!.path))
      )
        return undefined;
      return {
        path: posix.join(...values.map((value) => value!.path)),
        inferred: values.some((value) => value!.inferred),
      };
    }
  }
  return undefined;
}

export function collectResourceSites(ctx: FileContext): ResourceSite[] {
  if (!["typescript", "tsx", "javascript", "python", "go"].includes(ctx.language)) return [];
  const result: ResourceSite[] = [];
  const visit = (node: Node) => {
    if (node.type === "import_statement" && !node.children.some((child) => child.type === "type")) {
      const path = evaluate(node.childForFieldName("source"), ctx)?.path;
      if (path && /^\.\.?\//.test(path) && /\.(?:json|yaml|yml|toml)$/.test(path))
        result.push({
          file: ctx.file,
          path: posix.normalize(posix.join(posix.dirname(ctx.file), path)),
          kind: "loads",
          site: nodeSpan(node, ctx.lines),
          resolution: "static",
        });
    }
    if (["call", "call_expression"].includes(node.type)) {
      const fn = callee(node);
      const name = fn?.text.split(".").pop() ?? "";
      const glob = /^(glob|Glob|globSync|iglob|rglob)$/.test(name);
      const read = /^(readFile|readFileSync|ReadFile|readTextFile|open|read_text|read_bytes)$/.test(
        name,
      );
      const custom = /^(?:load|read)(?:Config|Configuration|Plugins|Template|Schema)$/.test(name);
      if (glob || read || custom) {
        const args = node.childForFieldName("arguments")?.namedChildren ?? [];
        let value = evaluate(args[0] ?? null, ctx);
        if (name === "read_text" || name === "read_bytes")
          value = evaluate(fn ? receiver(fn) : null, ctx);
        if (glob && fn && value) {
          const object = receiver(fn);
          const base = evaluate(object, ctx);
          if (base)
            value = {
              path: posix.join(base.path, name === "rglob" ? "**" : "", value.path),
              inferred: base.inferred || value.inferred,
            };
          else if (object?.text === "import.meta")
            value = { ...value, path: posix.join(posix.dirname(ctx.file), value.path) };
          else if (name === "rglob") value = undefined;
          const options = args[1];
          if (options?.text.includes("cwd")) {
            const pair = options.namedChildren.find(
              (child) => child.childForFieldName("key")?.text.replace(/["']/g, "") === "cwd",
            );
            const cwd = evaluate(pair?.childForFieldName("value") ?? null, ctx);
            value =
              cwd && value
                ? {
                    path: posix.join(cwd.path, value.path),
                    inferred: cwd.inferred || value.inferred,
                  }
                : undefined;
          }
        }
        if (value && value.path && !EXTERNAL_PATH.test(value.path)) {
          const path = posix.normalize(value.path);
          if (path !== ".." && !path.startsWith("../"))
            result.push({
              file: ctx.file,
              path,
              kind: glob ? "discovers" : "loads",
              site: nodeSpan(node, ctx.lines),
              resolution: value.inferred || custom ? "inferred" : "static",
            });
        }
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(ctx.tree.rootNode);
  return result;
}

export function resolveResources(
  sites: readonly ResourceSite[],
  files: readonly string[],
  symbols: readonly SymbolEntry[],
): ResourceReference[] {
  const known = new Set(files);
  const lookup = new SymbolLookup(symbols);
  return sites.flatMap((site) => {
    const targets =
      site.kind === "discovers"
        ? files.filter((file) => globToRegExp(site.path).test(file))
        : known.has(site.path)
          ? [site.path]
          : [];
    if (targets.length === 0) return [];
    const from = lookup.fromId(site.file, site.site.startLine, site.site.startCol ?? 1);
    return [
      {
        from,
        files: targets,
        kind: site.kind,
        site: site.site,
        resolution: site.resolution,
        ...(site.kind === "discovers" ? { pattern: site.path } : {}),
      },
    ];
  });
}
