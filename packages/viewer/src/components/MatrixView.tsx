/**
 * A map as a dependency matrix (matrix.ts): a row and a numbered column per box, and in each cell the arrows
 * from the row's box to the column's, with their count and the map's trust by fill. A last column and row,
 * "Outside this map", hold each box's lines out of the map (its stubs). GraphView shows it in place of the
 * boxes and arrows when the reader presses "Matrix" (or the view says `render: "matrix"`).
 *
 * The same two-way link as the map: a cell selects the arrow (its reference sites show in the code), a row
 * header selects the box, and the caret lights the cells and headers whose code it is in. Keyboard: one tab
 * stop; the arrow keys move between cells and headers, Home and End go to the ends of a row, Enter or Space
 * selects. The table scrolls inside its own frame, with the headers kept in sight. Its toolbar keeps the
 * map's Save image (a picture of the grid) and Text view.
 */
import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import type { DerivedEdge, DerivedGraph } from "@xpl/core";
import { useStore } from "../hooks.js";
import { saveDiagramImage } from "../image.js";
import { headOf } from "../keyMarks.js";
import { buildMatrix, type Matrix, type MatrixCell, type MatrixOutside } from "../matrix.js";
import { DiagramText } from "./DiagramText.js";

export interface MatrixViewProps {
  graph: DerivedGraph;
  /** The view's include list: the author's order where the arrows leave a choice (`boxOrder`). */
  order?: readonly string[];
  selected: ReadonlySet<string>;
  matches: ReadonlySet<string>;
  related: ReadonlySet<string>;
  /** The switch back to boxes and arrows, shown in the matrix's own toolbar. */
  toggle: ReactNode;
  /** The name of a saved image (the view's title). */
  imageName: string;
}

/** Plain words for a cell's trust label (the map says the same with its arrow's dash). */
const TRUST: Record<DerivedEdge["resolution"], string> = {
  precise: "precise (checked by a language tool)",
  heuristic: "heuristic (matched by name)",
  mixed: "partly matched by name",
  llm: "added by the author",
  user: "your edit",
  static: "found in the code",
};

/**
 * The matrix's key: a cell's fill says its trust, never its colour alone (DECISIONS D5). Solid is found in the
 * code, stripes are matched by name (the map's dash), long stripes are partly matched, an outline is added by
 * the author, a dotted outline leads outside the map. The words are the map's key line's.
 */
const KEY: { key: string; res: string[]; words: string }[] = [
  { key: "found", res: ["precise", "static"], words: "found in the code" },
  { key: "heuristic", res: ["heuristic"], words: "matched by name" },
  { key: "mixed", res: ["mixed"], words: "partly matched by name" },
  { key: "authored", res: ["llm"], words: "added by the author, checked against the code" },
  { key: "user", res: ["user"], words: "your edit" },
  { key: "outside", res: ["outside"], words: "leads outside this map" },
];

/** A cell's kinds by the head the map draws them with: filled for calls, hollow for extends, open for imports. */
const HEAD_GLYPH = { filled: "▸", hollow: "▹", open: "›" } as const;
const glyphs = (kinds: readonly string[]) => [
  ...new Set(kinds.map((kind) => HEAD_GLYPH[headOf(kind)])),
];

interface Pos {
  /** -1: the column headers; `boxes.length`: the Outside row. */
  r: number;
  /** -1: the row headers; `boxes.length`: the Outside column. */
  c: number;
}

