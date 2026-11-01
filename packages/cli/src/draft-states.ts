/**
 * `xpl draft states`: the states of one status type and where the code moves between them. The entry enumerates
 * states: a TypeScript `enum` or union of string literals, a Python `Enum` class, or a Go type with a `const` block
 * of its values (in the same file). Its states are its members, read from the declaration text (and the index's
 * member symbols, where it has them).
 *
 * Each place that uses a state is a set (an assignment, a `return`, an object key, a ternary branch), a test (a
 * comparison, `is`, `case`) or neither. The places are found on the lines of the index's references to the type and
 * its members (an enum member as `Status.Done`, a Go constant by name), or, for a union of string literals, as a
 * quoted literal next to a field or parameter declared with the type (`this.phase = "live"`), a `case` of a switch
 * on such a field, or a `return` in a function declared to return the type. Comments and other strings never count:
 * the text is matched with them blanked out.
 *
 * A transition A -> B is drafted only where one function tests A and then sets B under that test: the set is on the
 * test's line, or indented under it, with no `else` between; or the test is a negated guard (`!==`, `is not`) whose
 * branch leaves (`throw`, `return`, `raise`), and the set follows at the guard's level. Both sites are anchored.
 *
 * One flow view (`view:<type>-states`): a stage per state (anchored at its declaration and its first sets and
 * tests), a stage per transition (anchored at the test and the set), linked by `next`. A tour: the big picture,
 * then each state. The notes name the states never set or never tested and the uses that are neither.
 */
import {
  RESERVED_PREFIXES,
  type AnchorInput,
  type ExplainerPatch,
  type IndexedSymbol,
  type PatchNode,
  type PatchSequenceStep,
  type PatchTourStep,
  type Reference,
} from "@xpl/core";
import { kebab } from "./draft-class.js";
import {
  FreeIds,
  nameList,
  note,
  signature,
  storedNodeIds,
  symbolLines,
  tick,
  todo,
  tourStep,
  type Draft,
  type DraftInput,
} from "./draft.js";
import { plural } from "./format.js";

export const STATES_LIMITS = {
  /** States on the flow. */
  states: 16,
  /** Transitions on the flow. */
  transitions: 16,
  /** Anchors of a state's stage: its declaration, then the first sets and tests. */
  anchors: 4,
  /** States with a tour step of their own (after the big picture; a tour of at most 12 steps). */
  tourStates: 11,
  /** Names in a hint. */
  hints: 4,
  /** Two code ranges of a tour step further apart than this in one file are one too many (lint `far-ranges`). */
  farLines: 40,
};

type Lang = "ts" | "py" | "go";

interface State {
  name: string;
  /** The line it is declared on. */
  line: number;
  /** Its own symbol, where the index has one (a Python member, a Go constant). */
  member?: IndexedSymbol;
}

interface Use {
  state: number;
  kind: "set" | "test" | "other";
  /** A test that is true when the state is not this one (`!==`, `!=`, `is not`). */
  negated: boolean;
  sym: IndexedSymbol;
  file: string;
  line: number;
  start: number;
  end: number;
}

interface Transition {
  from: number;
  to: number;
  sym: IndexedSymbol;
  test: Use;
  set: Use;
}

const ENTRY_KINDS =
  "the entry must be a TypeScript enum or union of string literals, a Python Enum class, or a Go type with a const block of its values";
const symId = (sym: IndexedSymbol) => `sym:${sym.file}#${sym.path}`;
const shortName = (sym: IndexedSymbol) => sym.path.split(".").pop() ?? sym.path;
const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const indent = (line: string) => line.length - line.trimStart().length;
const byPlace = (a: Use, b: Use) =>
  a.file.localeCompare(b.file) || a.line - b.line || a.start - b.start;

/**
 * The lines of a file with comments blanked (`plain`), and with the contents of strings blanked too (`code`, quotes
 * kept). Columns stay where they were. Block comments, Python triple quotes and backtick strings span lines.
 */
