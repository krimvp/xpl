/**
 * A map as a dependency matrix (matrix.ts): a row and a numbered column per box, and in each cell the arrows
 * from the row's box to the column's, with their count and the map's trust colour. GraphView shows it in
 * place of the boxes and arrows when the reader presses "Matrix" (or the view says `render: "matrix"`).
 *
 * The same two-way link as the map: a cell selects the arrow (its reference sites show in the code), a row
 * header selects the box, and the caret lights the cells and headers whose code it is in. Keyboard: one tab
 * stop; the arrow keys move between cells and headers, Home and End go to the ends of a row, Enter or Space
 * selects. The table scrolls inside its own frame, with the headers kept in sight.
 */
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { DerivedEdge, DerivedGraph } from "@xpl/core";
import { useStore } from "../hooks.js";
import { buildMatrix, type MatrixCell } from "../matrix.js";

export interface MatrixViewProps {
  graph: DerivedGraph;
  selected: ReadonlySet<string>;
  matches: ReadonlySet<string>;
  related: ReadonlySet<string>;
  /** The switch back to boxes and arrows, shown in the matrix's own toolbar. */
  toggle: ReactNode;
}

/** Plain words for a cell's trust label (the map says the same with its arrow's dash). */
const TRUST: Record<DerivedEdge["resolution"], string> = {
  precise: "precise (checked by a language tool)",
  heuristic: "heuristic (matched by name)",
  mixed: "part precise, part heuristic",
  llm: "added by the author",
  user: "your edit",
  static: "found in the code",
};

/**
 * The matrix's key: a cell's fill says its trust, never its colour alone (DECISIONS D5). Solid is found in the
 * code, stripes are matched by name (the map's dash), long stripes are partly matched, an outline is added by
 * the author. The words are the map's key line's.
 */
const KEY: { key: string; res: DerivedEdge["resolution"][]; words: string }[] = [
  { key: "found", res: ["precise", "static"], words: "found in the code" },
  { key: "heuristic", res: ["heuristic"], words: "matched by name" },
  { key: "mixed", res: ["mixed"], words: "partly matched by name" },
  { key: "authored", res: ["llm"], words: "added by the author, checked against the code" },
  { key: "user", res: ["user"], words: "your edit" },
];

interface Pos {
  /** -1: the column headers. */
  r: number;
  /** -1: the row headers. */
  c: number;
}

export function MatrixView({ graph, selected, matches, related, toggle }: MatrixViewProps) {
  const store = useStore();
  const { boxes, cells } = useMemo(() => buildMatrix(graph), [graph]);
  const n = boxes.length;
  const table = useRef<HTMLTableElement>(null);
  // The one tab stop of the grid: the first arrow, else the first row header.
  const [pos, setPos] = useState<Pos>(() => firstCell(cells));
  const [hot, setHot] = useState<Pos>();
  const at = { r: Math.min(pos.r, n - 1), c: Math.min(pos.c, n - 1) };
  const used = new Set(cells.flat().map((cell) => cell?.resolution));
  const key = KEY.filter((item) => item.res.some((res) => used.has(res)));

  const isOn = (cell: MatrixCell, set: ReadonlySet<string>) => cell.ids.some((id) => set.has(id));
  const cellState = (cell: MatrixCell) =>
    (cell.select.some((id) => selected.has(id)) ? " is-selected" : "") +
    (isOn(cell, matches) ? " is-match" : "") +
    (isOn(cell, related) ? " is-related" : "");
  const boxState = (id: string) =>
    (selected.has(id) ? " is-selected" : "") +
    (matches.has(id) ? " is-match" : "") +
    (related.has(id) ? " is-related" : "");

  // The caret or a selection made elsewhere scrolls its first cell into the frame.
  const lit = [...selected, ...matches].join("\n");
  useLayoutEffect(() => {
    const first = table.current?.querySelector(".is-selected, .is-match");
    first?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [lit]);

  const selectBox = (id: string, additive: boolean) => store.click(id, additive);
  const selectCell = (cell: MatrixCell, additive: boolean) => {
    if (additive) for (const id of cell.select) store.click(id, true);
    else store.select(cell.select);
  };
  const activate = ({ r, c }: Pos, additive: boolean) => {
    if (r === -1 && c >= 0) selectBox(boxes[c]!.id, additive);
    else if (c === -1 && r >= 0) selectBox(boxes[r]!.id, additive);
    else if (r >= 0 && c >= 0 && cells[r]![c]) selectCell(cells[r]![c]!, additive);
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
      End: { r: here.r, c: n - 1 },
    };
    const next = move[event.key];
    if (!next) return;
    event.preventDefault();
    const clamped = { r: clamp(next.r, -1, n - 1), c: clamp(next.c, -1, n - 1) };
    // (the corner above the row headers holds nothing)
    if (clamped.r === -1 && clamped.c === -1) return;
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

  return (
    <div className="matrix" data-testid="matrix">
      <div className="matrix-bar">
        <p className="matrix-key">
          Each row uses the numbered columns. A number counts the references.{" "}
          <span className="matrix-key-back">Below the diagonal</span>: an arrow back up the order;
          with its mirror cell, a cycle.
          {key.length > 0 && (
            <span className="matrix-key-items" data-testid="matrix-key">
              {key.map((item) => (
                <span key={item.key} className="matrix-key-item" data-key-item={item.key}>
                  <span className={`matrix-swatch res-${item.res[0]}`} aria-hidden="true" />
                  {item.words}
                </span>
              ))}
            </span>
          )}
        </p>
        <div className="matrix-tools">{toggle}</div>
      </div>
      <div className="matrix-scroll" onMouseLeave={() => setHot(undefined)}>
        <table
          ref={table}
          className="matrix-grid"
          role="grid"
          aria-label="Dependency matrix: each row uses the boxes in its columns"
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
            </tr>
          </thead>
          <tbody>
            {boxes.map((row, r) => (
              <tr key={row.id}>
                <th
                  scope="row"
                  role="rowheader"
                  className={"matrix-row" + boxState(row.id) + hotClass({ r, c: -1 })}
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
                          "matrix-cell" + (r === c ? " is-diagonal" : r > c ? " is-below" : "")
                        }
                        data-r={r}
                        data-c={c}
                        tabIndex={tab(p)}
                        aria-label={r === c ? row.label : `${row.label} does not use ${col.label}`}
                        {...track(p)}
                      />
                    );
                  const name =
                    `${row.label} uses ${col.label}: ${cell.text}. ${TRUST[cell.resolution]}` +
                    (cell.back ? ". Goes back up the order" : "");
                  return (
                    <td
                      key={col.id}
                      role="gridcell"
                      className={
                        `matrix-cell has-arrow res-${cell.resolution}` +
                        (cell.back ? " is-back" : "") +
                        cellState(cell)
                      }
                      data-element-id={cell.select[0]}
                      data-r={r}
                      data-c={c}
                      tabIndex={tab(p)}
                      title={name}
                      aria-label={name}
                      aria-selected={cell.select.some((id) => selected.has(id))}
                      onClick={(event) => selectCell(cell, event.shiftKey || event.metaKey)}
                      {...track(p)}
                    >
                      {cell.count > 99 ? "99+" : cell.count}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
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
