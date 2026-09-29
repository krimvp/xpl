/**
 * Registry of language packs. One pack per language family; `packFor(language)` maps an
 * `IndexedFile.language` to its pack (undefined for "text": those files are indexed without symbols).
 */
import type { FileLanguage } from "@xpl/core";
import { goPack } from "./go.js";
import { jsonPack } from "./json.js";
import { pythonPack } from "./python.js";
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
  yamlPack,
  jsonPack,
];

const byLanguage = new Map<FileLanguage, LanguagePack>();
for (const pack of languagePacks) {
  for (const language of pack.languages) byLanguage.set(language, pack);
}

/** The pack that handles files of `language`, if any. */
export function packFor(language: FileLanguage): LanguagePack | undefined {
  return byLanguage.get(language);
}

export { goPack, jsonPack, pythonPack, typescriptPack, yamlPack };
