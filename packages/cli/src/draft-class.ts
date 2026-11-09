/**
 * `xpl draft class`: the type hierarchy around one class or interface, from the index's `extends` and
 * `implements` references. One map (`view:<name>-types`, `edgeKinds: extends, implements`, no stubs): the types
 * the entry extends or implements, all the way up, then the entry, then the types that extend or implement it,
 * two levels down. Each box gets a summary TODO that carries what the index knows (its kind, what it extends and
 * implements, what extends it, its methods). A tour: the entry, then each type it extends or implements directly,
 * then each that extends or implements it directly. Heuristic references are hints: the arrows say so on the map.
 */
import {
  RESERVED_PREFIXES,
  type ExplainerPatch,
  type IndexModel,
  type IndexedSymbol,
  type PatchNode,
  type PatchTourStep,
} from "@xpl/core";
import {
  FreeIds,
  nameList,
  note,
  signature,
  storedNodeIds,
  todo,
  tourStep,
  type Draft,
  type DraftInput,
} from "./draft.js";
import { plural } from "./format.js";

export const CLASS_LIMITS = {
  /** Types above the entry (what it extends or implements, and theirs). */
  up: 6,
  /** Levels below the entry. */
  downDepth: 2,
  /** Boxes on the map in all. */
  boxes: 8,
  /** Tour steps. */
  steps: 8,
  /** Names in a hint. */
  hints: 4,
};

/** Kinds that can be the entry of the draft. */
export const CLASS_ENTRY_KINDS: ReadonlySet<IndexedSymbol["kind"]> = new Set([
  "class",
  "interface",
]);
/** Kinds that take part in a type hierarchy. */
const TYPE_KINDS: ReadonlySet<IndexedSymbol["kind"]> = new Set([
  "class",
  "interface",
  "enum",
  "type",
]);
const LINKS = new Set(["extends", "implements"]);

const symId = (sym: IndexedSymbol) => `sym:${sym.file}#${sym.path}`;
const shortName = (sym: IndexedSymbol) => sym.path.split(".").pop() ?? sym.path;
const byPlace = (a: IndexedSymbol, b: IndexedSymbol) =>
  a.file.localeCompare(b.file) || a.range.startLine - b.range.startLine;

/** The types `sym` extends or implements (`up`), or that extend or implement it (`down`), with how. */
function links(
  model: IndexModel,
  sym: IndexedSymbol,
  direction: "up" | "down",
): { sym: IndexedSymbol; kind: "extends" | "implements" }[] {
  const refs = direction === "up" ? model.refsFrom(sym.id) : model.refsTo(sym.id);
  const out = new Map<string, { sym: IndexedSymbol; kind: "extends" | "implements" }>();
  for (const ref of refs) {
    if (!LINKS.has(ref.kind)) continue;
    const other = model.symbol(direction === "up" ? ref.to : ref.from);
    if (!other || other.id === sym.id || !TYPE_KINDS.has(other.kind) || out.has(other.id)) continue;
    out.set(other.id, { sym: other, kind: ref.kind as "extends" | "implements" });
  }
  return [...out.values()].sort((a, b) => byPlace(a.sym, b.sym));
}

