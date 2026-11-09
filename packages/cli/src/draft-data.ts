/**
 * `xpl draft data`: what data the code keeps and how its types relate. One data-model map (`view:<slug>-data`,
 * `boxText: "members"`): a table per type (class, interface, type, enum), a row per field the index knows, and
 * arrows from a field to the type it holds (`references`) and from a type to what it extends or implements.
 *
 * Which types: those of the scope (the repo, a folder or a file; tests, examples, docs and fixtures left out) that
 * hold or are held by another one. The draft starts at the most used of them and grows along the links: each next
 * box is the type with the most links to the boxes already picked (then the most used), at most 8 boxes and 8 rows a
 * box. A type entry (`sym:`) starts there instead, and only types linked to it (two links away at most) join. Each
 * box gets a summary TODO with what the index knows (its kind, fields, what it holds and what holds it). A tour:
 * the first type, the next types in the order they joined, and a last step on the rest of the map.
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
import { plural } from "./format.js";
import type { Target } from "./target.js";

export const DATA_LIMITS = {
  /** Boxes (types) on the map. */
  boxes: 8,
  /** Rows (fields) a box. */
  rows: 8,
  /** Tour steps. */
  steps: 5,
  /** Links from a type entry: the types this many links away join. */
  reach: 2,
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
  const links: Link[] = [];
  for (const type of entry ? [...candidates, entry] : candidates) {
    for (const from of [type, ...fieldsOf(model, type)]) {
      for (const ref of model.refsFrom(from.id)) {
        const kind = LINK_KINDS[ref.kind as keyof typeof LINK_KINDS];
        if (!kind || (kind === "references") === (from === type)) continue;
        const to = model.symbol(ref.to);
        if (!to || to.id === type.id || !isCandidate.has(to.id)) continue;
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
  const neighbours = new Map<string, Set<string>>();
  for (const link of links) {
    for (const [a, b] of [
      [link.from.id, link.to.id],
      [link.to.id, link.from.id],
    ] as const) {
      neighbours.set(a, (neighbours.get(a) ?? new Set()).add(b));
    }
  }
  // how much the code outside tests uses each type
  const uses = (sym: IndexedSymbol) =>
    model.refsTo(sym.id).filter((ref) => !isTestFile(model.fileOfSymbolId(ref.from) ?? "")).length;
  const symbolById = new Map(
    [...candidates, ...(entry ? [entry] : [])].map((s) => [s.id, s] as const),
  );

  let pool = [...symbolById.values()].filter((s) => neighbours.has(s.id));
  if (entry) {
    // the types a few links from the entry
    const near = new Set([entry.id]);
    let level = [entry.id];
    for (let step = 0; step < DATA_LIMITS.reach; step++) {
      level = level.flatMap((id) => [...(neighbours.get(id) ?? [])]).filter((id) => !near.has(id));
      for (const id of level) near.add(id);
    }
    pool = pool.filter((s) => near.has(s.id));
    if (!neighbours.has(entry.id)) {
      throw new Error(
        `${scope.id} holds no other type in its fields, and no type holds it, extends it or implements it: there is no data model to draw (\`xpl outline --under ${scope.id}\` lists its fields)`,
      );
    }
  }
  if (pool.length === 0) {
    const where = scope.type === "repo" ? "the repository" : scope.id;
    throw new Error(
      `no type in ${where} holds another one in a field, extends one or implements one: there is no data model to draw (\`xpl outline --kind class,interface,type\` lists the types)`,
    );
  }

  // ── Pick the boxes: the most used type (or the entry), then along the links.
  const used = new Map(pool.map((s) => [s.id, uses(s)] as const));
  const rank = (a: IndexedSymbol, b: IndexedSymbol) =>
    used.get(b.id)! - used.get(a.id)! || byPlace(a, b);
  const picked: IndexedSymbol[] = [entry ?? [...pool].sort(rank)[0]!];
  const onMap = new Set(picked.map((s) => s.id));
  while (picked.length < DATA_LIMITS.boxes) {
    const linksTo = (s: IndexedSymbol) =>
      [...(neighbours.get(s.id) ?? [])].filter((id) => onMap.has(id)).length;
    const next = pool
      .filter((s) => !onMap.has(s.id) && linksTo(s) > 0)
      .sort((a, b) => linksTo(b) - linksTo(a) || rank(a, b))[0];
    if (!next) break;
    picked.push(next);
    onMap.add(next.id);
  }
  const left = pool.filter((s) => !onMap.has(s.id) && neighbours.get(s.id)!.size > 0);
  if (left.length > 0) {
    notes.push(
      `${plural(left.length, "more linked type")} left off the map (at most ${DATA_LIMITS.boxes} boxes): ${left
        .map((s) => s.path)
        .slice(0, DATA_LIMITS.hints)
        .join(", ")}${left.length > DATA_LIMITS.hints ? ", …" : ""}`,
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
        `${plural(fields.length - rows.length, "field")} of ${type.path} left off its table (at most ${DATA_LIMITS.rows} rows)`,
      );
    }
  }
  const empty = picked.filter((t) => rowsOf.get(t.id)!.length === 0).map((t) => t.path);
  if (empty.length > 0) {
    notes.push(
      `${empty.join(", ")}: no fields the index knows, so ${empty.length === 1 ? "its box has" : "their boxes have"} no rows (a Python attribute set inside a method is not a field)`,
    );
  }
  if (drawn.some((l) => l.heuristic)) {
    notes.push(
      "some arrows come from heuristic references: check each in the code before you explain it",
    );
  }

  // ── Summaries: what the index knows of each type.
  const hint = (type: IndexedSymbol): string => {
    // (its fields are on its table: the hint counts them)
    const fields = fieldsOf(model, type).length;
    const parts: string[] = [fields > 0 ? `${type.kind}, ${plural(fields, "field")}` : type.kind];
    const add = (label: string, names: string[]) => {
      if (names.length > 0) parts.push(`${label} ${nameList(names, DATA_LIMITS.hints)}`);
    };
    const out = drawn.filter((l) => l.from === type);
    const into = drawn.filter((l) => l.to === type);
    add(
      "holds",
      out.filter((l) => l.kind === "references").map((l) => shortName(l.to)),
    );
    add(
      "extends",
      out.filter((l) => l.kind === "extends").map((l) => shortName(l.to)),
    );
    add(
      "implements",
      out.filter((l) => l.kind === "implements").map((l) => shortName(l.to)),
    );
    add(
      "held by",
      into.filter((l) => l.kind === "references").map((l) => shortName(l.from)),
    );
    // a field of the type's own type draws no arrow (it would start and end on one table): say it here
    add(
      "holds its own type in",
      fieldsOf(model, type)
        .filter((f) => model.refsFrom(f.id).some((r) => r.kind === "type-ref" && r.to === type.id))
        .map(shortName),
    );
    return parts.join("; ");
  };
  const nodes: PatchNode[] = [];
  for (const type of picked) {
    const id = symId(type);
    if (stored.has(id)) continue;
    nodes.push({
      id,
      summary: todo(`one plain sentence: what it holds and what for (${hint(type)}).`),
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

  // ── The tour: the first type, the next ones in the order they joined, then the rest of the map.
  /** The type's lines down to its last row: its header and its fields, not its methods. */
  const head = (type: IndexedSymbol): AnchorInput | undefined => {
    const rows = rowsOf.get(type.id)!;
    const end = rows.length > 0 ? rows.at(-1)!.range.endLine : type.range.startLine;
    return symbolLines(texts, type, type.range.startLine, end, "definition");
  };
  const first = picked[0]!;
  const steps: PatchTourStep[] = [
    tourStep(
      model,
      "t1",
      viewId,
      [symId(first)],
      note(
        todo("what data this code keeps, as a plain statement"),
        todo(
          `what ${shortName(first)} holds and what for, and how the other types hang on it (the big picture, in two sentences).`,
        ),
      ),
      [head(first)],
    ),
  ];
  const stepped = picked.slice(1, DATA_LIMITS.steps - 1);
  for (const type of stepped) {
    // how it joined: a field of a type before it holds it, or it holds one of them, or extends one
    const before = new Set(picked.slice(0, picked.indexOf(type)).map((s) => s.id));
    const link = drawn.find(
      (l) => (l.to === type && before.has(l.from.id)) || (l.from === type && before.has(l.to.id)),
    );
    const name = shortName(type);
    const how = !link
      ? ""
      : link.to === type
        ? link.via
          ? ` (${shortName(link.from)} holds it in \`${shortName(link.via)}\`)`
          : ` (${shortName(link.from)} ${link.kind} it)`
        : link.via
          ? ` (it holds ${shortName(link.to)} in \`${shortName(link.via)}\`)`
          : ` (it ${link.kind} ${shortName(link.to)})`;
    const via = link?.via;
    steps.push(
      tourStep(
        model,
        `t${steps.length + 1}`,
        viewId,
        [symId(type)],
        note(
          todo(`what ${name} holds, as a plain statement`),
          todo(`what it is for and how it links to the types before it${how}.`),
        ),
        [
          head(type),
          via && symbolLines(texts, via, via.range.startLine, via.range.endLine, "usage"),
        ],
      ),
    );
  }
  const rest = picked.slice(1 + stepped.length);
  if (rest.length > 0) {
    steps.push(
      tourStep(
        model,
        `t${steps.length + 1}`,
        viewId,
        rest.map(symId),
        note(
          todo("what the rest of the map adds, as a plain statement"),
          `${todo("what these types hold, in one or two sentences, and where to read next.")} On the map: ${rest
            .map((s) => s.path)
            .join(", ")}.`,
        ),
        rest.slice(0, 2).map(head),
      ),
    );
  }

  const patch: ExplainerPatch = {
    nodes,
    views: [
      {
        id: viewId,
        type: "graph",
        title: todo(
          `what data the map shows, in plain words (for example: the ${shortName(first)} and what it holds)`,
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
