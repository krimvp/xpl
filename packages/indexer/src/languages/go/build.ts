/**
 * Is a Go file left out of a default build? A package often has several files that declare the same names, one
 * per build: `labels_stringlabels.go` / `labels_dedupelabels.go` behind `//go:build` tags, `mmap_unix.go` /
 * `mmap_js.go` by file name. The resolver takes the first file of a package that has a name, so it tries the
 * files of a default build first: linux/amd64 with cgo, the gc compiler, any `go1.N`, and no custom tags.
 *
 * Only the `//go:build` line is read (the old `// +build` lines go with one since Go 1.17), and only before the
 * `package` clause.
 */

const GOOS = new Set(
  "aix android darwin dragonfly freebsd hurd illumos ios js linux nacl netbsd openbsd plan9 solaris wasip1 windows zos".split(
    " ",
  ),
);
const GOARCH = new Set(
  "386 amd64 arm arm64 loong64 mips mips64 mips64le mipsle ppc64 ppc64le riscv64 s390x wasm".split(
    " ",
  ),
);
const DEFAULT_TAGS = new Set(["linux", "amd64", "unix", "gc", "cgo"]);

/** The file is built only for another system or architecture, or only with tags a default build does not set. */
export function offByDefault(path: string, text: string | undefined): boolean {
  if (!fileNameMatches(path)) return true;
  const expr = text === undefined ? undefined : buildLine(text);
  return expr !== undefined && !evaluate(expr);
}

/** `name_GOOS_GOARCH.go`, `name_GOOS.go`, `name_GOARCH.go` (`_test` stripped first). */
function fileNameMatches(path: string): boolean {
  const base = path
    .slice(path.lastIndexOf("/") + 1)
    .replace(/\.go$/, "")
    .replace(/_test$/, "");
  const parts = base.split("_");
  if (parts.length < 2) return true;
  const last = parts[parts.length - 1]!;
  const before = parts.length >= 3 ? parts[parts.length - 2]! : undefined;
  if (GOARCH.has(last)) {
    if (last !== "amd64") return false;
    return before === undefined || !GOOS.has(before) || before === "linux";
  }
  if (GOOS.has(last)) return last === "linux";
  return true;
}

function buildLine(text: string): string | undefined {
  for (const raw of text.split("\n", 200)) {
    const line = raw.trim();
    if (line.startsWith("//go:build ")) return line.slice("//go:build ".length);
    if (line.startsWith("package ")) return undefined;
  }
  return undefined;
}

/** A `//go:build` expression: `!`, `&&`, `||`, parentheses and tags. Unparsable: true (do not demote the file). */
function evaluate(expr: string): boolean {
  const tokens = expr.match(/\(|\)|!|&&|\|\||[\w.]+/g) ?? [];
  let at = 0;
  const tag = (t: string) => DEFAULT_TAGS.has(t) || /^go1\.\d+$/.test(t);
  const or = (): boolean => {
    let v = and();
    while (tokens[at] === "||") {
      at++;
      v = and() || v;
    }
    return v;
  };
  const and = (): boolean => {
    let v = not();
    while (tokens[at] === "&&") {
      at++;
      v = not() && v;
    }
    return v;
  };
  const not = (): boolean => {
    const t = tokens[at++];
    if (t === "!") return !not();
    if (t === "(") {
      const v = or();
      if (tokens[at++] !== ")") throw new Error("unbalanced");
      return v;
    }
    if (t === undefined || !/^[\w.]+$/.test(t)) throw new Error("unexpected token");
    return tag(t);
  };
  try {
    const v = or();
    return at === tokens.length ? v : true;
  } catch {
    return true;
  }
}
