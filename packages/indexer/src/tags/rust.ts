/** Rust's corrected tags query. Bounded root-function calls are heuristic; no macro expansion is performed. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getWasmDir } from "../wasm-files.js";
import { TagsProvider } from "../tags.js";
import type { Node } from "web-tree-sitter";
import type { ProviderDeclaration, ProviderRelationship } from "../providers.js";
import { registerProvider } from "../providers.js";

registerProvider(
  new TagsProvider({
    id: "rust-tags",
    language: "rust",
    grammar: "rust",
    version: "tree-sitter-rust@0.24.0/query-v5",
    query: () =>
      readFileSync(
        getWasmDir()
          ? join(getWasmDir()!, "rust-tags.scm")
          : new URL("./rust.scm", import.meta.url),
        "utf8",
      ),
    kinds: { module: "other", macro: "other", impl: "other" },
    methodParents: ["impl", "interface"],
    label: (tag, name, context) =>
      tag === "impl"
        ? `impl ${context ? `${context} for ` : ""}${name}`.replace(/\s+/g, " ")
        : name,
    calls: {
      extract: directCalls,
      limitations: [
        "Heuristic calls cover only bare names between unambiguous root-level functions in the same file.",
        "Unknown, shadowed and qualified/generic calls, nested functions, closures, methods, trait dispatch and cross-module calls are not resolved.",
        "Function bodies containing macros or local imports are skipped; macro expansion and cfg evaluation are unavailable.",
      ],
    },
    limitations: [
      "Syntax tags omit macro-generated declarations, tuple positions and local bindings.",
      "Nesting is lexical: impl methods belong to impl blocks; external modules and receiver types are not linked.",
      "Declarations exclude leading attributes and documentation comments; conditional code is included without evaluating cfg.",
    ],
  }),
);

/** Resolve the bounded slice before provider normalization checks identities and source ranges. */
function directCalls(
  root: Node,
  file: string,
  declarations: readonly ProviderDeclaration[],
): ProviderRelationship[] {
  const functions = root.namedChildren.filter((node) => node.type === "function_item");
  const identities = new Map(
    declarations.map((declaration) => [declaration.identity, declaration]),
  );
  const identity = (node: Node) => `${file}:${node.startIndex}:${node.endIndex}`;
  const spelling = (name: string) => name.replace(/^r#/, "");
  const byName = new Map<string, Node[]>();
  for (const fn of functions) {
    const text = fn.childForFieldName("name")?.text;
    const name = text === undefined ? undefined : spelling(text);
    if (name) byName.set(name, [...(byName.get(name) ?? []), fn]);
  }
  const refs: ProviderRelationship[] = [];
  for (const fn of functions) {
    if (!identities.has(identity(fn))) continue;
    const shadowed = new Set<string>();
    let unsafe = false;
    const calls: Node[] = [];
    const names = (node: Node) => {
      if (node.type === "identifier" || node.type === "shorthand_field_identifier")
        shadowed.add(spelling(node.text));
      for (const child of node.namedChildren) names(child);
    };
    const visit = (node: Node) => {
      if (
        node !== fn &&
        [
          "function_item",
          "function_signature_item",
          "const_item",
          "static_item",
          "struct_item",
          "enum_item",
          "union_item",
          "type_item",
        ].includes(node.type)
      ) {
        const name = node.childForFieldName("name");
        if (name) shadowed.add(spelling(name.text));
        return;
      }
      if (node.type === "closure_expression") return;
      if (node.type === "macro_invocation" || node.type === "use_declaration") unsafe = true;
      const pattern = node.childForFieldName("pattern");
      if (pattern) names(pattern);
      if (node.type === "call_expression") calls.push(node);
      for (const child of node.namedChildren) visit(child);
    };
    visit(fn);
    if (unsafe) continue;
    for (const call of calls) {
      const callee = call.childForFieldName("function");
      if (callee?.type !== "identifier" || shadowed.has(spelling(callee.text))) continue;
      const targets = byName.get(spelling(callee.text));
      if (targets?.length !== 1 || !identities.has(identity(targets[0]!))) continue;
      refs.push({
        from: identity(fn),
        to: identity(targets[0]!),
        kind: "call",
        file,
        resolution: "heuristic",
        evidence: {
          start: [call.startPosition.row, call.startPosition.column],
          end: [call.endPosition.row, call.endPosition.column],
          encoding: "utf16",
        },
      });
    }
  }
  return refs;
}
