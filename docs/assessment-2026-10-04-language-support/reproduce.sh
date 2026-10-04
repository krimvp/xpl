#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
export OFFLINE=${OFFLINE:-1}
case "$OFFLINE" in 0|1) ;; *) echo "OFFLINE must be 0 or 1" >&2; exit 1;; esac

# Run from any directory. Keep all generated source, artifacts and logs outside xpl.
xpl_root=$(cd "$(dirname "$0")/../.." && pwd)
run=$(realpath -m "${1:?Usage: reproduce.sh FRESH_OUTPUT_DIRECTORY (see the report for tool/cache setup)}")
test ! -e "$run" || { echo "Use a fresh output directory" >&2; exit 1; }
case "$run/" in "$xpl_root/"*) echo "Keep output outside xpl" >&2; exit 1;; esac
mkdir -p "$run"
cd "$xpl_root"
driver="$xpl_root/docs/assessment-2026-10-04-language-support/measure.mts"
tsx="$xpl_root/node_modules/.bin/tsx"
cli="$xpl_root/packages/cli/dist/xpl.mjs"
test -f "$cli" || { echo "Run npm run build first" >&2; exit 1; }

: "${JDK21:?Set JDK21 to Temurin 21.0.8+9}"
: "${JDK17:?Set JDK17 to Temurin 17.0.16+8}"
rust-analyzer --version | tee "$run/rust-analyzer.version"
rustc --version | tee "$run/rustc.version"
cargo --version | tee "$run/cargo.version"
mvn --version > "$run/maven.version"
grep -q '0.3.2308-standalone' "$run/rust-analyzer.version"
grep -q '1.84.1' "$run/rustc.version"
grep -q '1.84.1' "$run/cargo.version"
grep -q '3.9.11' "$run/maven.version"
git rev-parse HEAD > "$run/xpl.commit"
node --version > "$run/node.version"
"$JDK21/bin/java" --version > "$run/jdk21.version"
"$JDK17/bin/java" --version > "$run/jdk17.version"
grep -q '21.0.8' "$run/jdk21.version"
grep -q '17.0.16' "$run/jdk17.version"
printf '%s  %s\n' \
  e7a85d27756b595be0054af90bd5f1e0420ef2e8c60782e42146bbe4765f7410 "$(command -v rust-analyzer)" \
  a694cae143c32c5b6226362fb4bd268a8d13d3cd9b482819b3b0029a9a97b8fe "$(command -v scip-java)" |
  sha256sum -c - > "$run/producer-checksums.log"

fixture_pin=d006ff67fe0f620442a1354b178280c690c9e193
for language in rs java; do
  mkdir "$run/$language-fixture"
  git archive "$fixture_pin" "fixtures/$language-jobrunner" |
    tar -x -C "$run/$language-fixture" --strip-components=2
done
git -c advice.detachedHead=false clone --quiet "${BAT_SOURCE:-https://github.com/sharkdp/bat.git}" "$run/bat"
git -C "$run/bat" checkout --quiet --detach 25f4f96ea3afb6fe44552f3b38ed8b1540ffa1b3
git -c advice.detachedHead=false clone --quiet "${GSON_SOURCE:-https://github.com/google/gson.git}" "$run/gson"
git -C "$run/gson" checkout --quiet --detach 828a97be0f8d58108b140b77df8dc76b657f4a87

# All phases use the same process wrapper, including tsx startup and writing output.
measure() {
  local label=$1
  shift
  /usr/bin/time -v -o "$run/$label.time" "$@" > "$run/$label.log" 2>&1
}
for corpus in rs-fixture bat; do
  export CARGO_TARGET_DIR="$run/$corpus-target"
  measure "$corpus-generate" "$tsx" "$driver" generate-rust "$run/$corpus" "$run/$corpus-scip"
  measure "$corpus-tags" "$tsx" "$driver" index "$run/$corpus" rust tags "$run/$corpus-tags"
  measure "$corpus-scip-only" "$tsx" "$driver" index "$run/$corpus" rust scip-only "$run/$corpus-scip-only" "$run/$corpus-scip"
  measure "$corpus-combined" "$tsx" "$driver" index "$run/$corpus" rust combined "$run/$corpus-combined" "$run/$corpus-scip"
done
offline_args=()
if [ "${OFFLINE:-1}" = 1 ]; then offline_args=(--offline); fi
export JAVA_HOME="$JDK21"
export PATH="$JAVA_HOME/bin:$PATH"
measure java-fixture-generate "$tsx" scripts/java-scip.ts "$run/java-fixture" "$run/java-fixture-scip" -- \
  --batch-mode "${offline_args[@]}" clean test-compile
measure java-fixture-import "$tsx" "$driver" index "$run/java-fixture" text scip-only "$run/java-fixture-import" "$run/java-fixture-scip"
export JAVA_HOME="$JDK17"
export PATH="$JAVA_HOME/bin:$PATH"
measure gson-generate "$tsx" scripts/java-scip.ts "$run/gson" "$run/gson-scip" -- \
  --batch-mode "${offline_args[@]}" -Pjdk15 -pl gson -am -Dmaven.compiler.release=8 -DskipTests clean test-compile
measure gson-import "$tsx" "$driver" index "$run/gson" text scip-only "$run/gson-import" "$run/gson-scip"

"$tsx" "$driver" facts "$run" > "$run/facts.log"
"$tsx" "$driver" workflow "$run" "$cli" > "$run/workflow.log" 2>&1
"$tsx" "$driver" results "$run"
printf 'Results, literal fact checks and CLI bundles: %s\n' "$run"
