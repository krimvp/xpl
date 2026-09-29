/**
 * `resolveModule` for Python: dotted module names to repository files.
 *
 * Absolute `a.b.c` is looked up as `a/b/c.py` / `a/b/c/__init__.py` (plus `.pyi` stubs) under a list of
 * source roots, the first root that has it wins:
 *
 * 1. the repository root and `src/` (src layout);
 * 2. the directories above the importing file (and their `src/`) that are not packages: Python puts the
 *    directory of a script (and pytest the rootdir of a test) on `sys.path`, so `tests/test_a.py` can
 *    `import helpers` from `tests/helpers.py`. Package directories are skipped: `pkg/queue.py` does not
 *    make `import queue` mean the module next to it;
 * 3. every directory that directly contains a top-level package (`D/pkg/__init__.py`, D not a package
 *    itself), nearest to the importing file first: monorepos with several projects;
 * 4. namespace packages (no `__init__.py`) in any other directory: a dotted name of two or more parts
 *    that ends a repository path (`a.b` -> `libs/x/a/b.py`), the match nearest to the importing file. Not
 *    for names that start like a standard library module (`logging.handlers` is not `myapp/logging/
 *    handlers.py`).
 *
 * Relative specs (`.x`, `..pkg.y`, `.`) start at the directory of the importing file and go up one
 * directory per extra dot; `.` alone is the package itself (`__init__.py`). Anything else - the standard
 * library, third-party packages, names that leave the repository - resolves to nothing.
 *
 * Namespace packages need no `__init__.py`: only the module file has to exist.
 */
import type { FilePath } from "@xpl/core";
import type { RepoView } from "../types.js";
import { DOTTED_NAME } from "./ast.js";

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function join(dir: string, rest: string): string {
  if (dir === "") return rest;
  return rest === "" ? dir : `${dir}/${rest}`;
}

/**
 * The files that are the module at `base` (`a/b/c`): package, module, then stubs. `""` is the root package.
 * Never `from` itself: a module does not import itself (`from abc import ABC` in an `abc.py` at the root, or
 * `from dbm import ndbm` in `dbm/__init__.py`, name something else), and a binding that resolved to its own
 * file would have the resolver looking that name up in that file, again and again.
 */
function probe(base: string, repo: RepoView, from: FilePath): FilePath[] {
  const candidates =
    base === ""
      ? ["__init__.py", "__init__.pyi"]
      : [`${base}/__init__.py`, `${base}.py`, `${base}/__init__.pyi`, `${base}.pyi`];
  return candidates.filter((c) => c !== from && repo.files.has(c));
}

function isPackageDir(dir: string, repo: RepoView): boolean {
  return dir === ""
    ? repo.files.has("__init__.py") || repo.files.has("__init__.pyi")
    : repo.files.has(`${dir}/__init__.py`) || repo.files.has(`${dir}/__init__.pyi`);
}

const sourceRootCache = new WeakMap<RepoView, readonly string[]>();

/** Directories that directly contain a top-level package (a package whose parent is not a package). */
function sourceRoots(repo: RepoView): readonly string[] {
  let roots = sourceRootCache.get(repo);
  if (roots) return roots;
  const found = new Set<string>();
  for (const file of repo.files) {
    if (!/(^|\/)__init__\.pyi?$/.test(file)) continue;
    const pkg = dirOf(file);
    if (pkg === "") continue; // the repository root is itself a package: nothing above it
    const parent = dirOf(pkg);
    if (!isPackageDir(parent, repo)) found.add(parent);
  }
  roots = [...found].sort();
  sourceRootCache.set(repo, roots);
  return roots;
}

/** Number of leading path segments two directories share. */
function sharedSegments(a: string, b: string): number {
  const as = a === "" ? [] : a.split("/");
  const bs = b === "" ? [] : b.split("/");
  let n = 0;
  while (n < as.length && n < bs.length && as[n] === bs[n]) n++;
  return n;
}

/** Top-level names of the standard library (Python 3.11, public ones): never resolved by path suffix. */
const STDLIB = new Set(
  `abc aifc antigravity argparse array ast asynchat asyncio asyncore atexit audioop base64 bdb binascii bisect
builtins bz2 cProfile calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall
concurrent configparser contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses datetime dbm
decimal difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp
fileinput fnmatch fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib grp gzip
hashlib heapq hmac html http idlelib imaplib imghdr imp importlib inspect io ipaddress itertools json keyword
lib2to3 linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt
multiprocessing netrc nis nntplib nt ntpath nturl2path numbers opcode operator optparse os ossaudiodev
pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath pprint profile pstats
pty pwd py_compile pyclbr pydoc pydoc_data pyexpat queue quopri random re readline reprlib resource
rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket
socketserver spwd sqlite3 sre_compile sre_constants sre_parse ssl stat statistics string stringprep struct
subprocess sunau symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios textwrap this
threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle turtledemo types
typing unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser winreg winsound wsgiref
xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo`.split(/\s+/),
);

