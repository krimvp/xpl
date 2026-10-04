# Java SCIP experiment

Java source uses the existing source-verified SCIP artifact importer. There is no Java `LanguagePack`,
syntax walker, new schema field or second importer. `.java` files remain `text`. Imported classes,
methods, fields and local declarations have checked names, full source ranges, hashes and canonical IDs.
`outline`, `show`, `refs`, `apply`, `validate` and `bundle` work with those IDs. The viewer uses its plain
text editor; selecting a symbol highlights its source and moving the caret finds its diagram elements.
Java syntax colouring, `search --code` classification and automatic Java service levels in `draft repo`
are outside this experiment. Use `search` without `--code` and explicit views.

This is issue #14 under #7. It measures an existing semantic producer without promising complete Java
analysis. All imported structural capabilities and type references are partial. Calls, reads, writes,
imports, inheritance and implementation relationships are unsupported for this producer's output.
The saved `analysis` report records omissions; file anchors remain available for discovered source files.

## Tool and source pins

The measured tools on Linux x86_64 are:

| Tool | Pin | SHA-256 of download |
|---|---|---|
| Temurin JDK, fixture | 21.0.8+9 | `f2dc5418092c43003db8f9005c4a286e1c0104fea96ccdd49e8ebd037cac9219` |
| Temurin JDK, Gson | 17.0.16+8 | `166774efcf0f722f2ee18eba0039de2d685b350ee14d7b69e6f83437dafd2af1` |
| Maven | 3.9.11 | `4b7195b6a4f5c81af4c0212677a32ee8143643401bc6e1e8412e6b06ea82beac` |
| scip-java launcher | release v0.13.1 | `a694cae143c32c5b6226362fb4bd268a8d13d3cd9b482819b3b0029a9a97b8fe` |

The launcher and artifact report `0.0.0-SNAPSHOT`. Pin its release URL and checksum; that version string
alone does not identify it. The producer source tag is `a609ba1adaf630292df5a73ec4ba06c170caba93`.
The fixture's source is committed at `45725f2e4aade1eb30b12000b5d0e7008e53bfa7`, with 13 Java files and
394 physical lines. Its POM targets Java 17 and pins maven-compiler-plugin 3.14.0.

