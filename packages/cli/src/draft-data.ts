/**
 * `xpl draft data`: what data the code keeps and how its types relate. One data-model map (`view:<slug>-data`,
 * `boxText: "members"`): a table per type (class, interface, type, enum), a row per field the index knows, and
 * arrows from a field to the type it holds (`references`) and from a type to what it extends or implements.
 *
 * Which types: those of the scope (the repo, a folder or a file; tests, examples, docs and fixtures left out) that
 * hold or are held by another one; a type with no fields (a function type, an alias) only when it extends or
 * implements one, or one implements it. The linked types fall into groups (types that link to each other). Each group
 * starts at the type that reaches the most others through its fields and heritage (never at one with no fields) and
 * grows along the links: each next box is linked to the boxes already picked, below one of them (a type a box's field
 * holds, or one that implements or extends a box) first, then the most used, then the one with the most types below it. The groups share the box budget (at most 6 boxes, 8 rows a box; a later group keeps room for 2). A type
 * entry (`sym:`) starts there instead, and only types linked to it (two links away at most) join. Each box gets a
 * summary TODO with what the index knows. Field rows get none: a row shows its declaration. A tour: the first type,
 * the next types (each group's first among them), a step on the rest of the map, and where to go next.
 */
import {
  baseName,
  isTestFile,
  matchesAnyGlob,
  type AnchorInput,
  type ExplainerPatch,
  type IndexModel,
  type IndexedSymbol,
  type PatchNode,
  type PatchTourStep,
  type Reference,
} from "@xpl/core";
import { kebab } from "./draft-class.js";
import {
  FreeIds,
  NOT_DESIGN,
  OVERVIEW_EXCLUDE,
  nameList,
  note,
  storedNodeIds,
  symbolLines,
  todo,
  tourStep,
  type Draft,
  type DraftInput,
} from "./draft.js";
import { kindWord, plural } from "./format.js";
import type { Target } from "./target.js";

export const DATA_LIMITS = {
  /** Boxes (types) on the map: the top of the skill's budget for a data map (3-6 tables). */
  boxes: 6,
  /** Rows (fields) a box. */
  rows: 8,
  /** Tour steps: the types, the rest of the map, and where to go next. */
  steps: 6,
  /** Links from a type entry: the types this many links away join. */
  reach: 2,
  /** Boxes a later group of types keeps, when it has that many. */
  group: 2,
  /** Names in a hint. */
  hints: 4,
};

const TYPE_KINDS: ReadonlySet<IndexedSymbol["kind"]> = new Set([
  "class",
  "interface",
  "type",
  "enum",
]);
const LINK_KINDS = {
  "type-ref": "references",
  extends: "extends",
  implements: "implements",
} as const;

/** A field of `from` holds a `to` (`via` the field), or `from` extends or implements `to`. */
interface Link {
  from: IndexedSymbol;
  to: IndexedSymbol;
  kind: "references" | "extends" | "implements";
  via?: IndexedSymbol;
  heuristic: boolean;
}

const symId = (sym: IndexedSymbol) => `sym:${sym.file}#${sym.path}`;
const shortName = (sym: IndexedSymbol) => sym.path.split(".").pop() ?? sym.path;
const byPlace = (a: IndexedSymbol, b: IndexedSymbol) =>
  a.file.localeCompare(b.file) || a.range.startLine - b.range.startLine;

/** The fields of a type the index knows (its variables), in the order the code declares them. */
function fieldsOf(model: IndexModel, type: IndexedSymbol): IndexedSymbol[] {
  return model
    .childSymbols(type.id)
    .filter((c) => c.kind === "variable")
    .sort(byPlace);
}

/** What a qualified name starts with: a Go type's package (its folder), else its file's name. */
function qualifier(model: IndexModel, sym: IndexedSymbol): string {
  const parts = sym.file.split("/");
  if (model.file(sym.file)?.language === "go" && parts.length > 1) return parts.at(-2)!;
  return (parts.at(-1) ?? sym.file).replace(/\.[^.]+$/, "");
}

/**
 * Is a type reference the object of an indexed access (`Options['baseUrl']`)? The field holds the type of one member
 * of `Options`, not an `Options`.
 */
