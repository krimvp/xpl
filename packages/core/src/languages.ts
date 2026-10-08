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
