/** Java syntax facts. Resolution remains in the shared heuristic resolver. */
import type { Node, Tree } from "web-tree-sitter";
import { nodeSpan, spanContains, spanLineCount } from "../ast.js";
import { HEURISTIC_SUPPORT, STRUCTURE_SUPPORT } from "../analysis.js";
import type { FileLanguage } from "@xpl/core";
import type { GrammarId } from "../wasm-files.js";
import type {
  ClassifiedSite,
  FileContext,
  FileFacts,
  LanguagePack,
  RepoView,
  SiteDraft,
  Span,
  TypeFact,
} from "./types.js";

interface LocatedSite {
  draft: SiteDraft;
  name: Span;
}

const classificationCache = new WeakMap<Tree, LocatedSite[]>();

const TYPE_DECLARATIONS = new Map<string, "class" | "interface" | "enum">([
  ["class_declaration", "class"],
  ["interface_declaration", "interface"],
  ["enum_declaration", "enum"],
  ["record_declaration", "class"],
  ["annotation_type_declaration", "interface"],
]);
const TYPE_NODES = new Set(["type_identifier", "scoped_type_identifier"]);
const PRIMITIVES = new Set([
  "void",
  "boolean",
  "byte",
  "char",
  "double",
  "float",
  "int",
  "long",
  "short",
  "var",
]);

function field(node: Node, name: string): Node | undefined {
  return node.childForFieldName(name) ?? undefined;
}

function nameOf(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (TYPE_NODES.has(node.type) || node.type === "identifier") return node.text;
  if (node.type === "generic_type" || node.type === "array_type")
    return nameOf(node.namedChildren[0]);
  return undefined;
}

function lastName(node: Node): Node {
  if ((node.type === "generic_type" || node.type === "array_type") && node.namedChildren[0])
    return lastName(node.namedChildren[0]);
  return field(node, "name") ?? node.namedChildren.at(-1) ?? node;
}

function receiver(node: Node | undefined): string[] | undefined {
  if (!node) return [];
  if (node.type === "this" || node.type === "super") return [node.text];
  if (node.type === "identifier" || node.type === "type_identifier") return [node.text];
  if (node.type === "field_access") {
    const base = receiver(field(node, "object"));
    const member = field(node, "field");
    return base && member ? [...base, member.text] : undefined;
  }
  if (node.type === "scoped_identifier" || node.type === "scoped_type_identifier")
    return node.text.split(".");
  if (node.type === "parenthesized_expression") return receiver(node.namedChildren[0]);
  return undefined;
}

