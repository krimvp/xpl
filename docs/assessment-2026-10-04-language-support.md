# Language-support decision, 2026-10-04

Decision for [#15](https://github.com/krimvp/xpl/issues/15), closing the investigation in
[#7](https://github.com/krimvp/xpl/issues/7). Keep generic tags for structural outlines and use semantic
artifacts for source-checked enrichment. Neither producer alone supplies complete language support.
Keep Rust tags and Java SCIP import experimental; do not add a full Rust or Java resolver from these results.

The first implementation slice is safe composition of the two paths, tracked in
[#46](https://github.com/krimvp/xpl/issues/46). These measurements use xpl at
`d006ff67fe0f620442a1354b178280c690c9e193` and **predate that fix**. The range-less Rust artifact removes
valid syntax declarations and can pass `--precise require` without usable semantic targets. Until that is
fixed and measured, use `--precise off` for Rust. Java's explicit artifact workflow supplies useful checked
declarations and type mentions today, subject to its build and mapping limits below.

The evidence follows [Rust tags](rust-tags.md), [Java SCIP](java-scip.md), and the
[SCIP/Kythe/CPG assessment](assessment-2026-10-04-graph-formats.md). This change adds a decision and a runnable
measurement, with no production provider, schema, viewer or language-feature changes.

## 1. Inputs and measurement scope

Both fixtures come from xpl commit `d006ff67fe0f620442a1354b178280c690c9e193`. The runner extracts their
committed bytes with `git archive`; it never writes into `fixtures/`. Each real repository is cloned into
scratch and checked out at the full pin. Rust's three configurations use the **same root and artifact**.

| Corpus | Pin | Source files | Physical lines | UTF-8 snapshot bytes |
|---|---|---:|---:|---:|
| rs-jobrunner | xpl fixture pin above | 9 Rust | 825 | 24,408 |
| bat v0.25.0 | `25f4f96ea3afb6fe44552f3b38ed8b1540ffa1b3` | 67 Rust | 13,786 | 484,845 |
| java-jobrunner | xpl fixture pin above | 13 Java | 394 | 16,879 |
| Gson 2.11.0 | `828a97be0f8d58108b140b77df8dc76b657f4a87` | 249 Java | 53,021 | 1,824,890 |

Source counts include tests, samples, blank lines and comments. A final empty split after a trailing newline
is excluded from physical lines. Bytes measure decoded UTF-8 source snapshots, as xpl hashes them; bat's
ANSI-highlighted test output includes invalid bytes. These are discovery counts, not compiler coverage.

The import API restricts Rust to `languages: ["rust"]` and Java to `["text"]`, using the same `buildIndex`
boundary and source discovery. Java has no language identity yet: its index also contains three non-Java text
files in the fixture and 44 in Gson (16 and 293 files total). Those extra file anchors cost discovery/hash
work but supply no symbols. The tables count `.rs` and `.java` sources separately. CLI workflow checks index
all languages, including config, for both fixtures; their totals are not used in the timing tables.

Gson generation compiles the `gson` Maven module, main and tests, with `-pl gson -am`; it does not compile all
249 files. Its module contains 203 tracked Java files / 47,419 lines. The artifact describes 201 tracked
files plus one generated file, so 48 discovered Java sources have no artifact document: 46 outside the
selected build, the Java template and `module-info.java`. Source discovery still covers the whole checkout.
Rust generation describes 9/9 fixture files and 61/67 bat files. These denominators stay separate from
imported fact counts.

### Tools and phases

Tools are pinned on Linux x86_64 under WSL2, Node 22.23.1:

- Syntax: `web-tree-sitter@0.27.0`, `tree-sitter-rust@0.24.0`, xpl's corrected Rust tags query v1.
- Rust semantic: rust-analyzer release `2025-02-17`, source `84b6936e0856d0cac8d616c5ba3306155d8b3b1d`,
  binary `0.3.2308-standalone`; rustc/cargo 1.84.1, with `rust-src` installed. The uncompressed analyzer's
  SHA-256 is `e7a85d27756b595be0054af90bd5f1e0420ef2e8c60782e42146bbe4765f7410`.
- Java semantic: scip-java launcher v0.13.1, SHA-256
  `a694cae143c32c5b6226362fb4bd268a8d13d3cd9b482819b3b0029a9a97b8fe`; Maven 3.9.11;
  Temurin 21.0.8+9 for the fixture and 17.0.16+8 for Gson. Producer metadata says `0.0.0-SNAPSHOT`, so it
  cannot identify the launcher alone. Archive checksums and download URLs are in [java-scip.md](java-scip.md).

The runner executes these phases sequentially, in separate processes:

1. **Generation:** snapshot discovered source/config files, run the producer into a fresh external directory,
   verify unchanged snapshots and a nonempty artifact, then write the artifact digest and source manifest.
   Java reuses `scripts/java-scip.ts`; Rust uses the assessment driver. Neither stamps current hashes onto an
   old artifact. Rust documents explicitly declare UTF-8 columns; Java's verified UTF-16 default comes from
   the earlier Unicode probe, not from SCIP metadata's source-text encoding.
2. **Import/index:** load/decode the artifact when present, discover/capture source, parse syntax where used,
   normalize and merge provider facts, hash/resolve commit identity, and write index/summary/diagnostic JSON.
   Tags use `precise: "off"`; artifact-only and combined measurements use `"auto"` so a zero-result import
   can be observed. CLI `require` is probed separately. `buildMs` times only the `buildIndex` call.
3. **Usability:** literal fact assertions, CLI queries, checked anchors, strict validation and real fixture
   bundles. These checks, source counts, raw summaries and log processing are outside the timed API call.
   They run after the measured indexing phase.

Every process is wrapped by `/usr/bin/time -v`: elapsed time includes tsx startup and writing output; peak
RSS is the maximum reported in that command tree, not a sum of simultaneous child-process memory.
Installation, clone/download time and cache warming are excluded. Cargo/Maven dependencies are cached;
target directories are fresh. Rust runs with offline Cargo, build scripts overridden by `/bin/true`, and
proc macros disabled. This is a bounded no-build configuration, not Rust's full default semantic coverage.
Java runs `--offline clean test-compile`; Gson adds `-Pjdk15 -Dmaven.compiler.release=8 -DskipTests`.
That is an indexing build profile, not a Gson release build. Gson tests are compiled, not executed.

The committed [result.json](assessment-2026-10-04-language-support/result.json) records one completed run.
Earlier local reruns established the workflow, not an averaged benchmark. Other work ran on this shared
host; the timings do not establish a stable performance ranking between languages.

## 2. Manually verified facts

Expected facts were chosen by reading source declarations, bodies and reference expressions at the pins,
then checked against the saved indexes and raw artifacts. Tool agreement did not create the expectations.
Fixture links below identify the files; ranges are one-based inclusive source lines. The runnable `facts`
checks assert selected IDs, spans, parents and raw occurrences against literal values.

### Rust: the same language, two producers

| Expected fact, checked in source | Tags | rust-analyzer SCIP / xpl import |
|---|---|---|
| [queue.rs](../fixtures/rs-jobrunner/src/queue.rs):21–27 declares `JobQueue` with five required signatures at 22–26 | Trait and signatures are anchorable; `pop` parent is `JobQueue` | Semantic trait/signature identities exist, including `JobQueue#pop().` at `[21,7,10]`; no full ranges, so not imported |
| queue.rs:70–114 implements `JobQueue` for `Queue`; `pop` body is 71–87 | Method parent is physical `impl JobQueue for Queue`, not the separate struct | Method identity exists; neither roles nor symbol relationships establish an implementation edge here |
| [runner.rs](../fixtures/rs-jobrunner/src/runner.rs):40–102 is generic `impl<Q: JobQueue> Runner<Q>`; dispatch is 65–101 | `impl Runner<Q>.dispatch`, with the impl as lexical parent | Semantic method name exists; no body extent to anchor |
| [worker.rs](../fixtures/rs-jobrunner/src/worker.rs):102–110 nests `handlers` (103–109) in `demo`; echo is 106–108 | `demo.handlers.echo` is a function under `demo.handlers` | Distinct `worker/demo/handlers/echo().` name at `[105,15,19]`, not an anchorable declaration |
| [main.rs](../fixtures/rs-jobrunner/src/main.rs):10–16 has a different `demo::echo`, body 13–15 | Separate `src/main.rs#demo.echo` | Separate `demo/echo().` identity at `[12,11,15]` |
| runner.rs:12–21 defines `counters`; invocation at 22 expands `RunnerStats` with three fields | Actual macro definition and later physical impl are anchorable; no invented expanded struct or fields | `RunnerStats#` points at macro argument `[21,10,21]`; generated fields have information but no physical definition anchor |
| [bus.rs](../fixtures/rs-jobrunner/src/bus.rs):5 is `JOB_COMPLETED`; [config.rs](../fixtures/rs-jobrunner/src/config.rs):6 is `DEFAULT_CONFIG` | Checked const/static symbols | Corresponding semantic identities exist; no full ranges |
| bat `src/controller.rs`:28 is `impl<'b> Controller<'b>`; `run` at 38–44 calls `run_with_error_handler` at 43 | Full `impl Controller<'b>.run` range and lexical parent; no call edge | Name occurrences only; importer cannot retain the call or method body |
| bat `src/lessopen.rs`:1 gates the file on feature `lessopen`; physical `Preprocessed` struct at 242 | Source declarations included without evaluating cfg | No document under the measured profile; missing coverage, not a syntax-recall failure |

The bat sources are at [the pinned commit](https://github.com/sharkdp/bat/tree/25f4f96ea3afb6fe44552f3b38ed8b1540ffa1b3).
This is a same-language comparison on both the small fixture and a real repository. It establishes a
producer difference: semantic identities and macro knowledge do not imply usable declaration extents.
The old stock tags-query misses in prep were corrected by #13; they are not current Rust tags failures.

### Java: independently checked semantic-import facts

| Expected fact, checked in source | Imported result and limit |
|---|---|
| [Handler.java](../fixtures/java-jobrunner/src/main/java/jobrunner/Handler.java):3–6 includes `@FunctionalInterface`; required `handle` at 5 | Checked interface range 3–6; method parent `Handler`, range 5 |
| [Queue.java](../fixtures/java-jobrunner/src/main/java/jobrunner/Queue.java):10–25 is static nested `Job`; [Runner.java](../fixtures/java-jobrunner/src/main/java/jobrunner/Runner.java):8–15 is non-static inner `Stats` | Both ranges and parents survive; coarse `class` kind does not distinguish static/inner |
| Queue.java:37 delegates to the three-argument overload at 38–43 | Separate `Queue.push` / `Queue.push~2` bodies; source-ordered suffixes can change after reordering |
| [EchoHandler.java](../fixtures/java-jobrunner/src/main/java/jobrunner/EchoHandler.java):3 extends `BaseHandler` and implements `Handler` | Precise type mentions at columns 40–50 and 63–69; neither is an `extends`/`implements` graph edge |
| Runner.java:44 calls `queue.pop()` and 51 calls `worker.run(...)` | Raw targets identify `Queue#pop().` and `Worker#run().`; occurrences are unclassified and become no call edge |
| [Metrics.java](../fixtures/java-jobrunner/src/main/java/jobrunner/Metrics.java):17 passes `this::onJobCompleted` as a method value | Raw target is `Metrics#onJobCompleted().`; treating every method reference as a call would be wrong |
| Queue.java:27, [EventBus.java](../fixtures/java-jobrunner/src/main/java/jobrunner/EventBus.java):10 and [Worker.java](../fixtures/java-jobrunner/src/main/java/jobrunner/Worker.java):9 declare records with generated accessors | Record declarations remain `other`; six used accessor targets lack checked definitions and stay unresolved |
| Gson `gson/src/main/java/com/google/gson/Gson.java`:821–826 declares `toJson(Object)`; 846–850 declares `toJson(Object, Type)` | Checked `Gson.toJson` / `Gson.toJson~2` bodies and `Gson` parents; leading Javadoc at 806–820 is outside the first range |
| Gson `gson/src/main/java/com/google/gson/InstanceCreator.java`:80 declares `InstanceCreator<T>` | Interface is retained, but its type-parameter definition descriptor `[T]` is rejected by the generic descriptor mapping |

The Gson sources are at [the pinned commit](https://github.com/google/gson/tree/828a97be0f8d58108b140b77df8dc76b657f4a87).
Java's named-symbol and type-reference samples are useful, but they cannot establish Rust's missing-range
behavior as a language property. Java and Rust artifacts come from different producers and build profiles.
We did not run a second Java producer or claim a whole-repository accuracy score.

### Wrong facts, missing facts and mapping losses

No wrong retained source range or target was found in the selected literal samples. That narrow result is
not a claim that all imported facts are correct. Important defects and losses were observed:

- **Wrong observed outcome:** combined Rust import deletes all 82 fixture tags and 928 of bat's 968 tags.
  The 40 remaining bat tags belong to undescribed files. `--precise require` then exits 0 for the fixture
  and labels Rust `refs: precise` despite zero imported targets and edges. This is xpl's coverage/merge loss,
  not producer accuracy. The runnable workflow asserts the observed baseline, not desired future behavior.
- **Ambiguous producer facts:** rust-analyzer reports duplicate global symbols and internal errors about
  definitions missing from SCIP documents. There is one duplicate global identity in the fixture and ten in
  bat in this run. These are global identities, not document-local `local N` reuse. The producer's successful
  exit does not remove those warnings. No duplicate is resolved by guessing.
- **Rust extent loss:** all 315 fixture and 2,784 bat definition occurrences lack full enclosing ranges;
  all are omitted by standalone import. Tags omit fields, variants, locals and macro-generated declarations.
  No identifier-only range is substituted for a body. Lexical impl containment is not semantic receiver
  ownership; external `mod` declarations are not links to another file.
- **Rust source coverage:** the six absent bat documents are `assets/theme_preview.rs`, `src/lessopen.rs`,
  `tests/snapshots/sample.modified.rs`, `tests/snapshots/sample.rs`,
  `tests/syntax-tests/highlighted/Rust/output.rs`, and `tests/syntax-tests/source/Rust/output.rs`.
  Two syntax inputs are deliberately malformed or ANSI-highlighted samples and warn during tags parsing.
- **Java fixture extent loss:** 245 definitions yield 223 checked symbols. The 22 omitted definitions are
  ten synthetic constructors and twelve synthetic record parameters without full ranges. No body is invented.
  The six used record accessor targets without definitions remain unresolved. Unknown record/local kinds
  lose type detail by mapping to `other`; the full enclosing ranges can omit leading Javadoc.
- **Gson mapping loss:** 11,034 definitions yield 10,474 symbols: 396 missing/invalid full ranges, 161
  unsupported descriptor/name mappings, and three definitions in the excluded generated document. For
  example, `InstanceCreator<T>` has a real type parameter that the descriptor parser does not map.
  The generated `gson/target/generated-sources/java-templates/com/google/gson/internal/GsonBuildConfig.java`
  is excluded even though compilation creates it on disk. Parent evidence is also lost: 362 diagnostics
  report missing or non-containing enclosing parents. File anchors remain for uncompiled sources.
- **Relationship loss:** Java fixture sites include 430 unclassified references and 411 external, omitted
  or unresolved targets; Gson has 25,564 and 29,411 respectively. These are diagnostic site counts, not
  missed-call counts. Java's 16/1,362 raw symbol-relationship records are omitted because their flags mix
  inheritance, implementation and inverse override links without occurrence-level direction evidence.

Raw definition counts, retained counts, parser-node agreement, shared reference-site agreement and document
coverage are **not recall**. Some raw declarations are synthetic, generated or outside xpl's source model.
A recall claim would require an independently enumerated expected universe, including unseen facts; this
report has manually verified samples and explicit losses instead.

## 3. Observed capabilities and provenance

| Capability | Rust tags | Rust SCIP alone / combined at measured xpl pin | Java SCIP import |
|---|---|---|---|
| File anchors | Available for discovered source | Available, including undescribed source | Available, including uncompiled source |
| Named symbols / full ranges | Partial, physical syntax declarations | Alone: none. Combined: valid tags are lost in described files | Partial, 223 fixture / 10,474 Gson |
| Nesting | Lexical tag containment | Semantic descriptor data cannot provide missing full ranges; no retained semantic nesting | Partial; descriptors/enclosing symbols need checked same-file containment |
| Type mentions | Unsupported | No retained edges; partial coverage claim is misleading without placed targets | Partial; 79 fixture / 7,184 Gson, `resolution: precise` |
| Calls, reads, writes, imports | Unsupported | Unsupported by measured occurrence evidence | Unsupported by measured occurrence evidence |
| Extends / implements | Unsupported | No raw symbol relationships in these artifacts | Raw flags present but unsupported after mapping |
| Macro expansion / synthesized declarations | No expansion | Raw macro identities exist, but no checked expanded bodies | Synthetic members without physical full ranges omitted |
| Code search / repo drafts | Rust has code identity and service labels | Same identity; lost symbols reduce usefulness | Java stays `text`; use normal search and explicit views |
| Editor | Plain source, range selection/highlights | File anchors remain | Plain source, checked ranges/highlights |

Both semantic artifacts use only occurrence roles 0 and 1 here. Neither supplies enough evidence to classify
invocation, read, write or import merely from the target identity. The Java method-call and method-value
examples above make that distinction concrete. A precise semantic target does not make a guessed edge kind
precise. No call graph, recursion or transparent interface traversal is claimed for either experiment.

Provider provenance survives in the index: `rust-tags@tree-sitter-rust@0.24.0/query-v1` for syntax symbols,
`scip-artifact@1` for imported Java symbols/references, with the producer in the analysis report, artifact
digest/configuration and source snapshot identity. Tags have syntax provenance, not a compiler precision
label. Java type references have precise resolution, while coverage remains partial. The scip-java launcher's
pin must be recorded outside its uninformative `0.0.0-SNAPSHOT` tool-version string.

## 4. Failure and fallback behavior

Fresh runs in this assessment verify missing rust-analyzer and missing Maven: each helper exits 1 and writes
no manifest. The Java helper prints the file-anchor fallback instruction. The runner then executes actual
fallback indexing: Rust's `--precise off` restores its tags and validates the explainer; Java's fallback
retains 13 Java files and config symbols but zero Java symbols/edges. Reimporting its successful fresh
manifest restores the Java anchors and validates the same explainer. A build failure cannot authorize
importing a stale artifact left at an old path.

Additional failure evidence is inherited, not newly timed here:

- Rust prep's cold offline bat run crashed with signal 11 and no artifact. After dependency fetch, cached
  offline no-build generation succeeded (7.96 s / 622,372 KiB); default generation cost 36.43 s / 639,600 KiB.
  Setting only `buildScripts.enable: false` did not suppress all build activity; the no-build profile uses
  `overrideCommand: ["/bin/true"]`, disables proc macros and uses cached dependencies/rust-src. These prior
  numbers are from different runs and are not substituted into the matched table below.
- [Java's experiment](java-scip.md#failure-and-coverage-checks) exercised missing JDK, Maven and launcher,
  compilation errors, incomplete builds, changed source/configuration, output reuse and missing artifacts.
  Gson required JDK 17, the `jdk15` profile and library release 8. A normal JDK 21 build was rejected, and
  other profiles hit Error Prone/release/module errors. A successful Java build is not proof that all source
  files compiled; `clean compile` omits the fixture test that `clean test-compile` includes.

The snapshot manifest cannot detect changes to toolchains/dependencies outside discovered files, ignored
configuration or source changed and restored during a producer run. `OFFLINE=1` constrains Cargo/Maven
dependency resolution; it is not an OS-level network sandbox. Fresh source copies and explicit pins matter.

## 5. Matched costs and custom effort

Generation is separate from import for both semantic producers. Tags need neither compiler nor generated
artifact. The data below comes from the completed `run-3` and its committed result file, one selected run
per row on the shared host. Peak RSS is in KiB.

| Corpus / producer | Generation s | Generation peak RSS | Artifact bytes | Documents / discovered sources |
|---|---:|---:|---:|---:|
| rs-jobrunner / rust-analyzer, cached offline no-build | 3.73 | 380,556 | 176,290 | 9 / 9 |
| bat / rust-analyzer, same profile | 10.67 | 743,684 | 1,584,575 | 61 / 67 |
| java-jobrunner / scip-java, offline clean test-compile | 3.54 | 195,068 | 109,220 | 13 / 13 |
| Gson / scip-java, selected module/profile | 8.38 | 520,652 | 7,915,646 | 201 tracked + 1 generated / 249 |

| Corpus / import mode | `buildIndex` ms | Process s | Peak RSS | Retained symbols | Retained edges |
|---|---:|---:|---:|---:|---:|
| rs-jobrunner / tags | 46.4 | 0.22 | 121,560 | 82 | 0 |
| rs-jobrunner / SCIP only | 25.6 | 0.19 | 104,108 | 0 | 0 |
| rs-jobrunner / tags + SCIP | 56.5 | 0.23 | 122,040 | 0 | 0 |
| bat / tags | 250.2 | 0.41 | 133,264 | 968 | 0 |
| bat / SCIP only | 145.8 | 0.33 | 137,360 | 0 | 0 |
| bat / tags + SCIP | 302.0 | 0.50 | 150,680 | 40 | 0 |
| java-jobrunner / SCIP import | 32.8 | 0.20 | 106,340 | 223 | 79 type mentions |
| Gson / SCIP import | 452.8 | 0.79 | 281,388 | 10,474 | 7,184 type mentions |

Raw Rust information is 328 fixture / 2,888 bat symbol records and 1,717 / 17,338 occurrences. Earlier prep
recorded 324 / 2,891 and 1,144 / 12,690; these outputs are not assumed identical from matching source pins.
Producer project loading/build configuration and tool behavior are additional inputs. The decision depends
on the newly checked missing extents, source facts and merge outcomes, not on equal raw counts across runs.
Raw Java counts match the earlier experiment: 245 / 11,034 symbol records, 1,165 / 73,194 occurrences,
and 223 / 10,638 full-range definition occurrences. None is a language-normalized accuracy denominator.

Measured import costs are small relative to generation here, but zero retained facts make a cheap import
useless. The bat/Gson workloads differ in file count, source size, build profile and producer; their elapsed
times cannot prove that one language is intrinsically cheaper. More cold/warm repetitions and isolated
resource accounting would be needed for a performance budget.

Custom implementation effort from the merged experiments, counting source lines including blanks/comments:

| Path | Custom work | Reused work |
|---|---|---|
| Rust tags (#13) | 22 Rust query lines + 33 profile lines; 164-line generic tags adapter; language/WASM/query registration and plain editor integration | Provider normalization, IDs, hashes, coverage, anchors, queries, bundles |
| Java semantic import (#14) | 83-line generation/manifest helper; zero production changes in the four packages | Generic #12 artifact importer, full-range/identity checks, CLI and viewer |
| This decision (#15) | Assessment scripts, recorded measurements and support prose; zero production changes | Same provider/import boundary and Java helper |

The Java path's low adapter count shifts work into producer installation and repository-specific build
configuration; it is not zero integration effort. Rust tags required a small language query correction even
with a generic adapter. Adding a grammar or SCIP producer is therefore not sufficient proof of mature support.

## 6. Next slices, in order

1. **Preserve source declarations and distinguish examined coverage from replacement authority (#46).**
   The observed 82→0 and 968→40 losses make this the first slice. The current `analyzedFiles`/partial result
   allows a producer's filtered declaration inventory to replace a richer syntax inventory. Amend the
   provider contract: omitted or identifier-only definitions must not claim structural replacement; range
   enrichment should target existing canonical IDs where source evidence matches. Preserve valid zero-edge
   analysis when targets were actually checked, but a described file with no placeable target universe must
   not earn `refs: precise` or satisfy `require`. This initially needs stricter adapter/merge semantics and
   documentation, not a new core schema. Use the existing range-only path before adding a replacement-mode
   field. Re-run the three Rust configurations and stale/ambiguous-identifier cases after the fix.
2. **Give Java code identity without adding a resolver.** The checked overload bundle works, but `text`
   excludes Java from `search --code` and automatic Java service classification in repo drafts. Add the
   minimum extension/language classification through the existing shared code-language model, with its
   reader-facing capabilities preserved. Treat editor colouring as a separate presentation choice. This
   removes a visible workflow gap without inventing Java resolution or treating a semantic build as complete.
3. **Join semantic identities to physical syntax, then classify invocation explicitly.** Rust SCIP has
   useful trait/macro/module identities but no body ranges; tags have bodies but no targets. Join only a
   same-file, source-checked identifier match, rejecting ambiguity, duplicate globals and generated-only
   sites. Keep lexical nesting apart from semantic receiver/trait ownership. Java's `queue.pop()` and
   `this::onJobCompleted` show why calls need a syntax classifier beside semantic target evidence. Use the
   existing optional plain classifier/provider seam; do not infer calls from a callable kind or add a full
   language resolver. Measure selected cross-file calls and callback values independently before advertising
   call coverage. #46 may establish the first narrow identity join; call classification remains a later slice.
4. **Reduce demonstrated Java descriptor losses before expanding builds.** Gson's real type parameters
   expose 161 descriptor/name omissions. Extend the generic parser only with literal producer cases whose
   identifier and full-range evidence validate, and keep synthetic accessors/constructors unresolved when
   no physical definition exists. Record producer binary/configuration pins with the artifact manifest so
   `0.0.0-SNAPSHOT` is not the only visible producer version. Do not claim Gradle support or automatic build
   discovery from the Maven-only evidence.

Do not add Kythe or CPG importers, data/control-flow schema, blanket tags relationships, broad Rust/Java
scope resolvers, automatic build-profile guessing or synthetic full-body anchors in these slices. #11
already found format losses, and this comparison shows that the immediate problems are evidence and
composition within the existing provider boundary. Promote either experimental path only after further
independent source samples, build ecosystems and failure modes are checked; no blanket promotion is decided here.

**After #46 (PR pending):** the implementation worker reported the following separate measurements through
the orchestrator on 2026-10-04. They are provisional, not rerun in this worktree or included in the matched
timing/accuracy evidence above. They support the composition choice without establishing call coverage.

| Corpus | Tags symbols / precise refs | Artifact-only symbols / precise refs | Combined symbols / precise refs |
|---|---:|---:|---:|
| rs-jobrunner | 82 / 0 | 0 / 0 | 82 / 129 |
| pinned bat | 968 / 0 | 0 / 0 | 968 / 1,281 |

The worker reports that retained Rust ranges still come from tags and that standalone range-less import
now fails `require`. Review and merging of [#46](https://github.com/krimvp/xpl/issues/46) remain separate.
These counts do not establish the correctness of each added reference; manually verified relationships and
callback/call distinctions remain the next validation slice.

## 7. Reproduce and validation

The runnable sources are [reproduce.sh](assessment-2026-10-04-language-support/reproduce.sh) and
[measure.mts](assessment-2026-10-04-language-support/measure.mts). Run from this report's xpl version (the
measured implementation is d006ff6). The literal checks include baseline bugs and should fail if a later
provider change silently changes those observations; this is not a regression suite demanding those bugs.

Install the Java pins with the commands in [java-scip.md](java-scip.md#repeat-generation-and-import).
For Rust, download the `2025-02-17` Linux x86_64 rust-analyzer release, verify the binary checksum above, and
install Rust 1.84.1 with `rust-src` in a writable rustup/cargo home. The grammar is already pinned by npm.
Build xpl with `npm ci --ignore-scripts && npm run build`. On the prepared host, the exact environment is:

```sh
language_tools=/home/krimvp/workspace/xpl-wt/.tools
export JDK21="$language_tools/temurin-21.0.8+9"
export JDK17="$language_tools/temurin-17.0.16+8"
export JAVA_HOME="$JDK21"
export RUSTUP_HOME="$language_tools/rust-1.84.1/rustup"
export CARGO_HOME="$language_tools/rust-1.84.1/cargo"
export CARGO_BUILD_JOBS=2
export COURSIER_CACHE="$language_tools/scip-java-0.13.1/cache"
export MAVEN_OPTS="-Dmaven.repo.local=$language_tools/maven-3.9.11/repository"
export PATH="$language_tools/rust-analyzer-2025-02-17:$CARGO_HOME/bin:$JAVA_HOME/bin:$language_tools/maven-3.9.11/bin:$language_tools/scip-java-0.13.1:$PATH"
# Optional local clones avoid downloads; the runner clones them and checks the full pins.
export BAT_SOURCE=/home/krimvp/workspace/xpl-wt/.scratch-prep-13/repos/bat
export GSON_SOURCE=/home/krimvp/workspace/xpl-wt/.scratch-prep-14/repos/gson
docs/assessment-2026-10-04-language-support/reproduce.sh /home/krimvp/workspace/xpl-wt/.scratch-15/fresh-run
```

On another machine, use your writable tool paths; omitting `BAT_SOURCE`/`GSON_SOURCE` clones the upstream
repositories. A shallow xpl checkout must contain the fixture pin before `git archive` can work. Set
`OFFLINE=0` for the first successful generation to warm dependencies, then use a fresh output directory with
`OFFLINE=1` (the default) for the matched measurement. The runner refuses output reuse or output under xpl,
checks producer checksums/tool versions, and leaves artifacts, manifests, source copies, full diagnostic
logs, timing files, literal checks, two validated bundles and `result.json` under that external directory.
Its Rust command is `rust-analyzer scip ROOT --config-path CONFIG --output FRESH/index.scip`; the generated
config records the no-build profile. Java generation runs the existing helper with the exact arguments in §1.

Validation completed: the runnable assessment, both checked fixture bundles, `npm run typecheck`, `npm test`
(125 files passed, 1 skipped; 2,351 tests passed, 20 opt-in tests skipped), and real `npm run test:e2e`
(241 passed). The assessment driver also typechecks separately because `docs/` is outside package tsconfigs.
The test-audit gate found no production or unit-test changes. The new runnable assertions protect literal
source claims: a wrong range, parent or semantic target fails them. Existing unit fixtures cover imported
records, but do not run these live pinned producers or check the selected bat/Gson source facts. The driver
uses existing public APIs and the real CLI, with no test-only export. Negative missing-tool probes assert
the error and absent manifest; fallback checks assert retained files plus absent Java symbols/edges.
Existing fixture, artifact, CLI, bundle and self-explainer tests remain the owning seams. A scratch mutation
of dispatch's retained range fails its literal check. No production fix or new regression test is claimed.
The first draft's Gson line constant was corrected by rereading the numbered source; an initial
expected Rust `require` failure exposed the observed false success instead of being weakened as a test.

Not checked: whole-repository precision/recall, second Java producer, full/default Rust builds in this
matched run, proc-macro-dependent coverage, uncached generation, other platforms/tool releases, Gradle,
Gson runtime tests, semantic call/inheritance graphs, or post-#46 behavior. The existing e2e suite exercises
Rust and Java browser bundles; this assessment adds no viewer behavior. Screenshots are not needed for the
documentation/assessment-only change, as determined by `scripts/needs-screenshots.sh origin/main`.
