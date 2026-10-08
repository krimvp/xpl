/** Rust syntax tags and bounded heuristic calls; no macro expansion or precise dispatch. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getWasmDir } from "../wasm-files.js";
import { TagsProvider } from "../tags.js";
import type { Node, Tree } from "web-tree-sitter";
import type { ProviderDeclaration, ProviderRelationship } from "../providers.js";
import { registerProvider } from "../providers.js";
import type { ProviderSource } from "../providers.js";
import { createParser } from "../wasm.js";

registerProvider(
  new TagsProvider({
    id: "rust-tags",
    language: "rust",
    grammar: "rust",
    version: "tree-sitter-rust@0.24.0/query-v6",
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
      resolveProject: receiverCalls,
      limitations: [
        "Heuristic calls cover unambiguous same-file root functions and statically identified receivers with explicit crate imports.",
        "Generic receiver calls point to a unique bound trait method; concrete implementation dispatch is not inferred from a generic type.",
        "Unknown, shadowed and ambiguous receivers, nested functions, closures, macros and cfg-dependent dispatch are not resolved.",
        "Bare-call analysis skips bodies containing macros or local imports; receiver calls inside macros are omitted.",
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

/** Resolve only receivers whose type and visible declaration are explicit in the source snapshot. */
async function receiverCalls(
  sources: readonly ProviderSource[],
  declarations: readonly ProviderDeclaration[],
  eligible: ReadonlySet<string>,
): Promise<ProviderRelationship[]> {
  type Method = { fact: ProviderDeclaration; owner: string; trait: boolean; returnType?: string };
  const methods: Method[] = [];
  const fields = new Map<string, Map<string, string>>();
  const ambiguousFields = new Set<string>();
  const calls: {
    file: string;
    from: string;
    node: Node;
    receiver: Node;
    name: string;
    owner: string;
    bounds: Map<string, string>;
    imports: Map<string, string>;
    locals: Map<string, string>;
  }[] = [];
  const trees: Tree[] = [];
  const parser = await createParser("rust");
  const byIdentity = new Map(declarations.map((fact) => [fact.identity, fact]));
  const identity = (file: string, node: Node) => `${file}:${node.startIndex}:${node.endIndex}`;
  const typeName = (text: string) => {
    const head = text
      .trim()
      .replace(/^[:&\s]*(?:mut\s+)?/, "")
      .split("<")[0];
    return head && /^[A-Z]\w*$/.test(head) ? head : undefined;
  };
  try {
    for (const source of sources.filter((s) => s.language === "rust" && eligible.has(s.path))) {
      const tree = parser.parse(source.text);
      if (!tree) continue;
      trees.push(tree);
      const file = source.path;
      const imports = new Map<string, string>();
      for (const use of tree.rootNode.namedChildren.filter(
        (node) => node.type === "use_declaration",
      )) {
        const match = use.text.match(/^use\s+crate::([\w:]+)::(\{[^}]+\}|[A-Z][\w]*)\s*;/);
        if (!match) continue;
        const modulePath = match[1]!.replaceAll("::", "/");
        const names = match[2]!.replace(/[{}\s]/g, "").split(",");
        const base = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
        for (const name of names) imports.set(name, `${base}${modulePath}.rs`);
      }
      const visit = (node: Node) => {
        if (node.type === "struct_item") {
          const owner = node.childForFieldName("name")?.text;
          if (owner) {
            const members = new Map<string, string>();
            const walk = (part: Node) => {
              if (part.type === "field_declaration") {
                const name = part.childForFieldName("name")?.text;
                const type = part.childForFieldName("type")?.text;
                if (name && type) members.set(name, type);
              }
              for (const child of part.namedChildren) walk(child);
            };
            walk(node);
            const key = `${file}#${owner}`;
            if (fields.has(key)) ambiguousFields.add(key);
            else fields.set(key, members);
          }
        }
        if (node.type === "impl_item" || node.type === "trait_item") {
          const trait = node.type === "trait_item";
          const owner = typeName(node.childForFieldName(trait ? "name" : "type")?.text ?? "");
          if (!owner) return;
          const bounds = new Map<string, string>();
          for (const parameter of node.childForFieldName("type_parameters")?.namedChildren ?? []) {
            const name = parameter.childForFieldName("name")?.text;
            const boundText = parameter.childForFieldName("bounds")?.text ?? "";
            const bound = boundText.includes("+") ? undefined : typeName(boundText);
            if (name && bound) bounds.set(name, bound);
          }
          for (const fn of node.namedChildren
            .flatMap((child) => child.namedChildren)
            .filter(
              (child) => child.type === "function_item" || child.type === "function_signature_item",
            )) {
            const fact = byIdentity.get(identity(file, fn));
            if (!fact) continue;
            methods.push({
              fact,
              owner,
              trait,
              returnType: typeName(fn.childForFieldName("return_type")?.text ?? ""),
            });
            if (fn.type !== "function_item") continue;
            const locals = new Map<string, string>();
            const tainted = new Set<string>();
            const taint = (part: Node) => {
              if (part.type === "identifier") tainted.add(part.text);
              for (const child of part.namedChildren) taint(child);
            };
            const findTainted = (part: Node) => {
              if (part.type === "assignment_expression") {
                const left = part.childForFieldName("left");
                if (left?.type === "identifier") tainted.add(left.text);
              }
              if (["let_condition", "match_arm", "for_expression"].includes(part.type)) {
                const pattern = part.childForFieldName("pattern");
                if (pattern) taint(pattern);
              }
              for (const child of part.namedChildren) findTainted(child);
            };
            findTainted(fn);
            const inFunction = (part: Node, locals: Map<string, string>) => {
              if (
                part !== fn &&
                (part.type === "function_item" ||
                  part.type === "closure_expression" ||
                  part.type === "macro_invocation")
              )
                return;
              if (part.type === "block") {
                const scope = new Map(locals);
                for (const child of part.namedChildren) inFunction(child, scope);
                return;
              }
              if (part.type === "let_declaration") {
                const value = part.childForFieldName("value");
                if (value) inFunction(value, locals);
                const name = part.childForFieldName("pattern")?.text;
                const declared = typeName(part.childForFieldName("type")?.text ?? "");
                if (name && declared && !tainted.has(name)) locals.set(name, declared);
                else if (name) {
                  locals.delete(name);
                  const callee =
                    value?.type === "call_expression"
                      ? value.childForFieldName("function")
                      : undefined;
                  const base =
                    callee?.type === "field_expression"
                      ? callee.childForFieldName("value")
                      : undefined;
                  const field =
                    base?.type === "field_expression" &&
                    base.childForFieldName("value")?.type === "self"
                      ? base.childForFieldName("field")?.text
                      : undefined;
                  const ownerType =
                    field &&
                    !ambiguousFields.has(`${file}#${owner}`) &&
                    fields.get(`${file}#${owner}`)?.get(field);
                  const method = callee?.childForFieldName("field")?.text;
                  if (ownerType && method && !tainted.has(name))
                    locals.set(name, `@${ownerType}.${method}`);
                }
                return;
              }
              if (part.type === "assignment_expression") {
                const left = part.childForFieldName("left");
                if (left?.type === "identifier") locals.delete(left.text);
              }
              if (part.type === "call_expression") {
                const callee = part.childForFieldName("function");
                if (callee?.type === "field_expression") {
                  const receiver = callee.childForFieldName("value");
                  const name = callee.childForFieldName("field")?.text;
                  if (receiver && name)
                    calls.push({
                      file,
                      from: fact.identity,
                      node: part,
                      receiver,
                      name,
                      owner,
                      bounds,
                      imports,
                      locals: new Map(locals),
                    });
                }
              }
              for (const child of part.namedChildren) inFunction(child, locals);
            };
            inFunction(fn, locals);
          }
          return;
        }
        for (const child of node.namedChildren) visit(child);
      };
      visit(tree.rootNode);
    }
    const refs: ProviderRelationship[] = [];
    for (const call of calls) {
      const receiver = call.receiver;
      let type: string | undefined;
      if (receiver.type === "self") type = call.owner;
      else if (receiver.type === "identifier") type = call.locals.get(receiver.text);
      else if (
        receiver.type === "field_expression" &&
        receiver.childForFieldName("value")?.type === "self"
      ) {
        const field = receiver.childForFieldName("field")?.text;
        type =
          field && !ambiguousFields.has(`${call.file}#${call.owner}`)
            ? fields.get(`${call.file}#${call.owner}`)?.get(field)
            : undefined;
      }
      if (!type) continue;
      let inferredFile: string | undefined;
      if (type.startsWith("@")) {
        const [owner, name] = type.slice(1).split(".");
        const targetFile = (owner && call.imports.get(owner)) ?? call.file;
        const providers = methods.filter(
          (method) =>
            method.fact.file === targetFile &&
            method.owner === owner &&
            method.fact.name === name &&
            !method.trait &&
            !method.fact.path?.includes(" for "),
        );
        type = providers.length === 1 ? providers[0]!.returnType : undefined;
        inferredFile = providers.length === 1 ? providers[0]!.fact.file : undefined;
        if (!type) continue;
      }
      const genericTrait = call.bounds.get(type);
      const targetType = genericTrait ?? typeName(type);
      if (!targetType) continue;
      const targetFile = inferredFile ?? call.imports.get(targetType) ?? call.file;
      const targets = methods.filter(
        (method) =>
          method.fact.file === targetFile &&
          method.owner === targetType &&
          method.fact.name === call.name &&
          (genericTrait ? method.trait : !method.trait && !method.fact.path?.includes(" for ")),
      );
      if (targets.length !== 1) continue;
      refs.push({
        from: call.from,
        to: targets[0]!.fact.identity,
        kind: "call",
        file: call.file,
        resolution: "heuristic",
        evidence: {
          start: [call.node.startPosition.row, call.node.startPosition.column],
          end: [call.node.endPosition.row, call.node.endPosition.column],
          encoding: "utf16",
        },
      });
    }
    return refs;
  } finally {
    for (const tree of trees) tree.delete();
    parser.delete();
  }
}