function blanked(lines: readonly string[], lang: Lang): { code: string[]; plain: string[] } {
  const code: string[] = [];
  const plain: string[] = [];
  let open: string | undefined; // "*/" or the quote of a string that spans lines
  for (const line of lines) {
    let c = "";
    let p = "";
    let i = 0;
    while (i < line.length) {
      const ch = line[i]!;
      if (open === "*/") {
        const end = line.startsWith("*/", i) ? 2 : 1;
        if (end === 2) open = undefined;
        c += " ".repeat(end);
        p += " ".repeat(end);
        i += end;
      } else if (open) {
        if (ch === "\\") {
          const two = line.slice(i, i + 2);
          c += " ".repeat(two.length);
          p += two;
          i += two.length;
        } else if (line.startsWith(open, i)) {
          c += open;
          p += open;
          i += open.length;
          open = undefined;
        } else {
          c += " ";
          p += ch;
          i++;
        }
      } else if (lang === "py" ? ch === "#" : line.startsWith("//", i)) {
        c += " ".repeat(line.length - i);
        p += " ".repeat(line.length - i);
        break;
      } else if (lang !== "py" && line.startsWith("/*", i)) {
        open = "*/";
        c += "  ";
        p += "  ";
        i += 2;
      } else if (lang === "py" && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
        open = line.slice(i, i + 3);
        c += open;
        p += open;
        i += 3;
      } else if (ch === "`" && lang !== "py") {
        open = "`";
        c += ch;
        p += ch;
        i++;
      } else if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
        const closed = j < line.length;
        const end = Math.min(j, line.length);
        c += ch + " ".repeat(Math.max(0, end - i - 1)) + (closed ? ch : "");
        p += line.slice(i, j + 1);
        i = j + 1;
      } else {
        c += ch;
        p += ch;
        i++;
      }
    }
    code.push(c);
    plain.push(p);
  }
  return { code, plain };
}

function langOf(language: string | undefined): Lang | undefined {
  if (language === "typescript" || language === "tsx") return "ts";
  if (language === "python") return "py";
  if (language === "go") return "go";
  return undefined;
}

/** The members of a TypeScript enum: the name that starts each comma-separated item of its body. */
function enumMembers(code: readonly string[], entry: IndexedSymbol): State[] {
  const states: State[] = [];
  let depth = 0;
  let expect = false;
  for (let n = entry.range.startLine; n <= entry.range.endLine; n++) {
    const line = code[n - 1] ?? "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (depth === 1 && expect && /[A-Za-z_$]/.test(ch)) {
        const name = /^[\w$]+/.exec(line.slice(i))![0];
        states.push({ name, line: n });
        expect = false;
        i += name.length - 1;
      } else if ("({[".includes(ch)) {
        depth++;
        if (depth === 1 && ch === "{") expect = true;
      } else if (")}]".includes(ch)) {
        depth--;
        if (depth === 0) return states;
      } else if (ch === "," && depth === 1) expect = true;
      else if (!/\s/.test(ch)) expect = false;
    }
  }
  return states;
}