function indexedAccess(texts: DraftInput["texts"], file: string, site: Reference["site"]): boolean {
  if (site.startCol === undefined) return false;
  const line = texts.lines(file)?.[site.startLine - 1] ?? "";
  return /^[\w$.]+\s*\[\s*[^\]\s]/.test(line.slice(site.startCol - 1));
}

/** Why a type's box has no rows, in the words of its kind and language. */
function noFieldsReason(model: IndexModel, type: IndexedSymbol): string {
  if (type.kind === "interface") return "an interface has methods, not fields";
  if (type.kind === "type")
    return "a type alias holds fields only when it is an object type `{ ... }`";
  if (type.kind === "enum") return "an enum holds values, not fields";
  if (model.file(type.file)?.language === "python")
    return "a Python attribute set outside `__init__` is not a field";
  return "the index knows no field of it";
}

export function draftData(input: DraftInput, scope: Target): Draft {
  const { explainer, model, texts } = input;
  const ids = new FreeIds(explainer);
  const stored = storedNodeIds(explainer);
  const notes: string[] = [];

  // ── The types of the scope (a type entry: of the whole repo, near it).
  const entry = scope.type === "symbol" ? scope.symbol : undefined;
  if (entry && !TYPE_KINDS.has(entry.kind)) {
    throw new Error(
      `${scope.id} is ${entry.kind === "interface" ? "an" : "a"} ${entry.kind}: a data map starts at a type (a class, interface, type or enum), a folder or a file`,
    );
  }
  const scopePath = scope.type === "dir" || scope.type === "file" ? scope.path : "";
  const offMap = (path: string) =>
    isTestFile(path) ||
    matchesAnyGlob(path, OVERVIEW_EXCLUDE) ||
    matchesAnyGlob(path, NOT_DESIGN) ||
    path.split("/").some((segment) => segment.startsWith("."));
  // what the scope names itself stays in, even in a folder the map leaves out elsewhere (fixtures/)
  const asked = scopePath !== "" && offMap(scopePath);
  const inScope = (path: string) =>
    (scope.type === "file"
      ? path === scopePath
      : scope.type === "dir"
        ? path.startsWith(`${scopePath}/`)
        : true) &&
    (asked || !offMap(path));
  const candidates = model.symbols.filter((s) => TYPE_KINDS.has(s.kind) && inScope(s.file));
  const isCandidate = new Set(candidates.map((s) => s.id));
  if (entry) isCandidate.add(entry.id);

  // ── The links between them: a type extends or implements one, or one of its fields holds one. (A type that
  // only names another in its own definition, a function type, holds nothing.)
  let links: Link[] = [];
  for (const type of entry ? [...candidates, entry] : candidates) {
    for (const from of [type, ...fieldsOf(model, type)]) {
      for (const ref of model.refsFrom(from.id)) {
        const kind = LINK_KINDS[ref.kind as keyof typeof LINK_KINDS];
        if (!kind || (kind === "references") === (from === type)) continue;
        const to = model.symbol(ref.to);
        if (!to || to.id === type.id || !isCandidate.has(to.id)) continue;
        if (kind === "references" && indexedAccess(texts, from.file, ref.site)) continue;
        links.push({
          from: type,
          to,
          kind,
          ...(from !== type ? { via: from } : {}),
          heuristic: ref.resolution === "heuristic",
        });
      }
    }
  }
  // A type with no fields is a table with no rows: a box only when it takes part in a hierarchy (an interface a
  // type implements). Held only, its name shows as the type of the rows that hold it.
  const hasFields = (s: IndexedSymbol) => fieldsOf(model, s).length > 0;
  const inHierarchy = (s: IndexedSymbol) =>
    links.some((l) => l.kind !== "references" && (l.from === s || l.to === s));
  /** Such a type, with the types that link to it. */
  const unboxed = new Map<string, { sym: IndexedSymbol; by: Set<string> }>();
  links = links.filter((l) => {
    for (const [s, other] of [
      [l.from, l.to],
      [l.to, l.from],
    ] as const) {
      if (s === entry || hasFields(s) || inHierarchy(s)) continue;
      const seen = unboxed.get(s.id) ?? { sym: s, by: new Set<string>() };
      seen.by.add(other.id);
      unboxed.set(s.id, seen);
      return false;
    }
    return true;
  });
  const neighbours = new Map<string, Set<string>>();
  for (const link of links) {
    for (const [a, b] of [
      [link.from.id, link.to.id],
      [link.to.id, link.from.id],
    ] as const) {
      neighbours.set(a, (neighbours.get(a) ?? new Set()).add(b));
    }
  }
  for (const id of neighbours.keys()) unboxed.delete(id);
  // how much the code outside tests uses each type
  const uses = (sym: IndexedSymbol) =>
    model.refsTo(sym.id).filter((ref) => !isTestFile(model.fileOfSymbolId(ref.from) ?? "")).length;
  const symbolById = new Map(
    [...candidates, ...(entry ? [entry] : [])].map((s) => [s.id, s] as const),
  );

  let pool = [...symbolById.values()].filter((s) => neighbours.has(s.id));
  if (entry) {
    if (!neighbours.has(entry.id)) {
      const python = model.file(entry.file)?.language === "python";
      throw new Error(
        `${scope.id} holds no other type in its fields, and no type holds it, extends it or implements it: there is no data model to draw` +
          (python
            ? " (only the attributes `__init__` sets on `self` are fields; `xpl outline --under " +
              scope.id +
              "` lists them)"
            : ` (\`xpl outline --under ${scope.id}\` lists its fields)`),
      );
    }
    // the types a few links from the entry
    const near = new Set([entry.id]);
    let level = [entry.id];
    for (let step = 0; step < DATA_LIMITS.reach; step++) {
      level = level.flatMap((id) => [...(neighbours.get(id) ?? [])]).filter((id) => !near.has(id));
      for (const id of level) near.add(id);
    }
    pool = pool.filter((s) => near.has(s.id));
  }
  if (pool.length === 0) {
    const where = scope.type === "repo" ? "the repository" : scope.id;
    throw new Error(
      `no type in ${where} holds another one in a field, extends one or implements one: there is no data model to draw (\`xpl outline --kind class,interface,type\` lists the types)`,
    );
  }

  // ── The groups: types joined by links. Each starts at the type that reaches the most others (along a field to the
  // type it holds, or up a hierarchy), never at one with no fields; then one no type holds; then the most used.
  const used = new Map(pool.map((s) => [s.id, uses(s)] as const));
  const rank = (a: IndexedSymbol, b: IndexedSymbol) =>
    used.get(b.id)! - used.get(a.id)! || byPlace(a, b);
  // "Down" a link: from a type to the type its field holds, and from a base or an interface to the types that extend
  // or implement it (a field of the interface's type holds one of them).
  const down = new Map<string, string[]>();
  for (const l of links) {
    const [a, b] = l.kind === "references" ? [l.from.id, l.to.id] : [l.to.id, l.from.id];
    down.set(a, [...(down.get(a) ?? []), b]);
  }
  /** How many types lie below `s`, leaving out those in `skip`. */
  const reach = (s: IndexedSymbol, skip: ReadonlySet<string> = new Set()): number => {
    const seen = new Set([s.id]);
    const queue = [s.id];
    while (queue.length > 0) {
      for (const next of down.get(queue.shift()!) ?? []) {
        if (seen.has(next) || skip.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return seen.size - 1;
  };
  const heldBy = (s: IndexedSymbol) => links.some((l) => l.to === s && l.kind === "references");
  const groups: IndexedSymbol[][] = [];
  const grouped = new Set<string>();
  for (const s of [...pool].sort(rank)) {
    if (grouped.has(s.id)) continue;
    const group: IndexedSymbol[] = [];
    const queue = [s];
    grouped.add(s.id);
    while (queue.length > 0) {
      const next = queue.shift()!;
      group.push(next);
      for (const id of neighbours.get(next.id) ?? []) {
        const n = pool.find((p) => p.id === id);
        if (n && !grouped.has(id)) {
          grouped.add(id);
          queue.push(n);
        }
      }
    }
    const reaches = new Map(group.map((g) => [g.id, reach(g)] as const));
    group.sort(
      (a, b) =>
        Number(hasFields(b)) - Number(hasFields(a)) ||
        reaches.get(b.id)! - reaches.get(a.id)! ||
        Number(heldBy(a)) - Number(heldBy(b)) ||
        rank(a, b),
    );
    groups.push(group);
  }
  // the entry's group first; otherwise the largest
  const hasEntry = (g: IndexedSymbol[]) => Number(entry !== undefined && g.includes(entry));
  groups.sort((a, b) => hasEntry(b) - hasEntry(a) || b.length - a.length);

  // ── Pick the boxes, group by group: the first type, then along the links. A later group keeps room for a few.
  const picked: IndexedSymbol[] = [];
  const onMap = new Set<string>();
  const firsts: IndexedSymbol[] = [];
  const cut: IndexedSymbol[] = [];
  const apart: IndexedSymbol[][] = [];
  groups.forEach((group, i) => {
    const room = DATA_LIMITS.boxes - picked.length;
    const keep = (g: IndexedSymbol[]) => Math.min(DATA_LIMITS.group, g.length);
    if (room < keep(group)) {
      apart.push(group);
      return;
    }
    const later = groups.slice(i + 1).reduce((n, g) => n + keep(g), 0);
    const share = Math.max(keep(group), Math.min(group.length, room - later));
    const first = entry && group.includes(entry) ? entry : group[0]!;
    const mine: IndexedSymbol[] = [first];
    onMap.add(first.id);
    while (mine.length < share) {
      const linksTo = (s: IndexedSymbol) =>
        [...(neighbours.get(s.id) ?? [])].filter((id) => onMap.has(id)).length;
      // below a box first, then the most used, then the one with the most types below it
      const below = (s: IndexedSymbol) => Number(mine.some((m) => down.get(m.id)?.includes(s.id)));
      const next = group
        .filter((s) => !onMap.has(s.id) && linksTo(s) > 0)
        .sort(
          (a, b) =>
            below(b) - below(a) ||
            rank(a, b) ||
            reach(b, onMap) - reach(a, onMap) ||
            linksTo(b) - linksTo(a),
        )[0];
      if (!next) break;
      mine.push(next);
      onMap.add(next.id);
    }
    picked.push(...mine);
    firsts.push(first);
    cut.push(...group.filter((s) => !onMap.has(s.id)));
  });

  // ── Names: a short name, qualified by its package or file where two types the draft names share it.
  // the types with no fields that a box holds: their names show in its rows
  const unboxedHeld = [...unboxed.values()]
    .filter((u) => [...u.by].some((id) => onMap.has(id)))
    .map((u) => u.sym);
  const named = [...picked, ...cut, ...apart.flat(), ...unboxedHeld];
  const clash = new Set(
    named.map(shortName).filter((n, i, all) => all.indexOf(n) !== all.lastIndexOf(n)),
  );
  const nameOf = (s: IndexedSymbol) =>
    clash.has(shortName(s)) ? `${qualifier(model, s)}.${shortName(s)}` : shortName(s);
  const names = (list: readonly IndexedSymbol[]) =>
    `${list
      .map(nameOf)
      .slice(0, DATA_LIMITS.hints)
      .join(", ")}${list.length > DATA_LIMITS.hints ? ", …" : ""}`;

  if (cut.length > 0) {
    notes.push(
      `${plural(cut.length, "more linked type")} left off the map (at most ${DATA_LIMITS.boxes} boxes): ${names(cut)}`,
    );
  }
  for (const group of apart) {
    notes.push(
      `${plural(group.length, "more type")} in a group not linked to the map's types: ${names(group)} (\`xpl draft data <explainer> ${symId(group[0]!)}\` maps them)`,
    );
  }
  // types with no fields, by why they have none
  const unboxedBy = new Map<string, IndexedSymbol[]>();
  for (const s of unboxedHeld.sort(byPlace)) {
    const why = noFieldsReason(model, s);
    unboxedBy.set(why, [...(unboxedBy.get(why) ?? []), s]);
  }
  for (const [why, list] of unboxedBy) {
    const one = list.length === 1;
    notes.push(
      `${list.map(nameOf).join(", ")}: no fields, so ${one ? "it is" : "they are"} not on the map (${why}); ${one ? "its name shows" : "their names show"} as the type of the rows that hold ${one ? "it" : "them"}`,
    );
  }

  // ── Rows: the fields of each box, those that link to another box first when there are too many.
  const drawn = links.filter((l) => onMap.has(l.from.id) && onMap.has(l.to.id));
  const rowsOf = new Map<string, IndexedSymbol[]>();
  for (const type of picked) {
    const fields = fieldsOf(model, type);
    const linking = new Set(drawn.filter((l) => l.from === type && l.via).map((l) => l.via!.id));
    const rows = [
      ...fields.filter((f) => linking.has(f.id)),
      ...fields.filter((f) => !linking.has(f.id)),
    ]
      .slice(0, DATA_LIMITS.rows)
      .sort(byPlace);
    rowsOf.set(type.id, rows);
    if (fields.length > rows.length) {
      notes.push(
        `${plural(fields.length - rows.length, "field")} of ${nameOf(type)} left off its table (at most ${DATA_LIMITS.rows} rows)`,
      );
    }
  }
  for (const type of picked.filter((t) => rowsOf.get(t.id)!.length === 0)) {
    notes.push(
      `${nameOf(type)}: no fields the index knows, so its box has no rows (${noFieldsReason(model, type)})`,
    );
  }
  if (drawn.some((l) => l.heuristic)) {
    notes.push(
      "some arrows come from heuristic references: check each in the code before you explain it",
    );
  }

  // ── Summaries: what the index knows of each type.
  const tick = (list: IndexedSymbol[]) => list.map(nameOf);
  const hint = (type: IndexedSymbol): string => {
    // (its fields are on its table: the hint counts them)
    const fields = fieldsOf(model, type).length;
    const kind = kindWord(model, type);
    const parts: string[] = [fields > 0 ? `${kind}, ${plural(fields, "field")}` : kind];
    const add = (label: string, list: string[]) => {
      if (list.length > 0) parts.push(`${label} ${nameList(list, DATA_LIMITS.hints)}`);
    };
    const from = drawn.filter((l) => l.from === type);
    const into = drawn.filter((l) => l.to === type);
    add("holds", tick(from.filter((l) => l.kind === "references").map((l) => l.to)));
    add("extends", tick(from.filter((l) => l.kind === "extends").map((l) => l.to)));
    add("implements", tick(from.filter((l) => l.kind === "implements").map((l) => l.to)));
    add("held by", tick(into.filter((l) => l.kind === "references").map((l) => l.from)));
    add("extended by", tick(into.filter((l) => l.kind === "extends").map((l) => l.from)));
    add("implemented by", tick(into.filter((l) => l.kind === "implements").map((l) => l.from)));
    // a field of the type's own type draws no arrow (it would start and end on one table): say it here
    add(
      "holds its own type in",
      fieldsOf(model, type)
        .filter((f) => model.refsFrom(f.id).some((r) => r.kind === "type-ref" && r.to === type.id))
        .map(shortName),
    );
    return parts.join("; ");
  };
  /** What a type is about: what it holds, or for a type with no fields, what it promises. */
  const about = (type: IndexedSymbol) =>
    hasFields(type)
      ? "what it holds"
      : type.kind === "interface"
        ? "what it promises (its methods)"
        : "what it stands for";
  const nodes: PatchNode[] = [];
  for (const type of picked) {
    const id = symId(type);
    if (stored.has(id)) continue;
    nodes.push({
      id,
      ...(clash.has(shortName(type)) ? { label: nameOf(type) } : {}),
      summary: todo(`one plain sentence: ${about(type)} and what for (${hint(type)}).`),
    });
  }

  // ── The view.
  const slug =
    entry !== undefined
      ? kebab(shortName(entry))
      : scope.type === "repo"
        ? ""
        : kebab(baseName(scopePath).replace(/\.[^.]+$/, ""));
  const base = slug === "" ? "data" : `${slug}-data`;
  const viewId = ids.get("view", base);
  const include = picked.flatMap((type) => [symId(type), ...rowsOf.get(type.id)!.map(symId)]);

  // ── The tour: the first type, the next ones (each group's first among them) in map order, the rest of the map,
  // and where to go next.
  /** The type's lines down to its last row: its header and its fields, not its methods. */
  const head = (type: IndexedSymbol): AnchorInput | undefined => {
    const rows = rowsOf.get(type.id)!;
    const end = rows.length > 0 ? rows.at(-1)!.range.endLine : type.range.startLine;
    return symbolLines(texts, type, type.range.startLine, end, "definition");
  };
  const first = picked[0]!;
  // one step a type while they fit with the step on where to go next; else one step takes the rest of the map
  const typeSteps = picked.length <= DATA_LIMITS.steps - 1 ? picked.length : DATA_LIMITS.steps - 2;
  const stepped = new Set<IndexedSymbol>(firsts.slice(0, typeSteps));
  for (const type of picked) if (stepped.size < typeSteps) stepped.add(type);
  const steps: PatchTourStep[] = [
    tourStep(
      model,
      "t1",
      viewId,
      [symId(first)],
      note(
        todo("what data this code keeps, as a plain statement"),
        todo(
          `${about(first).replace("what it", `what ${nameOf(first)}`)} and what for, and how the other types hang on it (the big picture, in two sentences).`,
        ),
      ),
      [head(first)],
    ),
  ];
  for (const type of picked.filter((t) => t !== first && stepped.has(t))) {
    // how it joined: a field of a type before it holds it, or it holds one of them, or extends one
    const before = new Set(picked.slice(0, picked.indexOf(type)).map((s) => s.id));
    const link = drawn.find(
      (l) => (l.to === type && before.has(l.from.id)) || (l.from === type && before.has(l.to.id)),
    );
    const name = nameOf(type);
    const how = !link
      ? firsts.includes(type)
        ? " (a separate group: no field or hierarchy links it to the types before it)"
        : ""
      : link.to === type
        ? link.via
          ? ` (${nameOf(link.from)} holds it in \`${shortName(link.via)}\`)`
          : ` (${nameOf(link.from)} ${link.kind} it)`
        : link.via
          ? ` (it holds ${nameOf(link.to)} in \`${shortName(link.via)}\`)`
          : ` (it ${link.kind} ${nameOf(link.to)})`;
    const via = link?.via;
    steps.push(
      tourStep(
        model,
        `t${steps.length + 1}`,
        viewId,
        [symId(type)],
        note(
          todo(`${about(type).replace("what it", `what ${name}`)}, as a plain statement`),
          todo(`what it is for and how it links to the types before it${how}.`),
        ),
        [
          head(type),
          via && symbolLines(texts, via, via.range.startLine, via.range.endLine, "usage"),
        ],
      ),
    );
  }
  const rest = picked.filter((t) => !stepped.has(t));
  if (rest.length > 0) {
    steps.push(
      tourStep(
        model,
        `t${steps.length + 1}`,
        viewId,
        rest.map(symId),
        note(
          todo("what the rest of the map adds, as a plain statement"),
          `${todo("what these types hold, in one or two sentences.")} On the map: ${rest.map(nameOf).join(", ")}.`,
        ),
        rest.slice(0, 2).map(head),
      ),
    );
  }
  const leftOff = [...cut, ...apart.flat()];
  steps.push(
    tourStep(
      model,
      `t${steps.length + 1}`,
      viewId,
      [],
      note(
        "Where to go next",
        leftOff.length > 0
          ? `${todo("the types left off the map and what each would answer, one short sentence each.")} Left off: ${names(leftOff).replace(/(?<!…)$/, ".")}`
          : todo(
              "where the code changes this data, and what to read for it, one short sentence each (`xpl refs <field> --in --kind write` lists the writers).",
            ),
      ),
      [],
    ),
  );

  const patch: ExplainerPatch = {
    nodes,
    views: [
      {
        id: viewId,
        type: "graph",
        title: todo(
          `what data the map shows, in plain words (for example: the ${nameOf(first)} and what it holds)`,
        ),
        scope: { root: scope.id, depth: 1 },
        include,
        edgeKinds: ["references", "extends", "implements"],
        boxText: "members",
        stubs: { mode: "none" },
      },
    ],
    tours: [
      {
        id: ids.get("tour", base),
        title: todo("what the tour covers, in about 8 plain words"),
        summary: `${todo("what data this code keeps and who uses it, in plain words.")} ${todo("which type holds which, in one sentence.")}`,
        steps,
      },
    ],
  };
  return { kind: "data", patch, notes };
}