The real repository is [Gson 2.11.0](https://github.com/google/gson/tree/828a97be0f8d58108b140b77df8dc76b657f4a87),
commit `828a97be0f8d58108b140b77df8dc76b657f4a87`. The measured build is `-pl gson -am`, main and test
compilation in the Gson module, excluding the optional proto, metrics, extras and native-image builds.
The checkout has 249 Java files / 53,021 physical lines. That module has 203 tracked Java files / 47,419
lines: 84 main files and 119 test files, including a source template and `module-info.java`.

## Repeat generation and import

From an xpl checkout with Node 22.12+, Python 3, curl, tar and git, build xpl and install the pinned tools
in scratch. Downloads and Maven's first build need network access. No system installation is needed.

```sh
npm ci --ignore-scripts
npm run build
xpl_cli="$PWD/packages/cli/dist/xpl.mjs"
java_work="$(mktemp -d /tmp/xpl-java-scip.XXXXXX)"
java_tools="$java_work/tools"
mkdir -p "$java_tools/jdk21" "$java_tools/jdk17" "$java_tools/maven" "$java_tools/bin"
curl -fL 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.8%2B9/OpenJDK21U-jdk_x64_linux_hotspot_21.0.8_9.tar.gz' -o "$java_tools/jdk21.tar.gz"
curl -fL 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.16%2B8/OpenJDK17U-jdk_x64_linux_hotspot_17.0.16_8.tar.gz' -o "$java_tools/jdk17.tar.gz"
curl -fL 'https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.11/apache-maven-3.9.11-bin.tar.gz' -o "$java_tools/maven.tar.gz"
curl -fL 'https://github.com/scip-code/scip-java/releases/download/v0.13.1/scip-java-v0.13.1' -o "$java_tools/bin/scip-java"
(cd "$java_tools" && sha256sum -c - <<'SUMS'
f2dc5418092c43003db8f9005c4a286e1c0104fea96ccdd49e8ebd037cac9219  jdk21.tar.gz
166774efcf0f722f2ee18eba0039de2d685b350ee14d7b69e6f83437dafd2af1  jdk17.tar.gz
4b7195b6a4f5c81af4c0212677a32ee8143643401bc6e1e8412e6b06ea82beac  maven.tar.gz
a694cae143c32c5b6226362fb4bd268a8d13d3cd9b482819b3b0029a9a97b8fe  bin/scip-java
SUMS
)
tar -xzf "$java_tools/jdk21.tar.gz" -C "$java_tools/jdk21" --strip-components=1
tar -xzf "$java_tools/jdk17.tar.gz" -C "$java_tools/jdk17" --strip-components=1
tar -xzf "$java_tools/maven.tar.gz" -C "$java_tools/maven" --strip-components=1
chmod +x "$java_tools/bin/scip-java"
export JAVA_HOME="$java_tools/jdk21"
export PATH="$JAVA_HOME/bin:$java_tools/maven/bin:$java_tools/bin:$PATH"
export MAVEN_OPTS="-Dmaven.repo.local=$java_tools/maven-cache"
cp -a fixtures/java-jobrunner "$java_work/fixture"
node_modules/.bin/tsx scripts/java-scip.ts "$java_work/fixture" "$java_work/fixture-run"
node "$xpl_cli" index --root "$java_work/fixture" --scip "$java_work/fixture-run/manifest.json" --precise require
node "$xpl_cli" outline --root "$java_work/fixture" --under src/main/java/jobrunner/Queue.java --depth 3
node "$xpl_cli" show --root "$java_work/fixture" 'src/main/java/jobrunner/Queue.java#Queue.push~2'
node "$xpl_cli" refs --root "$java_work/fixture" 'src/main/java/jobrunner/EchoHandler.java#EchoHandler' --out
(cd "$java_work/fixture" && java -cp target/classes:target/test-classes jobrunner.RetryTest)
(cd "$java_work/fixture" && java -cp target/classes jobrunner.Main)
```

`scripts/java-scip.ts ROOT FRESH_OUTPUT_DIR [-- MAVEN_ARGS...]` is a checkout helper, run with `tsx`.
It probes the JDK (`JAVA_HOME/bin/java` when available), Maven and scip-java, captures hashes of all
xpl-discovered sources/configuration before generation, runs the producer with a ten-minute timeout,
and verifies the same paths and hashes afterward. Its default Maven arguments are `--batch-mode clean
test-compile`. Arguments after `--` replace those defaults. It refuses an existing output directory or
one inside the indexed root. The parent output directory must exist.

Only a successful exit, stable source snapshot and nonempty fresh artifact create `manifest.json`.
Producer output goes to stderr; stdout prints the successful manifest path. The manifest binds artifact
bytes and pre-generation source hashes. `defaultEncoding: "utf16"` is verified for the pinned launcher;
this helper is for that producer pin, not an encoding guess for arbitrary versions. It is an author
attestation, not proof that every source compiled. Changes to dependencies or tools outside discovered
files, ignored/hidden configuration, and a file changed and restored during the run are not detected.
The importer independently checks every document against the current source and the artifact digest.

`scip-java index --output=/tmp/fresh/index.scip -- --batch-mode clean test-compile` is the underlying
producer command. The producer omits `Document.text` and `position_encoding`, so importing its raw
protobuf alone cannot establish source identity or columns. Use the helper's manifest with `--scip`.

After a first online build, repeat in a new output directory with `-- --batch-mode --offline clean
test-compile`. Maven plugins/dependencies must already be cached. Keep the same source root for generation
and import: a supplied SCIP `project_root` must match xpl's `--root`.

### Checked explainer and bundle

After the fixture import above, write a patch outside its root:

```sh
node "$xpl_cli" new java --root "$java_work/fixture"
cat > "$java_work/java.patch.json" <<'PATCH'
{
  "nodes": [
    {
      "id": "sym:src/main/java/jobrunner/Queue.java#Queue.push",
      "label": "Push with defaults",
      "summary": "Adds a job with no payload and priority zero through the three-argument overload.",
      "anchors": [{"file": "src/main/java/jobrunner/Queue.java", "symbol": "Queue.push", "role": "definition"}]
    },
    {
      "id": "sym:src/main/java/jobrunner/Queue.java#Queue.push~2",
      "label": "Push with priority",
      "summary": "Checks the queue limit, creates a job with its payload and priority, and adds it to the ready list.",
      "anchors": [{"file": "src/main/java/jobrunner/Queue.java", "symbol": "Queue.push~2", "role": "definition"}]
    }
  ],
  "views": [{
    "id": "view:java", "type": "graph", "title": "Queue overloads",
    "include": ["sym:src/main/java/jobrunner/Queue.java#Queue.push", "sym:src/main/java/jobrunner/Queue.java#Queue.push~2"]
  }]
}
PATCH
node "$xpl_cli" apply java "$java_work/java.patch.json" --root "$java_work/fixture"
node "$xpl_cli" anchors java 'sym:src/main/java/jobrunner/Queue.java#Queue.push~2' --root "$java_work/fixture"
node "$xpl_cli" validate java --root "$java_work/fixture"
node "$xpl_cli" bundle java --root "$java_work/fixture" -o "$java_work/java.html"
```

Open `java.html`, select each overload and expand Analysis coverage. The first highlights line 37;
the second highlights lines 38–43. Moving the caret to line 40 finds the second overload. These exact
selections and reverse lookup passed in pinned Chromium, with no browser errors. `validate` passed in
strict mode, and the bundle retained the imported source and the original capability report.

### Pinned real repository

Gson requires JDK 17 for this build: its enforcer rejects JDK 21. The explicit `jdk15` profile disables
Error Prone; without it the producer wrapper rejects `-XepExcludedPaths`. Release 8 avoids obsolete
release-7 warnings promoted to errors, and avoids compiling `module-info.java` in this configuration.
Test sources keep the POM's release 11. This is an indexing build, not a Gson release or test run.

```sh
git clone --branch gson-parent-2.11.0 --depth 1 https://github.com/google/gson.git "$java_work/gson"
git -C "$java_work/gson" checkout --detach 828a97be0f8d58108b140b77df8dc76b657f4a87
export JAVA_HOME="$java_tools/jdk17"
export PATH="$JAVA_HOME/bin:$PATH"
node_modules/.bin/tsx scripts/java-scip.ts "$java_work/gson" "$java_work/gson-run" -- \
  --batch-mode -Pjdk15 -pl gson -am -Dmaven.compiler.release=8 -DskipTests clean test-compile
node "$xpl_cli" index --root "$java_work/gson" --scip "$java_work/gson-run/manifest.json" --precise require
node "$xpl_cli" show --root "$java_work/gson" 'gson/src/main/java/com/google/gson/Gson.java#Gson.toJson~2'
# After the first success, a new run can add --offline to the Maven arguments.
```

## Literal source facts and limits

`packages/indexer/test/java-scip.test.ts` imports a recorded fixture artifact on every unit-test run,
without requiring Java tools or network. It uses the existing provider and normalizer, with independently
chosen IDs and line spans. The artifact's provenance and root removal are recorded beside the test data.

| Construct | Checked ID suffix | Full lines | Parent suffix |
|---|---|---:|---|
| Interface with annotation | `Handler.java#Handler` | 3–6 | none |
| Required method | `Handler.java#Handler.handle` | 5 | `Handler` |
| Static nested class | `Queue.java#Queue.Job` | 10–25 | `Queue` |
| First overload | `Queue.java#Queue.push` | 37 | `Queue` |
| Second overload | `Queue.java#Queue.push~2` | 38–43 | `Queue` |
| Non-static inner class | `Runner.java#Runner.Stats` | 8–15 | `Runner` |
| Cross-file method | `Worker.java#Worker.run` | 20–42 | `Worker` |

The producer encodes overloads as `push().` and `push(+1).`, not parameter types. xpl's source-ordered
`~N` suffixes keep the declarations distinct, but reordering overloads can change IDs. Descriptor
prefixes establish the checked nested parents even though global `enclosing_symbol` is empty.
Class kind does not distinguish static/inner or abstract classes. Abstract methods use kind 66.
Record declarations and unspecified kinds map to `other`; no Java syntax is guessed to fill the gaps.

`EchoHandler.java:3` has precise type references to BaseHandler at columns 40–50 and Handler at 63–69
(one-based, inclusive xpl positions). These are type mentions, not `extends`/`implements` edges.
Both implementations of Handler, BaseHandler and overrides supply SCIP implementation relationships.
The flags conflate class inheritance, interface implementation and method relationships, including
inverse method links. The importer diagnoses and omits them; it never guesses their direction.

All fixture occurrence roles are 0 or 1 (non-definition/definition), and syntax_kind is 0. The producer
supplies no call, read, write, import or generated-site classification. `Runner.java:44:35` targeting
`Queue.pop`, `Runner.java:51:33` targeting `Worker.run`, and `Metrics.java:17:79` targeting the method
reference `Metrics.onJobCompleted` are diagnosed as unclassified. Lambda parameters may be checked local
symbols; anonymous lambda expressions are not synthesized as named methods. No call graph is claimed.

Full enclosing ranges exist for 223 of 245 fixture definitions. The ten missing global ranges are
synthetic constructors; synthetic record parameters account for the other twelve omissions. No bodies
are invented. Ranges include the annotation on Handler but can omit leading Javadoc, such as RetryTest's.
Six used record accessor targets have occurrences without definition information: JobCompleted's
`durationMs`/`type`, DeadJob's `error`/`job`, and RunResult's `error`/`ok`. They remain unresolved.

All documents omit position_encoding. A producer run with an astral emoji before the Metrics callback
puts its name at zero-based column 100, versus codepoint column 99; this establishes UTF-16. Metadata's
UTF-8 source encoding is a separate field. The generic importer already strictly converts these columns.

Gson describes 202 documents: 82 tracked main sources, 119 tracked tests, and one generated
`gson/target/generated-sources/java-templates/com/google/gson/internal/GsonBuildConfig.java`.
The generated document is excluded by discovery even though the build creates it on disk. Its three
definitions never become source-backed declarations. The template and `module-info.java` are absent;
the unbuilt modules remain at file anchors. External JDK/library targets never create local declarations.

## Failure and coverage checks

The helper's process tests exercise missing JDK, Maven and scip-java, failed compilation, changed sources,
changed POM, added source, absent artifact, stale output reuse and output inside the source root.
Only successful generation creates a manifest. Failure exits 1, prints the tool/build reason, and names
`xpl index --precise off` as the fallback. This keeps Java file anchors and YAML config symbols, with
Java named-symbol and relationship analysis unsupported. It does not relabel failure as semantic success.

Real failure probes with the pinned tools confirm:

| Failure | Producer evidence | Result |
|---|---|---|
| No scip-java | `scip-java: command not found` | Install the pinned launcher; no manifest |
| No Java | `exec: java: not found` | Select a JDK in JAVA_HOME/PATH; no manifest |
| No Maven | `Cannot run program "mvn" ... error=2` | Put Maven on PATH; no manifest |
| Broken Java | `EchoHandler.java:[8] error: class, interface, enum, or record expected` | Fix the build; no manifest |
| Incomplete build | `clean compile` omits RetryTest, while `clean test-compile` includes it | File anchors remain; structural coverage partial |

The helper preflight makes the missing-tool diagnostics shorter than the producer's shell/Java stack
traces. A previous artifact can survive a failed command run manually; never attest or import it as a
successful new run. Fix the build and use a fresh directory. `--precise require` on import rejects an
artifact with no usable precise relationship analysis; `auto` retains file-only fallback on unusable
facts. A successful partial import is still partial, including absent source files and omitted full ranges.

## Measured coverage and cost

Measured sequentially on 2026-10-04, Node 22.23.1, Linux x86_64 under WSL2. Each corpus has one reported measured
run, with warmed Maven caches and `--offline clean test-compile`. Other workers ran on the host;
these are observations, not stable benchmarks. Installation, cloning and the first plugin download are
excluded. `/usr/bin/time -v` reports maximum process RSS in the command tree, not summed simultaneous RSS.

| Corpus | Java files | Physical lines | UTF-8 source bytes | Imported symbols | Edges | Build ms | Import process s | Import peak RSS KiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| java-jobrunner | 13 | 394 | 16,879 | 223 | 79 | 37.3 | 0.24 | 113,860 |
| Gson checkout at 828a97b | 249 | 53,021 | 1,824,890 | 10,474 | 7,184 | 564.6 | 0.85 | 276,692 |

Import is `buildIndex({ languages: ["text"], precise: "require", providers: [scipArtifactProvider(...)] })`.
Because Java stays `text`, discovery also captures three non-Java text files for the fixture and 44 for
Gson: 16 / 293 indexed files in total. Java-only physical counts above omit the final empty split after a
trailing newline, as in #13. Symbols and edges are all from Java documents. Gson's producer scope is the
203-file module above, not all 249 discovered Java files. Import wall/RSS includes tsx startup, artifact
read/decoding, discovery, checking, normalization, commit resolution, summary and index JSON output.
Build ms starts before provider construction/decoding and ends after `buildIndex` returns. The script
helper's generation phase below includes tool probes and the before/after source/config snapshot.

| Corpus | Generation s | Generation peak RSS KiB | Artifact bytes | Documents | Definitions | Full enclosing ranges | Imported |
|---|---:|---:|---:|---:|---:|---:|---:|
| java-jobrunner | 3.63 | 206,784 | 109,209 | 13 | 245 | 223 | 223 |
| Gson | 8.74 | 530,896 | 7,915,640 | 202 | 11,034 | 10,638 | 10,474 |

Definitions count occurrences with the definition bit, including document-scoped locals; repeated
`local 0` strings in different documents are distinct. These are producer-to-import mapping counts,
not independently measured compiler recall. No generated or external definitions are used as ground truth.

| Mapping loss/limit | Fixture | Gson |
|---|---:|---:|
| Definitions without valid full ranges | 22 | 396 |
| Unsupported descriptors/spellings | 0 | 161 |
| Definitions in undiscovered generated documents | 0 | 3 |
| Known-position unclassified occurrences | 430 | 25,564 |
| External, omitted or unresolved target occurrences | 411 | 29,411 |
| Parent diagnostics | 0 | 362 |
| Unknown kind mapped to `other` (retained) | 72 | 2,236 |
| Documents with omitted implementation flags | 8 | 119 |

Gson's 161 descriptor losses include type parameters and enum constants; unsupported descriptor suffixes
are omitted rather than mapped to invented declarations. Unknown-kind and parent diagnostics describe
retained declarations, not extra dropped symbol counts. The three generated definitions, 396 range
losses and 161 descriptor losses explain 11,034 − 10,474 = 560 omitted symbols.

To repeat the import measurement, write this as a scratch `.mts` file, replace the absolute xpl source
path, and run with `node_modules/.bin/tsx` under `/usr/bin/time -v`. Use separate processes sequentially
for fixture and Gson. The driver keeps registered syntax providers while replacing automatic semantic
tools, so it also works with #13's registry selection. Source counts come from discovered `.java` paths, using original UTF-8 bytes and
physical lines; do not count the generated `target/` output as source.

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { buildIndex, indexProviders, scipArtifactProvider } from "/absolute/xpl/packages/indexer/src/index.ts";
const [root, runDir, output] = process.argv.slice(2);
const artifact = readFileSync(runDir + "/index.scip");
const manifest = JSON.parse(readFileSync(runDir + "/manifest.json", "utf8"));
const start = performance.now();
const { index, warnings } = await buildIndex({ root: root!, languages: ["text"], precise: "require",
  providers: [...indexProviders().filter(p => "mode" in p && p.mode === "syntax"),
    scipArtifactProvider({ artifact, manifest, languages: ["text"] })] });
const ms = performance.now() - start;
writeFileSync(output!, JSON.stringify(index));
console.log(JSON.stringify({ ms, files: index.files.length, symbols: index.symbols.length,
  edges: index.refs.length, warnings }));
```

## Adapter effort and follow-ups

Java-specific workflow code is 83 lines in `scripts/java-scip.ts`, including comments and blank lines.
No production lines change in core, indexer, CLI or viewer. The existing generic artifact importer owns
mapping, source checks and diagnostics. The recorded artifact is 15,955 compressed bytes; acceptance tests
need no installed Java toolchain. Fixture compilation, RetryTest, the demo, CLI queries, strict validation
and a real browser bundle check ran. Gson tests were compiled but not executed. Only the Maven producer
path and Linux pins above were exercised; Gradle, other JDKs and other producer releases were not checked.

The [language-support decision](assessment-2026-10-04-language-support.md) compares these producer/import
phases with Rust tags and Rust SCIP on the same Rust sources. Java artifact import remains experimental;
the measured sources and Maven profile do not establish production maturity across Java builds. The decision
orders the next slices, including Java code identity and evidence-backed call classification. Those abilities
are not inferred from a successful build or a nonempty symbol count here.
