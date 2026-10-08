/**
 * Registry of language packs. One pack per language family; `packFor(language)` maps an
 * `IndexedFile.language` to its pack (undefined for "text"), `packForFile(path, language)` also finds the pack
 * of a `text` file by its extension (`LanguagePack.extensions`, for a format that has no language of its own;
 * none does now). Other text files are indexed without symbols.
 */
import type { FileLanguage } from "@xpl/core";
import { goPack } from "./go.js";
import { javaPack } from "./java.js";
import { jsonPack } from "./json.js";
import { pythonPack } from "./python.js";
import { tomlPack } from "./toml.js";
import { typescriptPack } from "./typescript.js";
import type { LanguagePack } from "./types.js";
import { yamlPack } from "./yaml.js";

export type {
  ClassifiedSite,
  ExportFact,
  FileContext,
  FileFacts,
  ImportBinding,
  LanguagePack,
  RepoView,
  SiteDraft,
  SiteKind,
  Span,
  SymbolDraft,
  TypeFact,
} from "./types.js";

/** All registered packs. */
export const languagePacks: readonly LanguagePack[] = [
  typescriptPack,
  pythonPack,
  goPack,
  javaPack,
  yamlPack,
  jsonPack,
  tomlPack,
];

const byLanguage = new Map<FileLanguage, LanguagePack>();
const byExtension = new Map<string, LanguagePack>();
for (const pack of languagePacks) {
  for (const language of pack.languages) byLanguage.set(language, pack);
  for (const extension of pack.extensions ?? []) byExtension.set(extension, pack);
}

/** The pack that handles files of `language`, if any. */
export function packFor(language: FileLanguage): LanguagePack | undefined {
  return byLanguage.get(language);
}

/**
 * The pack that handles the file at `path` whose `IndexedFile.language` is `language`: `packFor(language)`,
 * or for a `text` file the pack that claims its extension.
 */
export function packForFile(path: string, language: FileLanguage): LanguagePack | undefined {
  const pack = byLanguage.get(language);
  if (pack || language !== "text") return pack;
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? undefined : byExtension.get(base.slice(dot).toLowerCase());
}

export { goPack, javaPack, jsonPack, pythonPack, tomlPack, typescriptPack, yamlPack };
