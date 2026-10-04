/** Rust's corrected tags query. No scope resolution or macro expansion is performed. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getWasmDir } from "../wasm-files.js";
import { TagsProvider } from "../tags.js";
import { registerProvider } from "../providers.js";

registerProvider(
  new TagsProvider({
    id: "rust-tags",
    language: "rust",
    grammar: "rust",
    version: "tree-sitter-rust@0.24.0/query-v1",
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
    limitations: [
      "Syntax tags omit macro-generated declarations, fields, enum variants and local bindings.",
      "Nesting is lexical: impl methods belong to impl blocks; external modules and receiver types are not linked.",
      "Declarations exclude leading attributes and documentation comments; conditional code is included without evaluating cfg.",
    ],
  }),
);
