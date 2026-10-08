/** Ruby declarations through the syntax-only tags provider. Dynamic dispatch is not resolved. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getWasmDir } from "../wasm-files.js";
import { registerProvider } from "../providers.js";
import { TagsProvider } from "../tags.js";

registerProvider(
  new TagsProvider({
    id: "ruby-tags",
    language: "ruby",
    grammar: "ruby",
    version: "tree-sitter-ruby@0.23.1/query-v1",
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
    limitations: [
      "Syntax tags cover named classes, modules, methods and direct constant assignments; scoped and metaprogrammed declarations are unavailable.",
      "Nesting is lexical; scoped names do not establish a link to another file or namespace.",
      "Declarations exclude leading comments and attributes; conditional code is included without execution.",
    ],
  }),
);
