/** Standard @name/@definition.* captures become source-backed declarations, with optional bounded call analysis. */
import { setImmediate } from "node:timers/promises";
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
  ProviderRelationship,
  ProviderSource,
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
  scope?(
    tag: string,
    node: Node,
    root: Node,
  ): { endIndex: number; range: ProviderRange } | undefined;
  limitations: string[];
  calls?: {
    extract(
      root: Node,
      file: string,
      declarations: readonly ProviderDeclaration[],
    ): ProviderRelationship[];
    limitations: string[];
    resolveProject?(
      sources: readonly ProviderSource[],
      declarations: readonly ProviderDeclaration[],
      eligible: ReadonlySet<string>,
    ): Promise<ProviderRelationship[]>;
  };
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

/** Reusable tagging adapter: profiles supply tags, labels and optional bounded file-local calls. */
export class TagsProvider implements IndexProvider {
  readonly mode = "syntax";
  get capabilities() {
    return {
      symbols: "partial",
      declarationRanges: "partial",
      nesting: "partial",
      ...(this.profile.calls ? { call: "partial" as const } : {}),
    } as const;
  }
  readonly id: string;
  readonly languages: readonly FileLanguage[];
  constructor(private readonly profile: TagsProfile) {
    this.id = profile.id;
    this.languages = [profile.language];
  }
  async analyze(input: ProviderInput): Promise<ProviderOutput> {
    let parser: Awaited<ReturnType<typeof createParser>> | undefined;
    const declarations: ProviderDeclaration[] = [];
    const relationships: ProviderRelationship[] = [];
    const analysis = new Map<boolean, AnalysisReport>();
    const sourceHashes: Record<string, string> = {};
    const eligible = new Set<string>();
    let query: Query | undefined;
    try {
      const queryText = this.profile.query();
      for (const source of input.sources.filter(
        (s) => input.languages.includes(s.language) && this.languages.includes(s.language),
      )) {
        if (input.signal) await setImmediate(undefined, { signal: input.signal });
        input.signal?.throwIfAborted();
        sourceHashes[source.path] = new FileHasher(splitLines(source.text)).hashFile();
        const extract = async () => {
          parser ??= await createParser(this.profile.grammar);
          query ??= new Query(await loadLanguage(this.profile.grammar), queryText);
          const declarations: ProviderDeclaration[] = [];
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
                    label: this.profile.label(
                      c.name.slice("definition.".length),
                      name.text,
                      context,
                    ),
                  }));
              })
              .sort(
                (a, b) =>
                  a.node.startIndex - b.node.startIndex || b.node.endIndex - a.node.endIndex,
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
              const scope = this.profile.scope?.(tag.tag, tag.node, tree.rootNode);
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
                declaration: scope?.range ?? range(tag.node),
                ...(parent ? { parent: parent.declaration.identity } : {}),
              };
              declarations.push(declaration);
              stack.push({ end: scope?.endIndex ?? tag.node.endIndex, declaration, tag: tag.tag });
            }
            const errors = significantSyntaxErrors(source.path, findSyntaxErrors(tree.rootNode));
            return {
              declarations,
              relationships: errors
                ? []
                : (this.profile.calls?.extract(tree.rootNode, source.path, declarations) ?? []),
              recovered: Boolean(errors),
              warning: errors ? syntaxErrorWarning([errors]) : undefined,
            };
          } finally {
            tree.delete();
          }
        };
        const result = input.extractionCache
          ? await input.extractionCache.extract(
              source,
              {
                provider: this.id,
                version: this.profile.version,
                grammar: this.profile.grammar,
                configuration: JSON.stringify({
                  queryText,
                  kinds: this.profile.kinds,
                  methodParents: this.profile.methodParents,
                  limitations: this.profile.limitations,
                  callLimitations: this.profile.calls?.limitations,
                }),
              },
              extract,
            )
          : await extract();
        declarations.push(...result.declarations);
        relationships.push(...result.relationships);
        if (!result.recovered) eligible.add(source.path);
        if (result.warning) input.warn(result.warning);
        // All other outcomes are fixed by this profile; syntax recovery changes the limitations.
        const recovered = result.recovered;
        const report = analysis.get(recovered);
        if (report) {
          report.files.push(source.path);
          for (const result of report.results) {
            if (result.status === "partial") result.analyzedFiles.push(source.path);
          }
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
                ...(recovered ? ["Syntax errors may leave declarations incomplete."] : []),
              ],
            },
            ...(this.profile.calls
              ? [
                  {
                    capabilities: ["call" as const],
                    status: recovered ? ("failed" as const) : ("partial" as const),
                    resolution: "heuristic" as const,
                    analyzedFiles: recovered ? [] : [source.path],
                    limitations: [
                      ...this.profile.calls.limitations,
                      ...(recovered
                        ? ["Syntax errors suppress direct call analysis in this file."]
                        : []),
                    ],
                  },
                ]
              : []),
            {
              capabilities: RELATIONSHIP_CAPABILITIES.filter(
                (kind) => !this.profile.calls || kind !== "call",
              ),
              status: "unsupported",
              analyzedFiles: [],
              limitations: ["These relationship kinds are unavailable in this syntax provider."],
            },
          ],
        });
      }
      if (this.profile.calls?.resolveProject)
        relationships.push(
          ...(await this.profile.calls.resolveProject(input.sources, declarations, eligible)),
        );
    } finally {
      query?.delete();
      parser?.delete();
    }
    return {
      provider: this.id,
      version: this.profile.version,
      configuration: "tags-query-v1",
      tool: this.profile.version,
      sourceHashes,
      declarations,
      relationships,
      analysis: [...analysis.values()],
    };
  }
}