/** The literals of `type T = "a" | "b"`, or undefined when an alternative is not a string literal. */
function unionLiterals(plain: readonly string[], entry: IndexedSymbol): State[] | undefined {
  const lines = plain.slice(entry.range.startLine - 1, entry.range.endLine);
  const rhs = /\btype\s+[\w$]+\s*=\s*([\s\S]*?)\s*;?\s*$/.exec(lines.join("\n"))?.[1];
  if (rhs === undefined) return undefined;
  const states: State[] = [];
  for (const part of rhs.split("|").map((s) => s.trim())) {
    if (part === "") continue;
    const m = /^(["'])([^"'\\]*)\1$/.exec(part);
    if (!m) return undefined;
    const at = lines.findIndex((line) => line.includes(part));
    if (!states.some((s) => s.name === m[2])) {
      states.push({ name: m[2]!, line: entry.range.startLine + Math.max(0, at) });
    }
  }
  return states;
}

/** The constants of a Go type: in a `const` block, `Name Type = ...` and the bare names that repeat it; `const Name Type = ...`. */
function goConstants(code: readonly string[], typeName: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  let inBlock = false;
  let ours = false;
  code.forEach((line, i) => {
    if (!inBlock) {
      const single = /^\s*const\s+([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*=/.exec(line);
      if (single && single[2] === typeName) out.push({ name: single[1]!, line: i + 1 });
      if (/^\s*const\s*\(\s*$/.test(line)) [inBlock, ours] = [true, false];
      return;
    }
    if (/^\s*\)/.test(line)) {
      inBlock = false;
      return;
    }
    const m = /^\s*([A-Za-z_]\w*)\s*(.*)$/.exec(line);
    if (!m) return;
    const rest = m[2]!.trim();
    if (rest === "") {
      if (ours) out.push({ name: m[1]!, line: i + 1 });
      return;
    }
    ours = /^([A-Za-z_]\w*)\s*(=|$)/.exec(rest)?.[1] === typeName;
    if (ours) out.push({ name: m[1]!, line: i + 1 });
  });
  return out;
}

/**
 * How a use of a state reads: a test (after or before a comparison, after `is` or `case`), a set (after a single
 * `=`, `return`, an object key, a ternary branch of an assignment or a return), or neither.
 */
function classify(line: string, start: number, end: number): Pick<Use, "kind" | "negated"> {
  const before = line.slice(0, start).trimEnd();
  const after = line.slice(end).trimStart();
  const cmp = /(===|!==|==|!=)$/.exec(before) ?? /^(===|!==|==|!=)/.exec(after);
  if (cmp) return { kind: "test", negated: cmp[1]!.startsWith("!") };
  const is = /\bis(\s+not)?$/.exec(before);
  if (is) return { kind: "test", negated: is[1] !== undefined };
  if (/\bcase\b[^:]*$/.test(before)) return { kind: "test", negated: false };
  const set =
    /(?:^|[^=!<>])=$/.test(before) ||
    /\breturn$/.test(before) ||
    /[\w$\])"']\s*:$/.test(before) ||
    /(?:(?:^|[^=!<>])=(?!=)|\breturn\b)[^=;]*(?:\?|\belse)$/.test(before);
  return { kind: set ? "set" : "other", negated: false };
}

/** Does the set `s` run under the test `t` (same function, `t` first)? See the module header. */
function under(code: readonly string[], t: Use, s: Use): boolean {
  const EXIT = /\b(?:throw|return|raise|panic|continue|break)\b/;
  const at = (n: number) => code[n - 1] ?? "";
  const blank = (n: number) => at(n).trim() === "";
  if (t.line === s.line) {
    const between = at(t.line).slice(t.end, s.start);
    return t.negated ? EXIT.test(between) : !/\b(?:else|elif)\b/.test(between);
  }
  const base = indent(at(t.line));
  if (!t.negated) {
    if (indent(at(s.line)) <= base) return false;
    for (let n = t.line + 1; n < s.line; n++) if (!blank(n) && indent(at(n)) <= base) return false;
    return true;
  }
  // a guard: its branch (the rest of its line, or the lines indented under it) leaves; the set follows at its level
  let guard = at(t.line).slice(t.end);
  let n = t.line + 1;
  for (; n < s.line && (blank(n) || indent(at(n)) > base); n++) guard += `\n${at(n)}`;
  if (n < s.line && /^\s*}\s*$/.test(at(n))) n++;
  if (!EXIT.test(guard) || indent(at(s.line)) !== base) return false;
  for (; n < s.line; n++) if (!blank(n) && indent(at(n)) < base) return false;
  return true;
}

export function draftStates(input: DraftInput, entry: IndexedSymbol): Draft {
  const { explainer, model, texts } = input;
  const lang = langOf(model.file(entry.file)?.language);
  const cache = new Map<string, { code: string[]; plain: string[] }>();
  const text = (file: string) => {
    let t = cache.get(file);
    if (!t) cache.set(file, (t = blanked(texts.lines(file) ?? [], lang!)));
    return t;
  };
  const name = shortName(entry);

  // ── The states, and how a use of one is written.
  let states: State[] | undefined;
  let match: "qualified" | "bare" | "literal" = "qualified";
  if (lang === "ts" && entry.kind === "enum") states = enumMembers(text(entry.file).code, entry);
  else if (lang === "ts" && entry.kind === "type") {
    states = unionLiterals(text(entry.file).plain, entry);
    match = "literal";
  } else if (lang === "py" && entry.kind === "class") {
    const first = text(entry.file).code.slice(entry.range.startLine - 1, entry.range.endLine);
    const bases = first.map((l) => /^\s*class\s+\w+\s*\(([^)]*)\)/.exec(l)?.[1]).find(Boolean);
    if (bases && /\b(?:Enum|IntEnum|StrEnum|Flag|IntFlag)\b/.test(bases)) {
      states = model
        .childSymbols(entry.id)
        .filter((c) => c.kind === "variable" && !shortName(c).startsWith("_"))
        .map((c) => ({ name: shortName(c), line: c.range.startLine, member: c }));
    }
  } else if (lang === "go" && entry.kind === "type") {
    states = goConstants(text(entry.file).code, name)
      .map((c) => ({ ...c, member: model.symbolAt(entry.file, c.name) }))
      .filter((s) => s.member?.kind === "variable");
    match = "bare";
  }
  if (!states || states.length < 2) {
    throw new Error(`${symId(entry)} (a ${entry.kind}) does not enumerate states: ${ENTRY_KINDS}`);
  }
  const limits: string[] = [];
  if (states.length > STATES_LIMITS.states) {
    limits.push(
      `${plural(states.length - STATES_LIMITS.states, "more state")} left off the flow (at most ${STATES_LIMITS.states})`,
    );
    states = states.slice(0, STATES_LIMITS.states);
  }
  const index = new Map(states.map((s, i) => [s.name, i]));

  // ── The uses: on the lines of the references, or (literals) in the files that refer to the type.
  const refs: Reference[] = [entry, ...states.flatMap((s) => (s.member ? [s.member] : []))]
    .flatMap((sym) => model.refsTo(sym.id))
    .filter((r) => r.kind !== "import");
  const uses = new Map<string, Use>();
  const add = (
    file: string,
    line: number,
    start: number,
    end: number,
    state: number,
    how: Pick<Use, "kind" | "negated">,
  ) => {
    const sym = model.innermostSymbolAt(file, line);
    if (!sym || sym.id === entry.id || states!.some((s) => s.member?.id === sym.id)) return;
    const key = `${file}:${line}:${start}`;
    if (!uses.has(key)) uses.set(key, { state, ...how, sym, file, line, start, end });
  };
  const sites = (list: readonly Reference[]) => {
    const out = new Map<string, { file: string; line: number; to: string }>();
    for (const r of list) {
      const file = model.fileOfSymbolId(r.from);
      if (!file) continue;
      for (let line = r.site.startLine; line <= r.site.endLine; line++) {
        out.set(`${file}:${line}:${r.to}`, { file, line, to: r.to });
      }
    }
    return [...out.values()];
  };
  if (match === "qualified") {
    const re = new RegExp(
      `(?<![\\w$])${esc(name)}\\.(${states.map((s) => esc(s.name)).join("|")})(?![\\w$])`,
      "g",
    );
    for (const { file, line } of sites(refs)) {
      const code = text(file).code[line - 1] ?? "";
      for (const m of code.matchAll(re)) {
        const end = m.index + m[0].length;
        add(file, line, m.index, end, index.get(m[1]!)!, classify(code, m.index, end));
      }
    }
  } else if (match === "bare") {
    for (const { file, line, to } of sites(refs)) {
      const state = states.findIndex((s) => s.member?.id === to);
      if (state === -1) continue;
      const code = text(file).code[line - 1] ?? "";
      const re = new RegExp(`(?<![\\w$.])${esc(states[state]!.name)}(?![\\w$])`, "g");
      for (const m of code.matchAll(re)) {
        const end = m.index + m[0].length;
        add(file, line, m.index, end, state, classify(code, m.index, end));
      }
    }
  } else {
    // what holds a state: a field or parameter declared with the type (`phase: Phase`), a React ref
    // (`follow = useRef<Follow>(...)`, read as `follow.current`) or state (`[mode, setMode] = useState<Mode>(...)`)
    const T = esc(name);
    const holders = new Set<string>();
    const setters = new Set<string>();
    const returners = new Set<string>();
    for (const { file, line } of sites(refs)) {
      const code = text(file).code[line - 1] ?? "";
      for (const m of code.matchAll(
        new RegExp(`([A-Za-z_$][\\w$]*)\\??\\s*:\\s*${T}(?![\\w$])`, "g"),
      ))
        holders.add(esc(m[1]!));
      const ref = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*=\\s*(?:React\\.)?useRef<${T}>`).exec(code);
      if (ref) holders.add(`${esc(ref[1]!)}\\.current`);
      const state = new RegExp(
        `\\[\\s*([A-Za-z_$][\\w$]*)\\s*,\\s*([A-Za-z_$][\\w$]*)\\s*\\]\\s*=\\s*(?:React\\.)?useState<${T}>`,
      ).exec(code);
      if (state) {
        holders.add(esc(state[1]!));
        setters.add(esc(state[2]!));
      }
      const fn = model.innermostSymbolAt(file, line);
      if (fn && new RegExp(`\\)\\s*:\\s*${T}(?![\\w$])`).test(code)) returners.add(fn.id);
    }
    const H = `(?<![\\w$])(?:${[...holders].join("|") || "(?!)"})`;
    const S = `(?<![\\w$])(?:${[...setters].join("|") || "(?!)"})`;
    const testBefore = new RegExp(`${H}\\s*(===|!==|==|!=)$`);
    const testAfter = new RegExp(`^(===|!==|==|!=)\\s*(?:[\\w$]+\\.)*${H}(?![\\w$])`);
    const setBefore = [
      new RegExp(`${H}\\??\\s*(?::[^=]*)?=$`), // phase = "live", phase: Phase = "live"
      new RegExp(`${H}\\??\\s*:$`), // { phase: "live" }
      new RegExp(`${H}\\??\\s*(?::[^=]*)?=(?!=)[^=;]*[?:]$`), // phase = ok ? "live" : "draft"
      new RegExp(`${S}\\($`), // setPhase("live")
      new RegExp(`<${T}>\\($`), // useState<Phase>("draft")
    ];
    const files = new Set([entry.file, ...sites(refs).map((s) => s.file)]);
    const lit = new RegExp(`(["'])(${states.map((s) => esc(s.name)).join("|")})\\1`, "g");
    for (const file of files) {
      const { code, plain } = text(file);
      plain.forEach((line, i) => {
        for (const m of line.matchAll(lit)) {
          const start = m.index;
          const end = start + m[0].length;
          const before = code[i]!.slice(0, start).trimEnd();
          const after = code[i]!.slice(end).trimStart();
          const sym = model.innermostSymbolAt(file, i + 1);
          const cmp = testBefore.exec(before) ?? testAfter.exec(after);
          const how: Pick<Use, "kind" | "negated"> | undefined = cmp
            ? { kind: "test", negated: cmp[1]!.startsWith("!") }
            : setBefore.some((re) => re.test(before)) ||
                (/\breturn$/.test(before) && sym !== undefined && returners.has(sym.id))
              ? { kind: "set", negated: false }
              : /\bcase$/.test(before) && sym && switchesOn(code, sym, H)
                ? { kind: "test", negated: false }
                : undefined;
          if (how) add(file, i + 1, start, end, index.get(m[2]!)!, how);
        }
      });
    }
  }
  const all = [...uses.values()].sort(byPlace);

  // ── Transitions: in one function, a set under a test of another state.
  const transitions: Transition[] = [];
  const seen = new Set<string>();
  const byFn = new Map<string, Use[]>();
  for (const use of all) {
    if (use.sym.kind !== "function" && use.sym.kind !== "method") continue;
    byFn.set(use.sym.id, [...(byFn.get(use.sym.id) ?? []), use]);
  }
  for (const list of byFn.values()) {
    list.forEach((set, k) => {
      if (set.kind !== "set") return;
      const prior = list.slice(0, k).filter((u) => u.kind === "test");
      const last = prior.at(-1);
      if (!last || !under(text(set.file).code, last, set)) return;
      for (const test of prior.filter((u) => u.line === last.line && u.negated === last.negated)) {
        const key = `${test.state}>${set.state}@${set.sym.id}`;
        if (test.state === set.state || seen.has(key)) continue;
        seen.add(key);
        transitions.push({ from: test.state, to: set.state, sym: set.sym, test, set });
      }
    });
  }
  transitions.sort((a, b) => a.from - b.from || a.to - b.to || byPlace(a.set, b.set));
  if (transitions.length > STATES_LIMITS.transitions) {
    limits.push(
      `${plural(transitions.length - STATES_LIMITS.transitions, "more transition")} left off the flow (at most ${STATES_LIMITS.transitions})`,
    );
    transitions.length = STATES_LIMITS.transitions;
  }

  // ── The flow.
  const ids = new FreeIds(explainer);
  const stored = storedNodeIds(explainer);
  const base = kebab(name) || "status";
  const viewId = ids.get(
    "view",
    RESERVED_PREFIXES.includes(base) ? `${base}-type-states` : `${base}-states`,
  );
  const prefix = viewId.slice("view:".length);
  // step ids are `<view>:<n>` in list order: each state, then the transitions out of it
  const stateIds: string[] = [];
  const moveIds: string[] = [];
  let n = 0;
  states.forEach((_, i) => {
    stateIds[i] = `${prefix}:${++n}`;
    transitions.forEach((t, k) => {
      if (t.from === i) moveIds[k] = `${prefix}:${++n}`;
    });
  });
  // the states' own box: the type, or its file when the members live outside it (Go constants)
  const owner = states.every(
    (s) => s.line >= entry.range.startLine && s.line <= entry.range.endLine,
  )
    ? symId(entry)
    : `file:${entry.file}`;
  const fns = [...new Map(transitions.map((t) => [t.sym.id, t.sym])).values()];
  const participants = [owner, ...fns.map(symId)];

  const useAnchor = (u: Use) => symbolLines(texts, u.sym, u.line, u.line, "usage");
  const defAnchor = (s: State) =>
    symbolLines(texts, s.member ?? entry, s.line, s.line, "definition");
  const anchors = (list: readonly (AnchorInput | undefined)[], max: number): AnchorInput[] => {
    const out = new Map<string, AnchorInput>();
    for (const a of list) if (a && out.size < max) out.set(JSON.stringify(a), a);
    return [...out.values()];
  };
  const users = (state: number, kind: Use["kind"]) =>
    all.filter((u) => u.state === state && u.kind === kind);
  const hint = (state: number) => {
    const sets = [...new Set(users(state, "set").map((u) => u.sym.path))];
    const tests = [...new Set(users(state, "test").map((u) => u.sym.path))];
    if (sets.length === 0 && tests.length === 0) return "no code found that sets or tests it";
    return [
      sets.length > 0 ? `set in ${nameList(sets, STATES_LIMITS.hints)}` : "no set found",
      tests.length > 0 ? `tested in ${nameList(tests, STATES_LIMITS.hints)}` : "no test found",
    ].join("; ");
  };

  const steps: PatchSequenceStep[] = [];
  states.forEach((s, i) => {
    const outs = transitions.flatMap((t, k) => (t.from === i ? [k] : []));
    steps.push({
      id: stateIds[i]!,
      from: owner,
      to: owner,
      label: todo(`name the state ${s.name} in a few plain words`),
      kind: "call",
      shape: "stage",
      summary: todo(`what this state means, in one plain sentence (${hint(i)}).`),
      next: outs.map((k) => ({ step: moveIds[k]! })),
      anchors: anchors(
        [defAnchor(s), ...users(i, "set").map(useAnchor), ...users(i, "test").map(useAnchor)],
        STATES_LIMITS.anchors,
      ),
    });
    for (const k of outs) {
      const t = transitions[k]!;
      const [a, b] = [states![t.from]!.name, states![t.to]!.name];
      steps.push({
        id: moveIds[k]!,
        from: symId(t.sym),
        to: symId(t.sym),
        label: todo(`what moves it from ${a} to ${b}`),
        kind: "call",
        shape: "stage",
        summary: todo(`when and why ${tick(t.sym.path)} moves it from ${tick(a)} to ${tick(b)}.`),
        next: [{ step: stateIds[t.to]! }],
        anchors: anchors([useAnchor(t.test), useAnchor(t.set)], 2),
      });
    }
  });

  const nodes: PatchNode[] = [];
  if (!stored.has(owner)) {
    nodes.push({
      id: owner,
      summary: todo(
        `one plain sentence: what ${tick(name)} tracks (its states: ${nameList(
          states.map((s) => s.name),
          STATES_LIMITS.hints,
        )}).`,
      ),
    });
  }
  for (const fn of fns) {
    if (stored.has(symId(fn))) continue;
    const moves = transitions
      .filter((t) => t.sym.id === fn.id)
      .map((t) => `${states![t.from]!.name} to ${states![t.to]!.name}`);
    nodes.push({
      id: symId(fn),
      summary: todo(
        `one plain sentence: what this function does (it moves the state from ${moves.join(", ")}).`,
      ),
    });
  }

  // ── The tour: the big picture, then each state.
  const tourSteps: PatchTourStep[] = [
    tourStep(
      model,
      "t1",
      viewId,
      [owner],
      note(
        todo(`what ${name} tracks, as a plain statement`),
        todo("the states in the order a thing goes through them, and the moves between them."),
      ),
      [signature(texts, entry)],
    ),
  ];
  states.slice(0, STATES_LIMITS.tourStates).forEach((s, i) => {
    const def = defAnchor(s);
    const set = users(i, "set")[0];
    const far =
      set &&
      set.file === (s.member ?? entry).file &&
      Math.abs(set.line - s.line) > STATES_LIMITS.farLines;
    tourSteps.push(
      tourStep(
        model,
        `t${tourSteps.length + 1}`,
        viewId,
        [stateIds[i]!],
        note(
          todo(`what ${s.name} means, as a plain statement`),
          todo("how a thing gets into this state and where it can go next."),
        ),
        [def, set && !far ? useAnchor(set) : undefined],
      ),
    );
  });
  if (states.length > STATES_LIMITS.tourStates) {
    limits.push(
      `${plural(states.length - STATES_LIMITS.tourStates, "state")} without a tour step (at most ${STATES_LIMITS.tourStates + 1} steps)`,
    );
  }

  const notes: string[] = [];
  for (const [kind, word] of [
    ["set", "set"],
    ["test", "tested"],
  ] as const) {
    const never = states.filter((_, i) => users(i, kind).length === 0).map((s) => s.name);
    if (never.length > 0) notes.push(`never ${word}: ${nameList(never)}`);
  }
  const other = all.filter((u) => u.kind === "other").length;
  if (other > 0) {
    notes.push(
      `${plural(other, "use")} ${other === 1 ? "is" : "are"} neither a set nor a test (an argument, a list): \`xpl refs ${symId(entry)} --in\` lists them`,
    );
  }
  notes.push(
    ...limits,
    "a transition is drafted only where one function tests a state and then sets another, matched in its text: check each in the code, and add the moves the draft missed",
  );
  if (refs.some((r) => r.resolution === "heuristic")) {
    notes.push("the uses come from heuristic references: check each in the code");
  }

  const patch: ExplainerPatch = {
    nodes,
    views: [
      {
        id: viewId,
        type: "flow",
        title: todo(
          `what the flow shows, in plain words (for example: the states of ${name} and the moves between them)`,
        ),
        scope: {
          root: "repo",
          depth: 2,
          question: todo("the question these states answer"),
          entryPoints: [entry.id],
        },
        layout: "diagram",
        participants,
        steps,
      },
    ],
    tours: [
      {
        id: ids.get("tour", prefix),
        title: todo("what the tour covers, in about 8 plain words"),
        summary: `${todo(`what ${name} tracks and who reads it, in plain words.`)} ${todo("which moves the code makes, and which it does not make, in one sentence.")}`,
        steps: tourSteps,
      },
    ],
  };
  return { kind: "states", patch, notes };
}

/** Does the function switch on one of the holders (`switch (this.phase)`)? */
function switchesOn(code: readonly string[], sym: IndexedSymbol, holders: string): boolean {
  const body = code.slice(sym.range.startLine - 1, sym.range.endLine).join("\n");
  return new RegExp(`\\bswitch\\s*\\([^)]*${holders}(?![\\w$])`).test(body);
}
