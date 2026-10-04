# SCIP, Kythe and Joern CPG through the provider contract, 2026-10-04

Issue #11, part of #6. Assessed against the provider contract of #10 (PR #41), and rerun on `main` at `f59f330`
after #41 and the SCIP importer of #12 (PR #43) merged; the numbers did not change. The question: can existing
code-graph formats feed xpl's `IndexProvider` without changing what an explainer means, and is a production
importer worth building?

**Decision, in short.**

- **The three formats are interchange formats only.** xpl keeps its own `SymbolIndex` as the stored form, and
  `normalizeProvider` as the only place where source checks, IDs, hashes and positions are decided. No Kythe
  serving tables, no Joern graph database, no format-specific storage.
- **No contract change is needed.** All three formats mapped through `ProviderOutput` as it is, and #12's SCIP
  importer (#43) landed on the same contract. Three rules every adapter must follow are now written down (§5).
  One trust-label bug was found in #41 and is fixed there (§5.1).
- **No production Kythe or CPG importer now.** Kythe gives the best Go facts of the three, but it only adds
  value where xpl has no SCIP tool, and its extraction setup is per language and build. CPG frontends differ too
  much, and gosrc2cpg skips whole statements. §6 says what would change this.

## 1. What was run

One fixture, three artifacts, one script. Everything is under
[assessment-2026-10-04-graph-formats/](assessment-2026-10-04-graph-formats/):

- `reproduce.sh <work-dir> <kythe-dir> <joern-cli-dir>`: copies `fixtures/go-jobrunner` (10 Go files, 158
  tree-sitter symbols, 424 heuristic references) and builds:
  - **SCIP**: `scip-go` v0.2.7 (`index.scip`, 11 documents);
  - **Kythe**: v0.0.76 release, `go_extractor` (GOPATH mode, one compilation per package, merged with
    `kzip merge`), `go_indexer --anchor_scopes`, `entrystream --write_format=json` (14,786 entries);
  - **CPG**: Joern v4.0.646, `gosrc2cpg --enable-file-content`, default overlays, exported by
    `export-cpg.sc` (types, methods, calls, imports, files).
- `assess.mts`: three throwaway adapters that turn each artifact into `ProviderOutput`, run through the real
  `buildIndex` → `normalizeProvider` → `mergeProvider`, and compare the result with the tree-sitter index:
  symbol IDs and lines, call pairs (caller → callee), reference kinds and trust labels, and the committed
  `jobrunner` explainer checked by `validateExplainer` against the merged index.
- `result.json`: the run recorded here. The whole pipeline takes about 30 s.

Each adapter runs in two modes:

- **raw**: map every fact the format has, and let `normalizeProvider` reject what it cannot check;
- **adapted**: what a careful adapter does next to a language pack (§5.2):
  - it does not send declarations without a full range;
  - when the pack has the same canonical ID, relationships to such a declaration use that ID;
  - it withdraws coverage, per file and capability, for whatever it could not map.

The TS fixture was also put through `jssrc2cpg`, only to compare position fields between CPG frontends.

## 2. Results

| | SCIP (scip-go) | Kythe (go_indexer) | CPG (gosrc2cpg) |
|---|---|---|---|
| Declarations with a full range, sent | 56 of 159 (functions, methods) | 80 of 170 (also types, interfaces) | 54 of 80 (no types) |
| Identifier extent | yes | yes | no |
| Source text in the artifact | no | yes (`/kythe/text`) | no (`FILE.content` empty, no hash) |
| Call relationships | none: one role for every reference | `ref/call`, 81 mapped | `CALL`, 62 of 264 resolved |
| **raw**: files merged | 1 of 10 | 0 of 10 (provider failed) | 1 of 10 |
| **adapted**: declarations placed by `normalizeProvider` | 54 (2 outside the root) | 80 | 54 |
| **adapted**: placed declarations with the pack's ID and lines | 54 of 54 | 79 of 80 | 54 of 54 |
| **adapted**: pack symbols kept in the merged index | 158 of 158 | 158 of 158 | 158 of 158 |
| **adapted**: explainer Go anchors served by the artifact | 5 of 5 | 5 of 5 | 5 of 5 |
| **adapted**: explainer errors | 0 | 0 | 0 |
| **adapted**: call pairs vs heuristic | not claimed | 66 shared, 2 new, 25 heuristic-only | not claimed (§3.3) |

The rows in detail:

- **IDs are stable across producers, with one exception.** The table compares each artifact's own placed
  declarations with the pack, not the merged index (which keeps the pack's symbols). 187 of the 188 placed
  declarations received the same canonical `<file>#<path>` ID as the tree-sitter pack, with the same lines, so
  the explainer's anchors keep their meaning whichever provider supplied the range.
  - The exception is Kythe's `internal/worker/worker.go#Worker.Run.outcome` (lines 55-58). It is a closure
    assigned to a local, which Kythe reports as a declaration with a full range. The Go pack does not make
    function-local closures symbols. Range-only merging updates existing nodes only, so this declaration is
    dropped without a diagnostic.
  - What counts as a symbol is xpl's policy, not the producer's. An adapter that wants a producer's extra
    declarations has to claim `symbols` for the file (§5.2, rule 2).
  - SCIP's 2 unplaced declarations (`init`, `main`) come from a document outside the repository root: the test
    `main` that Go generates in its build cache, which scip-go indexes. They are correctly not placed.
- **Raw mode loses almost everything** (§5.2). One unusable fact removes its file from all coverage.
  Declarations without a full range are unusable, and every relationship that points at one is dropped too.
- **Kythe agrees with the heuristic resolver** on 66 of its 68 call pairs. It adds 2 that the heuristic missed
  (`retry_test.go` tests → `Metrics.Completed`). Of the 25 heuristic-only pairs, 24 are composite literals
  (`Config{...}`, `&reader{...}`), which the Go pack records as a `call` to the type and Kythe as a reference to
  it. That is a semantic choice of the pack, not an error of either side. The last one is a call through a
  func-typed field (`Runner.logf`), which Kythe does not link to the field.
- **Staleness is caught.** The same Kythe artifact was run against a copy where `internal/queue/queue.go` gained
  one line. The file was rejected (`provider source snapshot is missing or stale`) and kept its 28 tree-sitter
  symbols. But 46 relationships from other files point into it, so only 4 of the 10 files kept relationship
  coverage. A stale file costs its dependents too.

## 3. Mapping per format

xpl's provider facts are declarations (identity, name, path, kind, parent, identifier range, full range) and
relationships (from, to, kind, evidence range, resolution), plus per-file, per-capability coverage.

### 3.1 SCIP

| xpl fact | SCIP source | Loss |
|---|---|---|
| declaration | `Occurrence` with the `Definition` role + `SymbolInformation.kind`, `display_name` | kind 35 (package) and 67 (type parameter) are not xpl symbols |
| full range | `Occurrence.enclosing_range` | scip-go sets it on 56 of 432 definitions: functions and methods only |
| parent / path | the symbol descriptor (`…/Queue#Push().` → `…/Queue#`) | `enclosing_symbol` is never set; descriptors are a naming scheme, not a nesting fact |
| call / read / write | `symbol_roles` | scip-go marks all 1,551 references `ReadAccess` (calls too): no call evidence without a syntax classifier |
| import | `Import` role | scip-go never sets it |
| implements | `Relationship.is_implementation` | symbol-level, no occurrence: evidence is the implementing type's identifier |
| source identity | `Document.text` (optional) | scip-go does not fill it, and SCIP has no content hash; producers that embed text are checkable |
| encoding | `Document.position_encoding` | scip-go leaves it `0` (unspecified): the adapter must know the tool |

The #41 SCIP adapters already handle relationships this way: occurrences plus the syntax classifier, so a
generic reference only becomes a call where the syntax shows an invocation. #12's importer (#43) implements the
declaration path above, with three differences from this assessment's mapping:
- it takes source evidence from `Document.text` or a manifest of pre-generation hashes;
- it reports calls as unsupported;
- it diagnoses and omits `is_implementation`, because the flag alone does not establish the direction.

The `implements` mapping here is the more permissive reading, and it matched the pack's 3 edges on this fixture.
How well other SCIP producers fill `enclosing_range` (Java, for example) belongs to their own slices (#14).

### 3.2 Kythe

| xpl fact | Kythe source | Loss |
|---|---|---|
| declaration | `defines/binding` anchor → semantic node (`function`, `record`, `interface`, `variable` subkind `field` or none) | locals and parameters (237) are not xpl symbols |
| identifier range | the binding anchor's `/kythe/loc/start`/`end` | none |
| full range | `defines` anchor | Go: none for variables, fields or interface methods (90 declarations) |
| parent / path | semantic `childof` (method → receiver, field → struct) | closures (`func run$1`) have no `childof`; scope comes from range containment |
| call | `ref/call` | none; 138 go to stdlib or locals (dropped as external) |
| write | `ref/writes` | none |
| read / type-ref | `ref` + the target's node kind (function, variable → read; record, interface → type-ref) | `ref` is generic: the adapter decides from the target kind, never "call" |
| import | `ref/imports` → `package` node | a Go package is a directory, xpl imports target one file's module scope: not mapped |
| implements | `satisfies` (node → node) | no anchor: evidence is the implementing type's identifier |
| not mapped | `typed`, `param.N`, `overrides`, `documents`, `ref/init` | type graph, override chains, docs: no xpl relationship |
| `from` | anchor `childof` scope (`--anchor_scopes`) | only with that indexer flag |
| source identity | file node `/kythe/text` = the text the indexer read | none: verifiable, as the stale run shows |
| encoding | byte offsets from file start | the adapter converts them to `[line, utf8 column]` |

### 3.3 Joern CPG

| xpl fact | CPG source | Loss |
|---|---|---|
| declaration | `METHOD`, `TYPE_DECL` (`isExternal = false`) | synthetic nodes (`<clinit>`, `<lambda>N`, file-level methods, `:program`, `<init>`) must be filtered by name |
| identifier range | none | no identifier extent on any node |
| full range | `METHOD` `LINE_NUMBER`…`COLUMN_NUMBER_END`; `OFFSET`/`OFFSET_END` where the frontend sets them | gosrc2cpg: `TYPE_DECL` has a start only; no offsets |
| parent / path | `AST_PARENT_FULL_NAME` | methods point at type declarations that have no range |
| call | `CALL` + `CALL` edge to the callee `METHOD` | gosrc2cpg drops `defer`, `go`, `select`, `send` statements (55 warnings across all 10 files); 202 of 264 calls unresolved (externals, interface dispatch) |
| evidence range | `CALL` start + `CODE` | no end position: rebuilt from `CODE` and kept only where the source spells it exactly (3 dropped) |
| extends / implements | `TYPE_DECL.inheritsFromTypeFullName` | one list for both: the two kinds cannot be told apart |
| read / write | `REF` edges from identifiers to locals, members, methods | not assessed: xpl has `read`/`write` relationships, but this export did not map them (§7) |
| data and control flow | `REACHING_DEF`, `CFG`, `CDG`, `DOMINATE` | not wanted (#11): xpl has no such facts, and they would not be added because an input carries them |
| source identity | `FILE.content`, `FILE.hash` | gosrc2cpg: both empty; jssrc2cpg: content present, hash empty |
| encoding | per frontend, undeclared | gosrc2cpg: 1-based byte columns; jssrc2cpg: 0-based columns plus offsets |

**gosrc2cpg cannot claim call coverage for any file here.** Every file has statements it skipped, so the
adapted mode withdraws `call` coverage everywhere. CPG then contributes only function ranges. When the same
facts claim call coverage anyway (`cpg-claims-all-calls`):

- raw mode merges 1 file;
- adapted mode replaces the heuristic calls of all 10 files. Unresolved `CALL` sites go to `blind`, which keeps
  the heuristic hint there, so 79 of 91 pairs survive. The 12 lost pairs are calls in skipped statements, or
  calls that CPG attributes to synthetic methods (closures, package-level initialisers), so they have no caller
  in xpl.

## 4. Interchange, storage and validation are three separate questions

- **Interchange.** SCIP, Kythe entries and CPG exports are inputs to an adapter, like `index.scip` is today.
  They map onto `ProviderOutput` with the losses above. None of them needs a new fact type in xpl.
- **Storage and query.** Not adopted. Kythe's serving tables, xrefs service and Joern's graph database answer
  questions xpl does not ask: cross-repository xrefs, type graphs, data flow. Explainer meaning lives in anchors
  and hashes over one commit. The index stays one JSON file that bundles can prune and pack. Keeping a second
  store in sync would add a second source of truth.
- **Source validation.** Format-independent, and owned by `normalizeProvider`: snapshot hashes, strict column
  conversion, identifier spelling and containment. Formats differ only in what proof of source they carry:
  - **Kythe** embeds the text it read, so an artifact can be checked long after it was made;
  - **SCIP** can embed source in `Document.text`; a document that does is checkable the same way. The assessed
    scip-go artifact does not, and SCIP has no hash field;
  - **scip-go** and **gosrc2cpg** artifacts therefore carry no proof of source. Their facts are fresh only in
    two cases:
    - xpl runs the tool over the captured snapshot itself, as the built-in SCIP adapters do;
    - the artifact comes with hashes made at generation time (#43's manifest).
    A stored artifact without either cannot supply checked anchors.
  - **jssrc2cpg** content makes a TS or JS CPG checkable.

## 5. Contract findings

### 5.1 Found and fixed in #41: the language trust label followed coverage, not resolution

At `e7d5e56`, `buildIndex` set `languages.<lang>.refs = "precise"` and the provider's tool name when a provider
had any usable relationship result. It never looked at the facts' `resolution`. In
`cpg-claims-all-calls/adapted`, every merged call was `heuristic`, yet `index.languages.go` said
`{ refs: "precise", tool: "joern@4.0.646" }`. That is exactly what #6 forbids ("the input format alone never
determines trust"). Review round 1 of #41 found the same defect.

The fix (`448fa1f`) adds `AnalysisResult.resolution`, and the adapters here now set it: `precise` for Kythe and
SCIP, `heuristic` for CPG. On the fixed branch, the same run labels Go `heuristic`. Every other number in this
record is unchanged by the fix.

### 5.2 Rules for adapters (documentation, not a contract change)

1. **Do not send what xpl will reject.**
   - One invalid fact removes its file from every capability of the report, and the removal cascades: drop a
     declaration, and the relationships pointing at it fail too.
   - Raw mode shows the cost. Kythe's 90 range-less declarations took 292 relationships with them, and Kythe
     ended with 0 of 10 files merged. SCIP's range-less types took its `implements` facts with them.
   - So an adapter filters before it sends. This rejection is conservative and right for trust, so it stays.
2. **Claim `symbols` for a file only with that file's complete symbol set.**
   - Structure replacement is per file and all-or-nothing. A provider that claims `symbols` and
     `declarationRanges` for a file replaces every pack symbol in it.
   - All three formats give full ranges for functions only (Kythe also for types). Claiming `symbols` deleted
     77 to 104 Go symbols per format in a first attempt: fields, types, interface methods.
   - Next to a language pack, claim `declarationRanges` (the range-only path updates the pack's nodes in place)
     and use pack IDs (`<file>#<path>`) as relationship endpoints, which the contract already allows.
   - Without a pack (#12) there is nothing to lose. There, report the missing ranges as capability limits.
3. **Never advertise a kind you do not map, and withdraw coverage where facts were dropped.**
   - Covered kinds replace earlier hints, even with an empty result. The first Kythe run advertised `import`,
     mapped none, and erased the pack's 17 imports.
   - Positions the tool saw but could not resolve go in `blind`, which keeps the heuristic hint there.

Two contract changes were considered and are **not recommended now**:

- **Per-kind symbol coverage** ("functions only"). Rule 2 covers the mixed case, and #12 has no pack to protect.
- **Per-capability rejection** (an unusable declaration costing only `symbols`, not `call`). Adapters can already
  do this themselves (`adapted` mode is about 60 lines, all format-independent). Move it into `normalizeProvider`
  if a second real adapter repeats it.

### 5.3 Notes for the language slices

At the assessed commit, two points stood out. #43 has since settled both:
- `FileLanguage` is a closed union in core. #43 indexes unknown extensions as `text`; a Java language identity
  belongs to #14.
- `buildIndex` runs semantic providers only when `precise` is not `off`. #43 makes `--precise off` together
  with `--scip` an error, instead of silently skipping the importer.

## 6. Recommendation on importers

- **SCIP: yes, now done in #12 (#43).** It is already the interchange format, tools exist for most languages,
  and full ranges are good where the tool sets `enclosing_range`. Kinds and descriptors give paths and parents.
- **Kythe: not now.** Its Go facts are the best of the three: call/write distinction, full ranges for types,
  embedded source text. But xpl already gets Go relationships from scip-go plus the classifier, and the Go
  extractor needs GOPATH mode and one compilation per package. Reconsider when a language has a Kythe indexer
  but no SCIP tool (C++ through `cxx_extractor` is the likely case). The adapter would then reuse §5.2 and the
  mapping in §3.2.
- **CPG: no.** Each frontend has its own positions, synthetic nodes and resolution quality, and none of it is
  declared in the graph. gosrc2cpg skips statements in every file here. What CPG offers beyond structure is data
  and control flow, which xpl deliberately does not model. Labelled as `heuristic`, as the frontends' own type
  recovery warrants, its calls are no better than the pack's.

## 7. Not checked

- **Non-ASCII columns.** The Go fixture is ASCII-only, so the column units (Kythe bytes, gosrc2cpg byte
  columns, scip-go unspecified) come from the formats' documentation and from observation on ASCII lines.
- **Kythe for other languages** (Java, TypeScript). Its TypeScript indexer is not in the release.
- **Real repositories.** Only the fixture was assessed; no timing or memory comparison.
- **CPG reads and writes** (`REF` edges), and Joern frontends other than `gosrc2cpg` and `jssrc2cpg`.
- **Overloads.** Go has none. #43 keeps overload identities distinct (ARCHITECTURE §3); Java evidence belongs to
  #14.
