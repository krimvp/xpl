/** Standard @name/@definition.* captures become source-backed declarations, never resolved call edges. */
import { Query, type Node } from "web-tree-sitter";
import { RELATIONSHIP_CAPABILITIES, splitLines } from "@xpl/core";
import type { IndexedSymbol, FileLanguage, AnalysisReport } from "@xpl/core";
import { createParser, loadLanguage, type GrammarId } from "./wasm.js";
import { FileHasher } from "./hash.js";
import { findSyntaxErrors, significantSyntaxErrors, syntaxErrorWarning } from "./syntax-errors.js";
import type {
  IndexProvider,
  ProviderInput,
  ProviderOutput,
  ProviderRange,
  ProviderDeclaration,
} from "./providers.js";

interface TagsProfile {
  id: string;
  language: FileLanguage;
  grammar: GrammarId;
  version: string;
  query(): string;
  kinds: Readonly<Record<string, IndexedSymbol["kind"]>>;
  methodParents: readonly string[];
  label(tag: string, name: string, context?: string): string;
  limitations: string[];
}
const KINDS: Readonly<Record<string, IndexedSymbol["kind"]>> = {
  class: "class",
  interface: "interface",
  function: "function",
  method: "method",
  type: "type",
  enum: "enum",
  variable: "variable",
};
function range(node: Node): ProviderRange {
  return {
    start: [node.startPosition.row, node.startPosition.column],
    end: [node.endPosition.row, node.endPosition.column],
    encoding: "utf16",
  };
}

/** Reusable tagging adapter: profiles supply a query and labels, not a language resolver. */
export class TagsProvider implements IndexProvider {
  readonly mode = "syntax";
  readonly capabilities = {
    symbols: "partial",
    declarationRanges: "partial",
    nesting: "partial",
  } as const;
  readonly id: string;
  readonly languages: readonly FileLanguage[];
  constructor(private readonly profile: TagsProfile) {
    this.id = profile.id;
    this.languages = [profile.language];
  }
  async analyze(input: ProviderInput): Promise<ProviderOutput> {
    const parser = await createParser(this.profile.grammar);
    const declarations: ProviderDeclaration[] = [];
    const analysis = new Map<boolean, AnalysisReport>();
    const sourceHashes: Record<string, string> = {};
    let query: Query | undefined;
    try {
      query = new Query(await loadLanguage(this.profile.grammar), this.profile.query());
      for (const source of input.sources.filter(
        (s) => input.languages.includes(s.language) && this.languages.includes(s.language),
      )) {
        sourceHashes[source.path] = new FileHasher(splitLines(source.text)).hashFile();
        const tree = parser.parse(source.text);
        if (!tree) throw new Error(`${source.path}: parser returned no tree`);
        try {
          const tags = query
            .matches(tree.rootNode)
            .flatMap((match) => {
              const name = match.captures.find((c) => c.name === "name")?.node;
              const context = match.captures.find((c) => c.name === "context")?.node.text;
              if (!name) return [];
              return match.captures
                .filter((c) => c.name.startsWith("definition."))
                .map((c) => ({
                  node: c.node,
                  tag: c.name.slice("definition.".length),
                  name,
                  label: this.profile.label(c.name.slice("definition.".length), name.text, context),
                }));
            })
            .sort(
              (a, b) => a.node.startIndex - b.node.startIndex || b.node.endIndex - a.node.endIndex,
            );
          const stack: { end: number; declaration: ProviderDeclaration; tag: string }[] = [];
          const seen = new Set<number>();
          for (const tag of tags) {
            if (seen.has(tag.node.id)) continue;
            seen.add(tag.node.id);
            while (stack.length && stack.at(-1)!.end <= tag.node.startIndex) stack.pop();
            const parent = stack.at(-1);
            const kind = this.profile.kinds[tag.tag] ?? KINDS[tag.tag];
            if (!kind) continue;
            const declaration: ProviderDeclaration = {
              identity: `${source.path}:${tag.node.startIndex}:${tag.node.endIndex}`,
              file: source.path,
              name: tag.name.text,
              path: parent ? `${parent.declaration.path}.${tag.label}` : tag.label,
              kind:
                kind === "function" && parent && this.profile.methodParents.includes(parent.tag)
                  ? "method"
                  : kind,
              // A tag may name a multiline receiver type rather than one identifier.
              ...(tag.name.startPosition.row === tag.name.endPosition.row
                ? { identifier: range(tag.name) }
                : {}),
              declaration: range(tag.node),
              ...(parent ? { parent: parent.declaration.identity } : {}),
            };
            declarations.push(declaration);
            stack.push({ end: tag.node.endIndex, declaration, tag: tag.tag });
          }
          const errors = significantSyntaxErrors(source.path, findSyntaxErrors(tree.rootNode));
          if (errors) input.warn(syntaxErrorWarning([errors]));
          // All other outcomes are fixed by this profile; syntax recovery changes the limitations.
          const recovered = Boolean(errors);
          const report = analysis.get(recovered);
          if (report) {
            report.files.push(source.path);
            report.results[0]!.analyzedFiles.push(source.path);
            continue;
          }
          analysis.set(recovered, {
            provider: this.id,
            capabilities: this.capabilities,
            files: [source.path],
            results: [
              {
                capabilities: ["symbols", "declarationRanges", "nesting"],
                status: "partial",
                analyzedFiles: [source.path],
                limitations: [
                  ...this.profile.limitations,
                  ...(errors ? ["Syntax errors may leave declarations incomplete."] : []),
                ],
              },
              {
                capabilities: [...RELATIONSHIP_CAPABILITIES],
                status: "unsupported",
                analyzedFiles: [],
                limitations: [
                  "Relationship analysis is unavailable; syntax call sites are not resolved edges.",
                ],
              },
            ],
          });
        } finally {
          tree.delete();
        }
      }
    } finally {
      query?.delete();
      parser.delete();
    }
    return {
      provider: this.id,
      version: this.profile.version,
      configuration: "tags-query-v1",
      tool: this.profile.version,
      sourceHashes,
      declarations,
      relationships: [],
      analysis: [...analysis.values()],
    };
  }
}