function extractJava(ctx: FileContext): { facts: FileFacts; located: LocatedSite[] } {
  const facts: FileFacts = { symbols: [], sites: [], imports: [], typeFacts: [] };
  const located: LocatedSite[] = [];
  const lines = ctx.lines;
  const packageAliases = new Map<string, string>();
  const qualified = (
    node: Node | undefined,
  ): { qualifier: string[]; typeName: string } | undefined => {
    if (!node) return undefined;
    if (node.type === "generic_type" || node.type === "array_type")
      return qualified(node.namedChildren[0]);
    if (node.type !== "scoped_type_identifier") return undefined;
    const parts = node.text.split(".");
    const classStart = parts.findIndex((part) => /^[A-Z]/.test(part));
    if (classStart <= 0) return undefined;
    const module = parts.slice(0, classStart).join(".");
    let alias = packageAliases.get(module);
    if (!alias) {
      alias = `@package:${module.replaceAll(".", "/")}`;
      packageAliases.set(module, alias);
      facts.imports.push({ localName: alias, module, implicit: true, site: nodeSpan(node, lines) });
    }
    const classes = parts.slice(classStart);
    return {
      qualifier: [alias, ...classes.slice(0, -1)],
      typeName: `${alias}.${classes.join(".")}`,
    };
  };
  const emit = (kind: SiteDraft["kind"], name: Node, site: Node, qualifier: string[] = []) => {
    const draft: SiteDraft = {
      kind,
      name: name.text.split(".").at(-1)!,
      qualifier,
      site: nodeSpan(spanLineCount(nodeSpan(site, lines)) > 10 ? name : site, lines),
    };
    facts.sites.push(draft);
    located.push({ draft, name: nodeSpan(name, lines) });
  };
  const typeFact = (scopePath: string, name: string, kind: TypeFact["kind"], node?: Node) => {
    const typeName = qualified(node)?.typeName ?? nameOf(node);
    if (typeName && !PRIMITIVES.has(typeName))
      facts.typeFacts.push({ scopePath, name, kind, typeName });
  };
  const parameters = (node: Node | undefined, scope: string) => {
    for (const param of node?.namedChildren ?? []) {
      if (param.type !== "formal_parameter" && param.type !== "spread_parameter") continue;
      const name = field(param, "name");
      if (name) typeFact(scope, name.text, "param", field(param, "type"));
    }
  };
  const importNode = (node: Node) => {
    const raw = node.text
      .replace(/^import\s+/, "")
      .replace(/;\s*$/, "")
      .trim();
    const staticImport = raw.startsWith("static ");
    const spec = staticImport ? raw.slice(7).trim() : raw;
    if (staticImport || spec.endsWith(".*")) {
      // The resolver cannot represent static members or wildcard imports as bindings.
      return;
    }
    const parts = spec.split(".");
    const classStart = parts.findIndex((part) => /^[A-Z]/.test(part));
    const split = classStart > 0 ? classStart : parts.length - 1;
    if (split <= 0) return;
    const localName = parts.at(-1)!;
    const importedName = parts.slice(split).join(".");
    const module = parts.slice(0, split).join(".");
    facts.imports.push({
      localName,
      module,
      importedName,
      site: nodeSpan(node, lines),
    });
    located.push({
      draft: { kind: "import", name: localName, qualifier: [], site: nodeSpan(node, lines) },
      name: nodeSpan(node, lines),
    });
  };
  const heritage = (node: Node, kind: "extends" | "implements") => {
    const visitType = (part: Node) => {
      if (TYPE_NODES.has(part.type)) {
        const name = lastName(part);
        const qualifier =
          qualified(part)?.qualifier ??
          (part.text.includes(".") ? part.text.split(".").slice(0, -1) : []);
        emit(kind, name, part, qualifier);
        return;
      }
      for (const child of part.namedChildren) visitType(child);
    };
    visitType(node);
  };
  const visit = (node: Node, owner = "", typeOwner = "") => {
    if (node.type === "package_declaration") return;
    if (node.type === "import_declaration") return importNode(node);
    const declarationKind = TYPE_DECLARATIONS.get(node.type);
    if (declarationKind) {
      const name = field(node, "name");
      if (!name) return;
      const path = owner ? `${owner}.${name.text}` : name.text;
      facts.symbols.push({
        path,
        kind: declarationKind,
        range: nodeSpan(node, lines),
        identifier: nodeSpan(name, lines),
        ...(owner && { parentPath: owner }),
      });
      for (const child of node.namedChildren) {
        if (child.type === "superclass" || child.type === "extends_interfaces")
          heritage(child, "extends");
        else if (child.type === "super_interfaces") heritage(child, "implements");
        else if (child !== name) visit(child, path, path);
      }
      return;
    }
    if (
      node.type === "method_declaration" ||
      node.type === "constructor_declaration" ||
      node.type === "compact_constructor_declaration"
    ) {
      const name = field(node, "name");
      if (!name || !typeOwner) return;
      const path = `${typeOwner}.${name.text}`;
      facts.symbols.push({
        path,
        kind: "method",
        range: nodeSpan(node, lines),
        identifier: nodeSpan(name, lines),
        parentPath: typeOwner,
      });
      parameters(field(node, "parameters"), path);
      if (node.type === "method_declaration")
        typeFact(path, name.text, "return", field(node, "type"));
      for (const child of node.namedChildren) if (child !== name) visit(child, path, typeOwner);
      return;
    }
    if (node.type === "field_declaration" && typeOwner) {
      const declaredType = field(node, "type");
      for (const child of node.namedChildren) {
        if (child.type !== "variable_declarator") continue;
        const name = field(child, "name");
        if (!name) continue;
        facts.symbols.push({
          path: `${typeOwner}.${name.text}`,
          kind: "variable",
          range: nodeSpan(node, lines),
          identifier: nodeSpan(name, lines),
          parentPath: typeOwner,
        });
        typeFact(typeOwner, name.text, "field", declaredType);
      }
    }
    if (node.type === "enum_constant" && typeOwner) {
      const name = field(node, "name");
      if (name)
        facts.symbols.push({
          path: `${typeOwner}.${name.text}`,
          kind: "variable",
          range: nodeSpan(node, lines),
          identifier: nodeSpan(name, lines),
          parentPath: typeOwner,
        });
    }
    if (node.type === "local_variable_declaration" && owner) {
      const declaredType = field(node, "type");
      for (const child of node.namedChildren) {
        if (child.type === "variable_declarator") {
          const name = field(child, "name");
          if (name) typeFact(owner, name.text, "local", declaredType);
        }
      }
    }
    if (node.type === "method_invocation") {
      const name = field(node, "name");
      const qualifier = receiver(field(node, "object"));
      if (name && qualifier) emit("call", name, node, qualifier);
    } else if (node.type === "object_creation_expression") {
      const type = field(node, "type");
      if (type) {
        const name = lastName(type);
        const qualifier =
          qualified(type)?.qualifier ??
          (type.text.includes(".") ? type.text.split(".").slice(0, -1) : []);
        emit("call", name, node, qualifier);
      }
    } else if (node.type === "field_access") {
      const member = field(node, "field");
      const qualifier = receiver(field(node, "object"));
      const left =
        node.parent?.type === "assignment_expression" ? field(node.parent, "left") : undefined;
      const assigned = left?.startIndex === node.startIndex && left?.endIndex === node.endIndex;
      if (member && qualifier)
        emit(assigned ? "write" : "read", member, assigned ? node.parent! : node, qualifier);
    } else if (node.type === "type_identifier" || node.type === "scoped_type_identifier") {
      const parent = node.parent;
      if (
        parent &&
        ![
          "object_creation_expression",
          "superclass",
          "super_interfaces",
          "extends_interfaces",
          "scoped_type_identifier",
        ].includes(parent.type)
      ) {
        const name = lastName(node);
        const qualifier =
          qualified(node)?.qualifier ??
          (node.text.includes(".") ? node.text.split(".").slice(0, -1) : []);
        emit("type-ref", name, node, qualifier);
      }
      if (node.type === "scoped_type_identifier") return;
    }
    for (const child of node.namedChildren) visit(child, owner, typeOwner);
  };
  visit(ctx.tree.rootNode);
  return { facts, located };
}