const suffixCache = new WeakMap<RepoView, ReadonlyMap<string, readonly string[]>>();

/** Every dotted suffix of two or more parts of a module's path -> the module's path (`libs/a/b`). Built lazily. */
function suffixIndex(repo: RepoView): ReadonlyMap<string, readonly string[]> {
  let index = suffixCache.get(repo);
  if (index) return index;
  const map = new Map<string, string[]>();
  for (const file of repo.files) {
    if (!/\.pyi?$/.test(file)) continue;
    let base = file.replace(/\.pyi?$/, "");
    if (base.endsWith("/__init__")) base = base.slice(0, -"/__init__".length);
    const parts = base.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts.slice(i).join(".");
      const list = map.get(key);
      if (!list) map.set(key, [base]);
      else if (!list.includes(base)) list.push(base);
    }
  }
  index = map;
  suffixCache.set(repo, index);
  return index;
}

/** A module found by path suffix in any directory (see 4. above): the candidate nearest to `fromFile`. */
function resolveBySuffix(spec: string, fromFile: FilePath, repo: RepoView): FilePath[] {
  const parts = spec.split(".");
  if (parts.length < 2 || STDLIB.has(parts[0]!)) return [];
  const candidates = suffixIndex(repo).get(spec);
  if (!candidates) return [];
  const here = dirOf(fromFile);
  const nearest = [...candidates].sort(
    (a, b) =>
      sharedSegments(dirOf(b), here) - sharedSegments(dirOf(a), here) ||
      a.length - b.length ||
      (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const base of nearest) {
    const found = probe(base, repo, fromFile);
    if (found.length > 0) return found;
  }
  return [];
}

function candidateRoots(fromFile: FilePath, repo: RepoView): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (root: string): void => {
    if (!seen.has(root)) {
      seen.add(root);
      roots.push(root);
    }
  };
  add("");
  add("src");
  for (let dir = dirOf(fromFile); dir !== ""; dir = dirOf(dir)) {
    if (isPackageDir(dir, repo)) continue;
    add(dir);
    add(`${dir}/src`);
  }
  const here = dirOf(fromFile);
  const nearest = [...sourceRoots(repo)].sort(
    (a, b) => sharedSegments(b, here) - sharedSegments(a, here) || (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const root of nearest) add(root);
  return roots;
}

function resolveRelative(spec: string, fromFile: FilePath, repo: RepoView): FilePath[] {
  const dots = /^\.+/.exec(spec)![0].length;
  const rest = spec.slice(dots);
  if (rest !== "" && !DOTTED_NAME.test(rest)) return [];
  let dir = dirOf(fromFile);
  for (let i = 1; i < dots; i++) {
    if (dir === "") return []; // leaves the repository
    dir = dirOf(dir);
  }
  return probe(join(dir, rest.replace(/\./g, "/")), repo, fromFile);
}

function resolveAbsolute(spec: string, fromFile: FilePath, repo: RepoView): FilePath[] {
  if (!DOTTED_NAME.test(spec)) return [];
  const rel = spec.replace(/\./g, "/");
  for (const root of candidateRoots(fromFile, repo)) {
    const found = probe(join(root, rel), repo, fromFile);
    if (found.length > 0) return found;
  }
  return resolveBySuffix(spec, fromFile, repo);
}

export function resolvePythonModule(spec: string, fromFile: FilePath, repo: RepoView): FilePath[] {
  const s = spec.trim();
  if (s === "") return [];
  return s.startsWith(".")
    ? resolveRelative(s, fromFile, repo)
    : resolveAbsolute(s, fromFile, repo);
}

/**
 * The specifier of the submodule `name` of `module` (`from pkg import name` may import the module
 * `pkg.name`): `pkg` + `sub` -> `pkg.sub`, `.` + `x` -> `.x`, `..pkg` + `y` -> `..pkg.y`.
 */
export function pythonSubmoduleSpec(module: string, name: string): string | undefined {
  if (!DOTTED_NAME.test(name) || name.includes(".")) return undefined;
  return /^\.+$/.test(module) ? module + name : `${module}.${name}`;
}
