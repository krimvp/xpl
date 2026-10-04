# Recorded scip-java fixture

`index.scip.gz` contains the fixture's real v0.13.1 producer output, gzip-compressed with timestamp zero.
It was generated from the Java files at `45725f2e4aade1eb30b12000b5d0e7008e53bfa7` using Temurin
21.0.8+9, Maven 3.9.11, maven-compiler-plugin 3.14.0 and the scip-java v0.13.1 launcher. The launcher SHA-256
is `a694cae143c32c5b6226362fb4bd268a8d13d3cd9b482819b3b0029a9a97b8fe`; it reports `0.0.0-SNAPSHOT`.
See [the workflow](../../../../../docs/java-scip.md) for downloads and prerequisites.

The successful underlying command, in a fixture copy, was:

```sh
scip-java index --output=/absolute/scratch/fixture-run/index.scip -- --batch-mode --offline clean test-compile
```

The generation helper captured source hashes before that run and checked them afterward. `manifest.json`
retains the 13 Java source hashes, artifact digest and verified UTF-16 position default. Non-Java hashes
are excluded from this recorded test manifest because no producer documents reference those files.
Tests decompress the protobuf to memory and pass it to `scipArtifactProvider`; the CLI would first need
an uncompressed `index.scip` beside the manifest.

Only the absolute `Metadata.project_root` field was removed to make the recorded input portable to temp
fixture copies. Every document, occurrence, symbol, range, relationship and unknown field stays byte-for-byte
as supplied by scip-java. The rootless uncompressed artifact is 109,150 bytes with SHA-256
`8d1acff2e2040e65f338bc260c4f93fac019d55d09b1b11782acb8f620d38c57`. The original run was 109,209 bytes,
SHA-256 `53bc95403738c5ae87147242b4c23c50cd0643fa2d0a30cb5ff61277f8fe5fca`. Absolute roots affect that
original digest. No definitions or references were edited to satisfy the assertions.

To refresh, generate with `scripts/java-scip.ts` on a fixture copy as documented, then run this code through
`tsx` from the xpl checkout, setting `runDir` to its fresh output. Keep this transformation in scratch;
copy only the compressed artifact and manifest here. The existing reader/writer preserve unknown fields.

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { ProtoReader } from "/absolute/xpl/packages/indexer/src/scip/proto.ts";
import { Writer } from "/absolute/xpl/packages/indexer/test/scip-encode.ts";
const runDir = "/absolute/scratch/fixture-run";
const reader = new ProtoReader(readFileSync(runDir + "/index.scip"));
const output = new Writer();
while (!reader.done) {
  const start = reader.pos;
  const { field, wireType } = reader.readTag();
  if (field === 1) {
    const meta = reader.readMessage();
    const kept = new Writer();
    while (!meta.done) {
      const begin = meta.pos;
      const tag = meta.readTag();
      meta.skip(tag.wireType);
      if (tag.field !== 3) kept.raw(meta.buf.subarray(begin, meta.pos));
    }
    output.bytesField(1, kept.finish());
  } else {
    reader.skip(wireType);
    output.raw(reader.buf.subarray(start, reader.pos));
  }
}
const artifact = output.finish();
writeFileSync(runDir + "/index.scip.gz", gzipSync(artifact));
const manifest = JSON.parse(readFileSync(runDir + "/manifest.json", "utf8"));
manifest.artifactSha256 = createHash("sha256").update(artifact).digest("hex");
manifest.sourceHashes = Object.fromEntries(
  Object.entries(manifest.sourceHashes).filter(([path]) => path.endsWith(".java")),
);
writeFileSync(runDir + "/portable-manifest.json", JSON.stringify(manifest, null, 2) + "\n");
```
