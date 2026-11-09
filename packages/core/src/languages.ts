import type { FileLanguage } from "./schema.js";

/** Code display names; undefined classifies config and other text. Every FileLanguage needs a decision. */
export const CODE_LANGUAGE_NAMES: Readonly<Record<FileLanguage, string | undefined>> = {
  typescript: "TypeScript",
  tsx: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  go: "Go",
  java: "Java",
  rust: "Rust",
  ruby: "Ruby",
  php: "PHP",
  yaml: undefined,
  json: undefined,
  toml: undefined,
  text: undefined,
};

export const CODE_LANGUAGES: ReadonlySet<string> = new Set(
  Object.entries(CODE_LANGUAGE_NAMES)
    .filter(([, name]) => name !== undefined)
    .map(([language]) => language),
);

/**
 * The reader's word for a symbol's kind where the index's kind is not the language's own word: a Go struct is
 * indexed as `class` and reads "struct"; a variable declared inside a type (`class`, `interface`) is a "field".
 * Undefined when the indexed kind is already the word. The index and the CSS keep the indexed kind.
 */
export function symbolKindWord(
  language: string | undefined,
  kind: string,
  parentKind: string | undefined,
): "struct" | "field" | undefined {
  if (kind === "class" && language === "go") return "struct";
  if (kind === "variable" && (parentKind === "class" || parentKind === "interface")) return "field";
  return undefined;
}
