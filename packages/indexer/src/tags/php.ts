/** PHP declarations through syntax tags. Unbraced namespaces span following top-level declarations. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getWasmDir } from "../wasm-files.js";
import { registerProvider } from "../providers.js";
import { TagsProvider } from "../tags.js";

registerProvider(
  new TagsProvider({
    id: "php-tags",
    language: "php",
    grammar: "php",
    version: "tree-sitter-php@0.24.2/query-v1",
    query: () =>
      readFileSync(
        getWasmDir() ? join(getWasmDir()!, "php-tags.scm") : new URL("./php.scm", import.meta.url),
        "utf8",
      ),
    kinds: { module: "other" },
    methodParents: [],
    label: (_tag, name) => name,
    scope: (tag, node, root) => {
      if (
        tag !== "module" ||
        node.type !== "namespace_definition" ||
        node.childForFieldName("body")
      )
        return undefined;
      const next = root.namedChildren.find(
        (child) => child.type === "namespace_definition" && child.startIndex > node.startIndex,
      );
      const endIndex = next?.startIndex ?? root.endIndex;
      const last =
        root.namedChildren
          .filter((child) => child.startIndex >= node.endIndex && child.endIndex <= endIndex)
          .at(-1) ?? node;
      return {
        endIndex,
        range: {
          start: [node.startPosition.row, node.startPosition.column],
          end: [last.endPosition.row, last.endPosition.column],
          encoding: "utf16" as const,
        },
      };
    },
    limitations: [
      "Syntax tags cover named namespaces, classes, interfaces, traits, functions, methods and constants; anonymous and generated declarations are unavailable.",
      "Namespace and member parents are lexical; imports, inheritance and dynamic calls are not resolved.",
      "Unbraced namespace ranges extend through following top-level declarations; mixed PHP/HTML and conditional code are indexed syntactically without execution.",
    ],
  }),
);
