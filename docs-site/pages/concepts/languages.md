# Languages and precision

xpl indexes TypeScript, JavaScript, Python, Go and Java with language packs. YAML, JSON and TOML keys are
symbols, so a code link can point at a configuration entry as it points at a function. A code link to any other
text file points at the whole file. Rust has experimental declarations, some heuristic calls inside a crate, and the `mod` and `use` imports within the package.
Ruby and PHP have named declarations and no references.

Tree-sitter WASM extracts symbols without installing language toolchains. References (calls, imports,
inheritance, type uses and reads) come from a SCIP indexer (a tool built on the language's own type checker)
when it can run, else from xpl's own resolver, which matches names within each scope. Each reference keeps
its label: **precise** (checked by a language tool) or **heuristic** (matched by name). The viewer draws
heuristic arrows dashed; the authoring skill treats them as hints to confirm.

Web requests are references too. A request with a literal or template path (`fetch`, axios, ky, got, `useSWR`,
Python `requests` and `httpx`, Go `net/http`) is linked to the handler of the route with the same method and
path, when the repository defines one (Express, Koa, Hono, Fastify, Next.js route files and `pages/api`,
FastAPI, Flask, net/http, chi, gin, echo; simple prefix mounts included). Parameters (`:id`, `{id}`,
`<int:id>`, `[id]`, `${id}`) match any segment, the query string is ignored, and a URL to a host other than a
local or example one is left out. These links are always heuristic: a proxy or another server can answer the
same path. Maps draw them as `requests` arrows.

`xpl index` prints one line per language. The line ends with how much you can trust its references:
`refs: precise` (with the tool's name), `refs: heuristic` or `refs: none`. A plain line under the table names
each language whose references are matched by name or whose symbols can be missing. `xpl index --verbose` also
lists, for each kind of symbol and reference, what was found and what is not supported. No reference found
does not mean there is none. Saved indexes and exports keep the analysed files, the limits and the failures;
an older index loads with its coverage marked unknown.

## Precise reference tools and artifacts

| Language                | Tool and requirements                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| TypeScript / JavaScript | `scip-typescript` 0.4.0 via `npx`; first use may need network access                                               |
| Python                  | `scip-python` 0.6.6 via `npx`; first use may need network access                                                   |
| Go                      | `scip-go` 0.2.7; Go 1.25 or a `go` that can download the toolchain                                                 |
| Java                    | `--scip` with a separately generated, source-checked artifact                                                      |
| Rust                    | Experimental declarations, bounded bare and receiver calls, and `mod`/`use` imports within the package (heuristic) |
| Ruby                    | Named classes, modules, methods and constants; no references                                                       |
| PHP                     | Named declarations; no references                                                                                  |
| YAML, JSON, TOML        | Keys are symbols; no references                                                                                    |

`xpl index` tries precise tools by default. Use `--precise off` for heuristic results or `--precise require`
to fail when a precise tool cannot run. `XPL_SCIP_TIMEOUT_MS` sets the per-tool timeout (default 10 minutes).
If a tool omits files, their heuristic references remain and the summary names the gap.

Java has no automatic SCIP resolver. Run a Java producer and its build separately, then pass the
source-checked artifact manifest with `--scip`. The importer uses only source-matched facts it supports;
the analysis report records omissions.

Precise indexing can be expensive on large repositories. In measured runs, Django took four minutes and 4.6
GB; SymPy and Prometheus took 9–10 minutes and up to 7 GB. `--precise off` took 15–40 seconds. Start large
repositories with heuristic indexing, then run precise analysis when the answer depends on language semantics
the heuristic may miss.

## Supplied SCIP artifacts and experimental languages

Import generated SCIP data with `xpl index --scip <artifact|manifest.json>`. Documents need embedded source or
a manifest tied to the hashes of the source before generation. Missing ranges, parents and call kinds are
reported as limits. A partial artifact keeps the tree-sitter symbols; an artifact without ranges cannot add
declarations.
Without checked targets, a standalone import reports `refs: none` and fails under `--precise require`. See the
[CLI reference](../reference/index.md) for artifact requirements.

Java, Rust, Ruby and PHP each have limits: forms of code that their pack does not read, or reads only by
name. The [CLI reference](../reference/index.md), under `xpl index`, lists them language by language, as the
skill reads them. Check them before you describe a path in one of these languages.

The [Rust tags notes](https://github.com/krimvp/xpl/blob/main/docs/rust-tags.md) and the
[language support assessment](https://github.com/krimvp/xpl/blob/main/docs/assessment-2026-10-04-language-support.md)
give measured limits. The dated
[Java SCIP experiment](https://github.com/krimvp/xpl/blob/main/docs/java-scip.md) predates the built-in Java
pack and records the optional artifact-import workflow.