const packageCache = new WeakMap<RepoView, Map<string, string[]>>();

function declaredPackage(source: string | undefined): string | undefined {
  if (!source) return undefined;
  const visible = source.split("");
  const hide = (start: number, end: number) => {
    for (let at = start; at < end; at++) if (visible[at] !== "\n") visible[at] = " ";
  };
  for (let i = 0; i < source.length;) {
    const start = i;
    if (source.startsWith("//", i)) {
      i = source.indexOf("\n", i + 2);
      if (i < 0) i = source.length;
    } else if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
    } else if (source[i] === '"' || source[i] === "'") {
      const quote = source.startsWith('"""', i) ? '"""' : source[i]!;
      i += quote.length;
      while (i < source.length && !source.startsWith(quote, i)) {
        i += source[i] === "\\" ? 2 : 1;
      }
      i = Math.min(source.length, i + quote.length);
    } else {
      i++;
      continue;
    }
    hide(start, i);
  }
  const identifier = "[$_\\p{ID_Start}][$_\\p{ID_Continue}]*";
  const declaration = new RegExp(
    `\\bpackage\\s+(${identifier}(?:\\s*\\.\\s*${identifier})*)\\s*;`,
    "u",
  );
  return declaration.exec(visible.join(""))?.[1]?.replace(/\s+/g, "");
}

function packages(repo: RepoView): Map<string, string[]> {
  let mapping = packageCache.get(repo);
  if (mapping) return mapping;
  mapping = new Map();
  for (const path of repo.files) {
    if (!path.endsWith(".java")) continue;
    const source = repo.readText(path);
    const name = declaredPackage(source) ?? "";
    const files = mapping.get(name) ?? [];
    files.push(path);
    mapping.set(name, files);
  }
  for (const files of mapping.values()) files.sort();
  packageCache.set(repo, mapping);
  return mapping;
}

export const javaPack: LanguagePack = {
  id: "java",
  languages: ["java"],
  capabilities: { ...STRUCTURE_SUPPORT, ...HEURISTIC_SUPPORT },
  grammarFor(_language: FileLanguage): GrammarId {
    return "java";
  },
  packageScope: "named",
  packageName(file: string, repo: RepoView): string {
    return (
      declaredPackage(repo.readText(file)) ?? `@default/${file.slice(0, file.lastIndexOf("/"))}`
    );
  },
  refs: "heuristic",
  extract(ctx: FileContext): FileFacts {
    const result = extractJava(ctx);
    classificationCache.set(ctx.tree, result.located);
    return result.facts;
  },
  classifySite(ctx: FileContext, line: number, col: number): ClassifiedSite | undefined {
    let located = classificationCache.get(ctx.tree);
    if (!located) {
      located = extractJava(ctx).located;
      classificationCache.set(ctx.tree, located);
    }
    const match = located.find(({ name }) => spanContains(name, line, col));
    return match && { kind: match.draft.kind, site: match.draft.site };
  },
  resolveModule(spec: string, _fromFile: string, repo: RepoView): string[] {
    return packages(repo).get(spec) ?? [];
  },
};
