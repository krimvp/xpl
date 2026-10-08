/** Ruby declarations through the syntax-only tags provider. Dynamic dispatch is not resolved. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getWasmDir } from "../wasm-files.js";
import { registerProvider } from "../providers.js";
import { TagsProvider } from "../tags.js";
import type { Node } from "web-tree-sitter";
import type { ProviderDeclaration } from "../providers.js";

function ownerParts(node: Node): { parts: string[]; rooted: boolean } | undefined {
  if (node.type === "constant") return { parts: [node.text], rooted: false };
  if (node.type !== "scope_resolution") return undefined;
  const name = node.childForFieldName("name");
  if (name?.type !== "constant") return undefined;
  const scope = node.childForFieldName("scope");
  if (!scope) return { parts: [name.text], rooted: true };
  const owner = ownerParts(scope);
  return owner && { parts: [...owner.parts, name.text], rooted: owner.rooted };
}

function rubyPath(
  tag: string,
  node: Node,
  lexicalParent: ProviderDeclaration | undefined,
  declarations: readonly ProviderDeclaration[],
): { path: string; parent?: string } | null | undefined {
  if (tag !== "variable" && tag !== "class" && tag !== "module") return undefined;
  const target = node.childForFieldName(tag === "variable" ? "left" : "name");
  if (target?.type !== "scope_resolution") return undefined;
  const name = target.childForFieldName("name");
  if (name?.type !== "constant") return null;
  const scope = target.childForFieldName("scope");
  if (!scope) return { path: name.text };
  const owner = scope && ownerParts(scope);
  if (!owner) return null;
  const suffix = owner.parts.join(".");
  const prefixes: string[] = [];
  if (!owner.rooted) {
    for (let path = lexicalParent?.path; path; path = path.slice(0, path.lastIndexOf("."))) {
      prefixes.push(`${path}.${suffix}`);
      if (!path.includes(".")) break;
    }
  }
  prefixes.push(suffix);
  for (const path of prefixes) {
    for (let i = declarations.length - 1; i >= 0; i--) {
      const found = declarations[i]!;
      if (found.path === path && (found.kind === "class" || found.kind === "other"))
        return {
          path: `${path}.${name.text}`,
          parent: found.identity,
        };
    }
  }
  return null;
}

registerProvider(
  new TagsProvider({
    id: "ruby-tags",
    language: "ruby",
    grammar: "ruby",
    version: "tree-sitter-ruby@0.23.1/query-v2",
    query: () =>
      readFileSync(
        getWasmDir()
          ? join(getWasmDir()!, "ruby-tags.scm")
          : new URL("./ruby.scm", import.meta.url),
        "utf8",
      ),
    kinds: { module: "other" },
    methodParents: [],
    label: (tag, name, context) => (tag === "method" && context ? `${context}.${name}` : name),
    resolve: rubyPath,
    limitations: [
      "Syntax tags cover named classes, modules, methods and constant assignments; scoped owners require a preceding same-file class or module declaration.",
      "Scoped owners are resolved from source declarations in this file only; cross-file namespaces and metaprogrammed declarations are unavailable.",
      "Declarations exclude leading comments and attributes; conditional code is included without execution.",
    ],
  }),
);