/** `FancyCircle` -> `fancy-circle`, `QUEUED` -> `queued`; empty when no letter or digit is left. */
export function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function draftClass(input: DraftInput, entry: IndexedSymbol): Draft {
  const { explainer, model, texts } = input;
  const ids = new FreeIds(explainer);
  const stored = storedNodeIds(explainer);
  const notes: string[] = [];

  // ── Up: what the entry extends or implements, breadth first, nearest first.
  const up: IndexedSymbol[] = [];
  const seen = new Set<string>([entry.id]);
  let level: IndexedSymbol[] = [entry];
  while (level.length > 0 && up.length < CLASS_LIMITS.up) {
    const next: IndexedSymbol[] = [];
    for (const sym of level) {
      for (const { sym: base } of links(model, sym, "up")) {
        if (seen.has(base.id) || up.length >= CLASS_LIMITS.up) continue;
        seen.add(base.id);
        up.push(base);
        next.push(base);
      }
    }
    level = next;
  }
  // ── Down: what extends or implements it, two levels, while the map has room.
  const down: IndexedSymbol[] = [];
  let left = 0;
  level = [entry];
  for (let depth = 0; depth < CLASS_LIMITS.downDepth && level.length > 0; depth++) {
    const next: IndexedSymbol[] = [];
    for (const sym of level) {
      for (const { sym: sub } of links(model, sym, "down")) {
        if (seen.has(sub.id)) continue;
        seen.add(sub.id);
        if (1 + up.length + down.length >= CLASS_LIMITS.boxes) {
          left++;
          continue;
        }
        down.push(sub);
        next.push(sub);
      }
    }
    level = next;
  }
  if (up.length === 0 && down.length === 0) {
    throw new Error(
      `${symId(entry)} extends and implements nothing the index knows, and nothing extends or implements it: there is no hierarchy to draw`,
    );
  }
  if (left > 0) {
    notes.push(
      `${plural(left, "more type")} below are left off the map (at most ${CLASS_LIMITS.boxes} boxes)`,
    );
  }

  const boxes = [...[...up].reverse(), entry, ...down];
  const onMap = new Set(boxes.map((s) => s.id));
  const hint = (sym: IndexedSymbol): string => {
    const first = (texts.lines(sym.file)?.[sym.range.startLine - 1] ?? "").trim();
    const parts = [
      /\babstract\b/.test(first) && sym.kind === "class" ? "abstract class" : sym.kind,
    ];
    const ups = links(model, sym, "up");
    const downs = links(model, sym, "down");
    const named = (list: typeof ups, kind: "extends" | "implements") =>
      list.filter((l) => l.kind === kind).map((l) => shortName(l.sym));
    const add = (label: string, names: string[]) => {
      if (names.length > 0) parts.push(`${label} ${nameList(names, CLASS_LIMITS.hints)}`);
    };
    add("extends", named(ups, "extends"));
    add("implements", named(ups, "implements"));
    add("extended by", named(downs, "extends"));
    add("implemented by", named(downs, "implements"));
    // methods by name: overloads once (`name~2` is the index's second `name`), constructors left out
    const methods = model
      .childSymbols(sym.id)
      .filter((c) => c.kind === "method" || c.kind === "function")
      .map((c) => shortName(c).replace(/~\d+$/, ""))
      .filter((name) => name !== shortName(sym) && name !== "constructor" && name !== "__init__");
    add("methods:", [...new Set(methods)]);
    return parts.join("; ");
  };

  const nodes: PatchNode[] = [];
  for (const sym of boxes) {
    const id = symId(sym);
    if (stored.has(id)) continue;
    nodes.push({ id, summary: todo(`one plain sentence: what this type is for (${hint(sym)}).`) });
  }

  const slug = kebab(shortName(entry)) || "type";
  const base = RESERVED_PREFIXES.includes(slug) ? `${slug}-class` : slug;
  const viewId = ids.get("view", `${base}-types`);

  const steps: PatchTourStep[] = [
    tourStep(
      model,
      "t1",
      viewId,
      [symId(entry)],
      note(
        todo(`what ${shortName(entry)} is for, as a plain statement`),
        todo("its job in one or two sentences, and what the types around it add or share."),
      ),
      [signature(texts, entry)],
    ),
  ];
  const direct = [
    ...links(model, entry, "up").map((l) => ({ ...l, way: "up" as const })),
    ...links(model, entry, "down").map((l) => ({ ...l, way: "down" as const })),
  ].filter((l) => onMap.has(l.sym.id));
  for (const link of direct.slice(0, CLASS_LIMITS.steps - 1)) {
    const name = shortName(link.sym);
    steps.push(
      tourStep(
        model,
        `t${steps.length + 1}`,
        viewId,
        [symId(link.sym)],
        link.way === "up"
          ? note(
              todo(`what ${shortName(entry)} gets from ${name}, as a plain statement`),
              todo(`what ${name} promises or provides (${shortName(entry)} ${link.kind} it).`),
            )
          : note(
              todo(`what ${name} changes or adds, as a plain statement`),
              todo(
                `how it differs from ${shortName(entry)} (it ${link.kind === "extends" ? "extends" : "implements"} it).`,
              ),
            ),
        [signature(texts, link.sym)],
      ),
    );
  }
  // the boxes no step visits are named on the first step, so the tour covers the whole map
  const visited = new Set(steps.flatMap((step) => step.focus ?? []));
  const others = boxes.filter((sym) => !visited.has(symId(sym))).map((sym) => sym.path);
  if (others.length > 0) {
    steps[0]!.note += ` Also on the map: ${others.join(", ")}.`;
  }
  if (direct.length > steps.length - 1) {
    notes.push(
      `${direct.length - (steps.length - 1)} direct types have no tour step (at most ${CLASS_LIMITS.steps} steps)`,
    );
  }
  if (
    boxes.some((sym) =>
      [...model.refsFrom(sym.id), ...model.refsTo(sym.id)].some(
        (r) => LINKS.has(r.kind) && r.resolution === "heuristic",
      ),
    )
  ) {
    notes.push(
      "some arrows come from heuristic references: check each in the code before you explain it",
    );
  }

  const patch: ExplainerPatch = {
    nodes,
    views: [
      {
        id: viewId,
        type: "graph",
        title: todo(
          `what the map shows, in plain words (for example: ${shortName(entry)} and the types around it)`,
        ),
        scope: { root: symId(entry), depth: 1 },
        include: boxes.map(symId),
        edgeKinds: ["extends", "implements"],
        stubs: { mode: "none" },
      },
    ],
    tours: [
      {
        id: ids.get("tour", `${base}-types`),
        title: todo("what the tour covers, in about 8 plain words"),
        summary: `${todo(`what ${shortName(entry)} is for and who uses it, in plain words.`)} ${todo("what the types around it share and how they differ, in one sentence.")}`,
        steps,
      },
    ],
  };
  return { kind: "class", patch, notes };
}
