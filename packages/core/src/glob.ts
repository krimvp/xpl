/**
 * A small glob matcher for repo-relative POSIX paths (`GraphView.excludeFiles`, test-file detection).
 *
 * - a double star matches any run of characters, slashes included; a double star followed by a slash, at the
 *   start of the pattern or after a slash, matches zero or more whole directories, so `<double star>/test/<double star>`
 *   matches `test/a.ts` and `pkg/test/deep/a.ts` but not `contest/a.ts`
 * - `*` matches any run of characters except `/`; `?` matches one character except `/`
 * - everything else is literal (no character classes, no braces, no negation)
 * - a pattern without a `/` also matches the file name at any depth: `*_test.go` matches `a/b/x_test.go`
 * - matching is case-sensitive and covers the whole path
 */

const cache = new Map<string, RegExp>();

/** The regular expression of a glob pattern (memoised). */
export function globToRegExp(pattern: string): RegExp {
  const known = cache.get(pattern);
  if (known) return known;
  let out = "";
  for (let i = 0; i < pattern.length;) {
    const ch = pattern[i]!;
    if (ch === "*") {
      let end = i;
      while (pattern[end] === "*") end++;
      if (end - i >= 2) {
        const atSegmentStart = i === 0 || pattern[i - 1] === "/";
        if (atSegmentStart && pattern[end] === "/") {
          out += "(?:.*/)?";
          i = end + 1;
        } else {
          out += ".*";
          i = end;
        }
      } else {
        out += "[^/]*";
        i = end;
      }
    } else if (ch === "?") {
      out += "[^/]";
      i++;
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  const regex = new RegExp(`^${out}$`);
  if (cache.size > 500) cache.clear();
  cache.set(pattern, regex);
  return regex;
}

/** Does `path` (repo-relative, POSIX) match the glob `pattern`? */
export function matchesGlob(path: string, pattern: string): boolean {
  if (pattern === "") return false;
  const regex = globToRegExp(pattern);
  if (regex.test(path)) return true;
  if (!pattern.includes("/")) return regex.test(path.slice(path.lastIndexOf("/") + 1));
  return false;
}

/** Does `path` match at least one of the patterns? */
export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

/** A predicate for a list of patterns (`undefined` when the list is empty or has no usable pattern). */
export function globMatcher(
  patterns: readonly unknown[] | undefined,
): ((path: string) => boolean) | undefined {
  const usable = (Array.isArray(patterns) ? patterns : []).filter(
    (p): p is string => typeof p === "string" && p !== "",
  );
  return usable.length === 0 ? undefined : (path) => matchesAnyGlob(path, usable);
}