export function MatrixView({
  graph,
  order,
  selected,
  matches,
  related,
  toggle,
  imageName,
}: MatrixViewProps) {
  const store = useStore();
  const matrix = useMemo(() => buildMatrix(graph, order), [graph, order]);
  const { boxes, cells } = matrix;
  const n = boxes.length;
  const outCol = matrix.out.some(Boolean);
  const inRow = matrix.in.some(Boolean);
  const lastR = inRow ? n : n - 1;
  const lastC = outCol ? n : n - 1;
  const table = useRef<HTMLTableElement>(null);
  // The one tab stop of the grid: the first arrow, else the first row header.
  const [pos, setPos] = useState<Pos>(() => firstCell(cells));
  const [hot, setHot] = useState<Pos>();
  const [textMode, setTextMode] = useState(false);
  // On a phone the key's words fold behind a "Key" button, so the grid gets the frame (V4-07); wider, they
  // always show and the button is not drawn (styles.css).
  const [keyOpen, setKeyOpen] = useState(false);
  const keyId = useId();
  const [saving, setSaving] = useState(false);
  const textId = useId();
  const at = { r: Math.min(pos.r, lastR), c: Math.min(pos.c, lastC) };
  const filled = cells.flat().filter((cell): cell is MatrixCell => cell !== undefined);
  const used = new Set<string>(filled.map((cell) => cell.resolution));
  if (outCol || inRow) used.add("outside");
  const key = KEY.filter((item) => item.res.some((res) => used.has(res)));
  const anyBack = filled.some((cell) => cell.back);
  // a data map: its rows are tables, its numbers fields (matrix.ts folds the fields into their tables)
  const tables = graph.nodes.some((node) => node.rows);
  const anyAuthored = filled.some((cell) => cell.authored);
  // the kinds by their heads, keyed only when the grid holds more than one head
  const heads = new Map<string, string[]>();
  for (const cell of filled.filter((cell) => !cell.authored))
    for (const kind of cell.kinds) {
      const glyph = HEAD_GLYPH[headOf(kind)];
      const list = heads.get(glyph) ?? [];
      if (!list.includes(kind)) heads.set(glyph, [...list, kind]);
    }
  const showKinds = heads.size > 1;

  // The box the reader picked, or the header under the pointer: its row and column stay lit, the rest steps back.
  // (the selection holds a picked arrow's ends as related boxes: those are not picked)
  const picked = boxes.findIndex((box) => selected.has(box.id) && !related.has(box.id));
  const line: Pos | undefined =
    hot && (hot.r === -1 || hot.c === -1)
      ? hot
      : picked >= 0
        ? { r: picked, c: picked }
        : undefined;
  const inLine = (p: Pos) =>
    line !== undefined && ((line.r >= 0 && p.r === line.r) || (line.c >= 0 && p.c === line.c));

  const isOn = (ids: readonly string[], set: ReadonlySet<string>) => ids.some((id) => set.has(id));
  const cellState = (ids: readonly string[], select: readonly string[], p: Pos) =>
    (isOn(select, selected) ? " is-selected" : "") +
    (isOn(ids, matches) ? " is-match" : "") +
    (isOn(ids, related) ? " is-related" : "") +
    (inLine(p) ? " in-line" : "");
  const boxState = (id: string) =>
    (selected.has(id) && !related.has(id) ? " is-selected" : "") +
    (matches.has(id) ? " is-match" : "") +
    (related.has(id) ? " is-related" : "");

  // The caret or a selection made elsewhere scrolls its first cell into the frame.
  const lit = [...selected, ...matches].join("\n");
  useLayoutEffect(() => {
    const first = table.current?.querySelector(".is-selected, .is-match");
    first?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [lit]);

  const selectBox = (id: string, additive: boolean) => store.click(id, additive);
  const selectIds = (ids: readonly string[], additive: boolean) => {
    if (additive) for (const id of ids) store.click(id, true);
    else store.select([...ids]);
  };
  const outsideAt = ({ r, c }: Pos): MatrixOutside | undefined =>
    c === n && r >= 0 && r < n
      ? matrix.out[r]
      : r === n && c >= 0 && c < n
        ? matrix.in[c]
        : undefined;
  const activate = (p: Pos, additive: boolean) => {
    const { r, c } = p;
    if (r === -1 && c >= 0 && c < n) selectBox(boxes[c]!.id, additive);
    else if (c === -1 && r >= 0 && r < n) selectBox(boxes[r]!.id, additive);
    else if (r >= 0 && c >= 0 && r < n && c < n && cells[r]![c])
      selectIds(cells[r]![c]!.select, additive);
    else {
      const outside = outsideAt(p);
      if (outside) selectIds(outside.select, additive);
    }
  };

  const focusAt = (next: Pos) => {
    setPos(next);
    table.current
      ?.querySelector<HTMLElement>(`[data-r="${next.r}"][data-c="${next.c}"]`)
      ?.focus({ preventScroll: false });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-r]");
    if (!el) return;
    const here = { r: Number(el.dataset.r), c: Number(el.dataset.c) };
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate(here, event.shiftKey || event.metaKey || event.ctrlKey);
      return;
    }
    const move: Record<string, Pos> = {
      ArrowUp: { r: here.r - 1, c: here.c },
      ArrowDown: { r: here.r + 1, c: here.c },
      ArrowLeft: { r: here.r, c: here.c - 1 },
      ArrowRight: { r: here.r, c: here.c + 1 },
      Home: { r: here.r, c: -1 },
      End: { r: here.r, c: lastC },
    };
    const next = move[event.key];
    if (!next) return;
    event.preventDefault();
    const clamped = { r: clamp(next.r, -1, lastR), c: clamp(next.c, -1, lastC) };
    // (the corner above the row headers holds nothing, nor does the corner of the two Outside lines)
    if (clamped.r === -1 && clamped.c === -1) return;
    if (clamped.r === n && clamped.c === n) return;
    focusAt(clamped);
  };

  const tab = (p: Pos) => (p.r === at.r && p.c === at.c ? 0 : -1);
  const hotClass = (p: Pos) =>
    hot && ((p.r === -1 && p.c === hot.c) || (p.c === -1 && p.r === hot.r)) ? " is-hot" : "";
  const track = (p: Pos) => ({
    onFocus: () => {
      setPos(p);
      setHot(p);
    },
    onMouseEnter: () => setHot(p),
  });

  // Save image: the grid is HTML; a plain SVG picture of it (MatrixPicture) is drawn for the moment it takes.
  const picture = useRef<SVGGElement>(null);
  const size = pictureSize(matrix, outCol, inRow);
  useEffect(() => {
    if (!saving || !picture.current) return;
    void saveDiagramImage(picture.current, size.width, size.height, imageName).finally(() =>
      setSaving(false),
    );
  }, [saving, size.width, size.height, imageName]);

  const big = n + (outCol ? 1 : 0) > 14 ? "s" : n > 8 ? "m" : "l";
  const digits = Math.max(1, ...filled.map((cell) => String(cell.count).length));

  let lastGroup: string | undefined;
  return (
    <div className="matrix" data-testid="matrix">
      <div className="matrix-bar">
        <p id={keyId} className="matrix-key" data-folded={keyOpen ? undefined : ""}>
          Read across: a row&rsquo;s arrows go to the numbered columns.{" "}
          {tables
            ? "A number counts the fields that hold the column's type"
            : "A number counts the code links"}
          {anyAuthored ? "; • marks an arrow the author added" : ""}. The grey diagonal is each box
          against itself.{" "}
          {anyBack && (
            <span className="matrix-key-back">
              <span className="matrix-swatch is-back-swatch" aria-hidden="true" /> A flagged cell
              goes back up the list; if its mirror cell is filled too, the two boxes use each other.
            </span>
          )}
          {(key.length > 0 || showKinds) && (
            <span className="matrix-key-items" data-testid="matrix-key">
              {key.map((item) => (
                <span key={item.key} className="matrix-key-item" data-key-item={item.key}>
                  <span className={`matrix-swatch res-${item.res[0]}`} aria-hidden="true" />
                  {item.words}
                </span>
              ))}
              {showKinds &&
                [...heads].map(([glyph, kinds]) => (
                  <span key={glyph} className="matrix-key-item" data-key-item={`kind-${kinds[0]}`}>
                    <span className="matrix-kind" aria-hidden="true">
                      {glyph}
                    </span>
                    {kinds.join(", ")}
                  </span>
                ))}
            </span>
          )}
        </p>
        <div className="matrix-tools">
          {toggle}
          <button
            type="button"
            className="matrix-key-button"
            aria-expanded={keyOpen}
            aria-controls={keyId}
            title="How to read the matrix"
            onClick={() => setKeyOpen((open) => !open)}
          >
            Key
          </button>
          <button
            type="button"
            title="Save the whole matrix as a PNG image"
            onClick={() => setSaving(true)}
          >
            Save image
          </button>
          <button
            type="button"
            aria-pressed={textMode}
            aria-controls={textId}
            onClick={() => setTextMode((shown) => !shown)}
          >
            Text view
          </button>
        </div>
      </div>
      {textMode ? (
        <div
          id={textId}
          className="diagram-text-view matrix-text"
          role="region"
          aria-label="Diagram as text"
        >
          <DiagramText graph={graph} order={order} />
        </div>
      ) : (
        <div className="matrix-scroll" onMouseLeave={() => setHot(undefined)}>
          <table
            ref={table}
            className={`matrix-grid size-${big}${line ? " has-line" : ""}`}
            style={{ ["--matrix-digits" as string]: digits }}
            role="grid"
            aria-label="Dependency matrix: each row's arrows go to the boxes in its columns"
            onKeyDown={onKeyDown}
          >
            <thead>
              <tr>
                <td className="matrix-corner" aria-hidden="true" />
                {boxes.map((box, c) => (
                  <th
                    key={box.id}
                    scope="col"
                    role="columnheader"
                    className={"matrix-col" + boxState(box.id) + hotClass({ r: -1, c })}
                    data-column-for={box.id}
                    data-r={-1}
                    data-c={c}
                    tabIndex={tab({ r: -1, c })}
                    title={nameOf(box)}
                    aria-label={`${c + 1}: ${nameOf(box)}`}
                    onClick={(event) => selectBox(box.id, event.shiftKey || event.metaKey)}
                    {...track({ r: -1, c })}
                  >
                    {c + 1}
                  </th>
                ))}
                {outCol && (
                  <th
                    scope="col"
                    role="columnheader"
                    className={"matrix-col is-outside-head" + hotClass({ r: -1, c: n })}
                    data-r={-1}
                    data-c={n}
                    tabIndex={tab({ r: -1, c: n })}
                    title="Outside this map: what each box uses that the map does not draw"
                    aria-label="Outside this map"
                    {...track({ r: -1, c: n })}
                  >
                    Out
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {boxes.map((row, r) => {
                const band =
                  row.group !== undefined && row.group !== lastGroup ? row.group : undefined;
                lastGroup = row.group;
                return (
                  <Fragment key={row.id}>
                    {band !== undefined && (
                      <tr className="matrix-group" aria-hidden="true">
                        <th colSpan={n + (outCol ? 2 : 1)}>
                          <span>{band}</span>
                        </th>
                      </tr>
                    )}
                    <tr>
                      <th
                        scope="row"
                        role="rowheader"
                        className={
                          "matrix-row" +
                          (row.group !== undefined ? " in-group" : "") +
                          boxState(row.id) +
                          hotClass({ r, c: -1 })
                        }
                        data-element-id={row.id}
                        data-r={r}
                        data-c={-1}
                        tabIndex={tab({ r, c: -1 })}
                        title={nameOf(row)}
                        aria-label={`${r + 1}: ${nameOf(row)}`}
                        onClick={(event) => selectBox(row.id, event.shiftKey || event.metaKey)}
                        {...track({ r, c: -1 })}
                      >
                        <span className="matrix-num">{r + 1}</span>
                        <span className="matrix-label">{row.label}</span>
                      </th>
                      {boxes.map((col, c) => {
                        const cell = cells[r]![c];
                        const p = { r, c };
                        if (!cell)
                          return (
                            <td
                              key={col.id}
                              role="gridcell"
                              className={
                                "matrix-cell" +
                                (r === c ? " is-diagonal" : r > c ? " is-below" : "")
                              }
                              data-r={r}
                              data-c={c}
                              tabIndex={tab(p)}
                              aria-label={
                                r === c ? row.label : `No arrow from ${row.label} to ${col.label}`
                              }
                              {...track(p)}
                            />
                          );
                        const name = cellName(row.label, col.label, cell);
                        return (
                          <td
                            key={col.id}
                            role="gridcell"
                            className={
                              `matrix-cell has-arrow res-${cell.resolution}` +
                              (cell.back ? " is-back" : "") +
                              cellState(cell.ids, cell.select, p)
                            }
                            data-element-id={cell.select[0]}
                            data-r={r}
                            data-c={c}
                            tabIndex={tab(p)}
                            title={name}
                            aria-label={name}
                            aria-selected={isOn(cell.select, selected)}
                            onClick={(event) =>
                              selectIds(cell.select, event.shiftKey || event.metaKey)
                            }
                            {...track(p)}
                          >
                            {cell.authored ? "•" : cell.count}
                            {showKinds && !cell.authored && (
                              <span className="matrix-kind" aria-hidden="true">
                                {glyphs(cell.kinds).join("")}
                              </span>
                            )}
                          </td>
                        );
                      })}
                      {outCol && (
                        <OutsideCell
                          outside={matrix.out[r]}
                          p={{ r, c: n }}
                          name={(text) => `${row.label} → outside this map: ${text}`}
                          state={(o, p) => cellState(o.select, o.select, p)}
                          selected={selected}
                          tabIndex={tab({ r, c: n })}
                          onSelect={selectIds}
                          track={track}
                        />
                      )}
                    </tr>
                  </Fragment>
                );
              })}
              {inRow && (
                <tr>
                  <th
                    scope="row"
                    role="rowheader"
                    className={"matrix-row is-outside-head" + hotClass({ r: n, c: -1 })}
                    data-r={n}
                    data-c={-1}
                    tabIndex={tab({ r: n, c: -1 })}
                    title="Outside this map: what uses each box from code the map does not draw"
                    {...track({ r: n, c: -1 })}
                  >
                    <span className="matrix-label">Outside this map</span>
                  </th>
                  {boxes.map((col, c) => (
                    <OutsideCell
                      key={col.id}
                      outside={matrix.in[c]}
                      p={{ r: n, c }}
                      name={(text) => `Outside this map → ${col.label}: ${text}`}
                      state={(o, p) => cellState(o.select, o.select, p)}
                      selected={selected}
                      tabIndex={tab({ r: n, c })}
                      onSelect={selectIds}
                      track={track}
                    />
                  ))}
                  {outCol && <td className="matrix-cell is-diagonal" aria-hidden="true" />}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {saving && (
        <svg className="matrix-picture" width={0} height={0} aria-hidden="true">
          <MatrixPicture ref={picture} matrix={matrix} outCol={outCol} inRow={inRow} />
        </svg>
      )}
    </div>
  );
}

function OutsideCell({
  outside,
  p,
  name,
  state,
  selected,
  tabIndex,
  onSelect,
  track,
}: {
  outside: MatrixOutside | undefined;
  p: Pos;
  name: (text: string) => string;
  state: (outside: MatrixOutside, p: Pos) => string;
  selected: ReadonlySet<string>;
  tabIndex: number;
  onSelect: (ids: readonly string[], additive: boolean) => void;
  track: (p: Pos) => object;
}) {
  if (!outside)
    return (
      <td
        role="gridcell"
        className="matrix-cell is-outside"
        data-r={p.r}
        data-c={p.c}
        tabIndex={tabIndex}
        aria-label={name("nothing")}
        {...track(p)}
      />
    );
  const label = name(outside.text);
  return (
    <td
      role="gridcell"
      className={"matrix-cell is-outside has-arrow res-outside" + state(outside, p)}
      data-element-id={outside.select[0]}
      data-r={p.r}
      data-c={p.c}
      tabIndex={tabIndex}
      title={label}
      aria-label={label}
      aria-selected={outside.select.some((id) => selected.has(id))}
      onClick={(event) => onSelect(outside.select, event.shiftKey || event.metaKey)}
      {...track(p)}
    >
      {outside.count}
    </td>
  );
}

/** "CLI → Indexer: imports ×214. heuristic (matched by name)": the map's own words, with the count. */
function cellName(from: string, to: string, cell: MatrixCell): string {
  // (the words of the cell already count, or name the fields it counts)
  const count =
    cell.authored || cell.fields || cell.text.includes("×")
      ? ""
      : ` (${cell.kinds.join(" & ")} ×${cell.count})`;
  return (
    `${from} → ${to}: ${cell.text}${count}. ${TRUST[cell.resolution]}` +
    (cell.back ? ". Goes back up the list" : "")
  );
}

const nameOf = (box: { label: string; group?: string }) =>
  box.group ? `${box.label} (in ${box.group})` : box.label;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function firstCell(cells: readonly (MatrixCell | undefined)[][]): Pos {
  for (let r = 0; r < cells.length; r++) {
    const c = cells[r]!.findIndex(Boolean);
    if (c >= 0) return { r, c };
  }
  return { r: 0, c: -1 };
}

// ── Save image: the grid as an SVG picture ─────────────────────────────────────────────────────────────

const PIC_CELL = 30;
const PIC_HEAD = 28;

function pictureSize(matrix: Matrix, outCol: boolean, inRow: boolean) {
  const longest = Math.max(16, ...matrix.boxes.map((box) => box.label.length));
  const head = Math.min(260, 40 + longest * 7.2);
  const cols = matrix.boxes.length + (outCol ? 1 : 0);
  const rows = matrix.boxes.length + (inRow ? 1 : 0);
  return { head, width: head + cols * PIC_CELL, height: PIC_HEAD + rows * PIC_CELL };
}

/**
 * The matrix as plain SVG shapes for `saveDiagramImage`, which copies their computed paint: trust by the
 * map's own marks (a solid fill, a dashed or dash-dot outline for matched by name, an outline for the
 * author's arrow, a dotted one outside the map), back cells by their corner flag.
 */
const MatrixPicture = ({
  ref,
  matrix,
  outCol,
  inRow,
}: {
  ref: Ref<SVGGElement>;
  matrix: Matrix;
  outCol: boolean;
  inRow: boolean;
}) => {
  const { head } = pictureSize(matrix, outCol, inRow);
  const n = matrix.boxes.length;
  const x = (c: number) => head + c * PIC_CELL;
  const y = (r: number) => PIC_HEAD + r * PIC_CELL;
  const shape = (key: string, r: number, c: number, cls: string, text: string, back = false) => (
    <g key={key}>
      <rect className={cls} x={x(c) + 1} y={y(r) + 1} width={PIC_CELL - 2} height={PIC_CELL - 2} />
      {text && (
        <text className="mx-pic-text" x={x(c) + PIC_CELL / 2} y={y(r) + PIC_CELL / 2 + 4}>
          {text}
        </text>
      )}
      {back && <path className="mx-pic-back" d={`M${x(c) + PIC_CELL - 10} ${y(r) + 1}h9v9z`} />}
    </g>
  );
  const labels = [...matrix.boxes.map((box, i) => `${i + 1}  ${box.label}`)];
  if (inRow) labels.push("Outside this map");
  return (
    <g ref={ref} className="mx-pic">
      {matrix.boxes.map((_, c) => (
        <text key={`h${c}`} className="mx-pic-head" x={x(c) + PIC_CELL / 2} y={PIC_HEAD - 9}>
          {c + 1}
        </text>
      ))}
      {outCol && (
        <text className="mx-pic-head" x={x(n) + PIC_CELL / 2} y={PIC_HEAD - 9}>
          Out
        </text>
      )}
      {labels.map((label, r) => (
        <text key={`r${r}`} className="mx-pic-label" x={4} y={y(r) + PIC_CELL / 2 + 4}>
          {label.length > 34 ? `${label.slice(0, 33)}…` : label}
        </text>
      ))}
      {matrix.cells.flatMap((row, r) =>
        row.map((cell, c) =>
          r === c
            ? shape(`${r}.${c}`, r, c, "mx-pic-diagonal", "")
            : cell
              ? shape(
                  `${r}.${c}`,
                  r,
                  c,
                  `mx-pic-cell res-${cell.resolution}`,
                  cell.authored ? "•" : String(cell.count),
                  cell.back,
                )
              : shape(`${r}.${c}`, r, c, "mx-pic-empty", ""),
        ),
      )}
      {outCol &&
        matrix.out.map((o, r) =>
          shape(
            `o${r}`,
            r,
            n,
            o ? "mx-pic-cell res-outside" : "mx-pic-empty",
            o ? String(o.count) : "",
          ),
        )}
      {inRow &&
        matrix.in.map((o, c) =>
          shape(
            `i${c}`,
            n,
            c,
            o ? "mx-pic-cell res-outside" : "mx-pic-empty",
            o ? String(o.count) : "",
          ),
        )}
    </g>
  );
};
