/**
 * The key of a diagram: what its boxes, outlines, lines, icons and buttons mean, behind a "Key" button beside
 * the zoom buttons. Each row draws the real mark (the same classes as the diagram, so the colours follow the
 * theme) and says what it means in plain words. Rows for things the diagram does not show are left out.
 * `Legend` is the key of a map, `FlowKey` of a process flow, `SequenceKey` of a sequence diagram.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { headOf, type LegendShows } from "../keyMarks.js";
import { readerBadge } from "../readerWords.js";
import { BoxIcon } from "./icons.js";

/** What each icon stands for, in plain words. */
const ICON_WORDS: Record<string, string> = {
  person: "a person",
  system: "a whole system",
  service: "a program",
  component: "a part of it",
  database: "a database",
  cache: "a cache",
  queue: "a queue",
  storage: "stored files",
  external: "outside this code",
  browser: "a browser",
  repo: "the repository",
  dir: "a folder",
  file: "a file",
  group: "a group of files",
  class: "a class",
  struct: "a struct",
  interface: "an interface",
  function: "a function",
  method: "a method",
  type: "a type",
  variable: "a variable",
  constant: "a constant",
  field: "a field",
  enum: "an enum",
  key: "a setting",
};

export function Legend({ shows }: { shows: LegendShows }) {
  return (
    <KeyButton foot="Click a box or an arrow to see its code.">
      {shows.tables && (
        <Row label="A table: a type. Each row is one of its fields, with the type it holds on the right">
          <rect className="lg-box" x="1" y="1" width="30" height="20" rx="3" />
          <path className="lg-rule" d="M1 8 H31 M1 14.5 H31" />
        </Row>
      )}
      {shows.code !== false && (
        <Row
          label={
            shows.tables
              ? "A type drawn as one box: an interface, or a table folded to its name"
              : "A part of the code: a file, a function, a group of files"
          }
        >
          <rect className="lg-box" x="1" y="3" width="30" height="16" rx="4" />
        </Row>
      )}
      {shows.outsideSystems && (
        <Row label="Something outside this code: the browser, a server, a person">
          <rect className="lg-box is-outside" x="1" y="3" width="30" height="16" rx="4" />
        </Row>
      )}
      {shows.sketches && (
        <Row label="A sketch: an idea of the big picture, not linked to code">
          <rect className="lg-box is-sketch" x="1" y="3" width="30" height="16" rx="4" />
        </Row>
      )}
      {shows.systems && (
        <Row label="A whole system: this one, your app, or another it works with">
          <rect className="lg-box is-system" x="1" y="3" width="30" height="16" rx="4" />
        </Row>
      )}
      {shows.stores && (
        <Row label="Where data is kept: a database, a cache, a queue">
          <path
            className="lg-box is-store"
            d="M2 6 A14 3 0 0 1 30 6 V17 A14 3 0 0 1 2 17 Z M2 6 A14 3 0 0 0 30 6"
          />
        </Row>
      )}
      <Row label="Selected">
        <rect className="lg-box is-selected" x="1" y="3" width="30" height="16" rx="4" />
      </Row>
      <Row label="Linked to what is selected">
        <rect className="lg-box is-related" x="1" y="3" width="30" height="16" rx="4" />
      </Row>
      {shows.icons && shows.icons.length > 0 && (
        <div className="legend-row legend-icons" data-testid="legend-icons">
          <span className="legend-icons-title">The icon on a box says what it is:</span>
          <ul>
            {shows.icons.map((icon) => (
              <li key={icon.name}>
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <g
                    className={`node kind-${icon.kindClass}${icon.role ? ` role-${icon.role}` : ""}`}
                  >
                    <BoxIcon name={icon.name} x={0} y={0} />
                  </g>
                </svg>
                {ICON_WORDS[icon.name] ?? icon.name}
              </li>
            ))}
          </ul>
        </div>
      )}
      {shows.zoom && (
        <Row label="Open its own map: what is inside it (or double-click the box)">
          <CornerMark>
            <circle cx={9.5} cy={9.5} r={5} />
            <path d="M13.2 13.2 L17.5 17.5 M7 9.5 H12 M9.5 7 V12" />
          </CornerMark>
        </Row>
      )}
      {shows.expandHere && (
        <Row label="Show inside: what is inside it, in this box, on this map">
          <CornerMark>
            <rect x={3.5} y={3.5} width={15} height={15} rx={2.5} />
            <rect x={6.5} y={9} width={4} height={4} rx={1} />
            <rect x={11.5} y={9} width={4} height={4} rx={1} />
            <path d="M6.5 6.5h9" />
          </CornerMark>
        </Row>
      )}
      {(shows.kinds ?? ["calls"]).map((kind) => (
        <Row key={kind} label={KIND_WORDS[kind] ?? kind}>
          <Arrow className="lg-edge" head={headOf(kind)} />
        </Row>
      ))}
      {shows.counts && (
        <Row
          label={
            shows.countKind && shows.countKind !== "calls"
              ? `${shows.countKind} ×3: found in 3 places in the code`
              : "calls ×3: the code calls it from 3 places"
          }
          text="×3"
        >
          <Arrow className="lg-edge" />
        </Row>
      )}
      {shows.authored && (
        <Row label="An arrow the guide's author added, checked against the code: an event, a setting, a request">
          <Arrow className="lg-edge is-authored" />
        </Row>
      )}
      {shows.found && (shows.heuristic || shows.mixed) && (
        <Row label="Solid: found in the code by a language tool (precise)">
          <Arrow className="lg-edge" />
        </Row>
      )}
      {shows.heuristic && (
        <Row label="Dashed: matched by name (heuristic), so it can be wrong">
          <Arrow className="lg-edge is-heuristic" />
        </Row>
      )}
      {shows.mixed && (
        <Row label="Dash-dot: some of its code links are precise, some are matched by name">
          <Arrow className="lg-edge is-mixed" />
        </Row>
      )}
      {shows.outside && (
        <>
          <Row label="Dashed box: code outside this map. Click it to add it; its number says how often it is used">
            <rect className="lg-box is-ghost" x="1" y="3" width="30" height="16" rx="4" />
          </Row>
          <Row label="Dotted: an arrow to or from code outside this map (shown for the selected box)">
            <Arrow className="lg-edge is-stub" />
          </Row>
        </>
      )}
      {shows.change && (
        <Row label="What the change did: added it, or edited its code">
          <rect className="lg-pill is-new" x="0" y="5" width="15" height="12" rx="6" />
          <rect className="lg-pill is-changed" x="17" y="5" width="15" height="12" rx="6" />
        </Row>
      )}
    </KeyButton>
  );
}

/** What each kind of arrow means, for the Key's rows (the kinds a map draws, `LegendShows.kinds`). */
const KIND_WORDS: Record<string, string> = {
  calls: "Calls: the arrow points at the code being called",
  imports: "Imports (open head): the file uses code from the file it points at",
  extends: "Extends (hollow head): points at the parent class or type",
  embeds:
    "Embeds (hollow head): the struct or interface takes in the type it points at, with its fields and methods",
  implements: "Implements (hollow head): points at the interface it fulfils",
  references: "Uses a type (open head): points at the type it names",
  holds: "Holds (open head): the field in that row holds a value of the type it points at",
  reads: "Reads: points at the data it reads",
  writes: "Writes: points at the data it changes",
  requests: "Requests: a web call, pointing at the code that answers it",
};

/** The short words for a kind on the key line (only when a map mixes kinds). */
const KIND_SHORT: Record<string, string> = {
  calls: "calls",
  imports: "imports",
  extends: "extends",
  embeds: "embeds",
  implements: "implements",
  references: "uses a type",
  holds: "a field holds this type",
  reads: "reads",
  writes: "writes",
  requests: "web request",
};

/**
 * The marks of a map's arrows in one line under its caption, for the marks the map draws now: a reader learns
 * them without opening the Key. Each swatch is drawn with the Key's classes, so its colour and dash are the
 * map's. `stubLines`: lines to code outside the map are on screen (else only their dashed boxes are). Nothing
 * when every arrow is the plain kind.
 */
export function KeyLine({
  shows,
  stubLines = false,
  sharedBadge,
}: {
  shows: LegendShows;
  stubLines?: boolean;
  /** The technology or role every box shares, drawn on none of them (graphLayout `sharedBadge`). */
  sharedBadge?: string | undefined;
}) {
  const items: { key: string; swatch: ReactNode; words: string }[] = [];
  if (sharedBadge)
    items.push({
      key: "shared",
      swatch: null,
      words: `every box: ${readerBadge(sharedBadge) ?? sharedBadge}`,
    });
  const line = (className: string, head: Head = "filled") => (
    <svg className="key-swatch" width="26" height="12" viewBox="0 0 32 22" aria-hidden="true">
      <Arrow className={className} head={head} />
    </svg>
  );
  const kinds = shows.kinds ?? [];
  // the kinds when the map mixes them, or draws only arrows that are not calls (a class hierarchy); a map of
  // calls alone names them when the line says anything else, so an arrow without words has one here
  const kindItems = kinds.map((kind) => ({
    key: `kind-${kind}`,
    swatch: line("lg-edge", headOf(kind)),
    words: KIND_SHORT[kind] ?? kind,
  }));
  if (kinds.length > 1 || (kinds.length === 1 && kinds[0] !== "calls")) items.push(...kindItems);
  if (shows.authored)
    items.push({
      key: "authored",
      swatch: line("lg-edge is-authored"),
      words: "added by the author, checked against the code",
    });
  if (shows.found && (shows.authored || shows.heuristic || shows.mixed || shows.outside))
    items.push({ key: "found", swatch: line("lg-edge is-found"), words: "found in the code" });
  if (shows.heuristic)
    items.push({
      key: "heuristic",
      swatch: line("lg-edge is-heuristic"),
      words: "matched by name",
    });
  if (shows.mixed)
    items.push({
      key: "mixed",
      swatch: line("lg-edge is-mixed"),
      words: "partly matched by name",
    });
  if (shows.outside) {
    items.push({
      key: "ghost",
      swatch: (
        <svg className="key-swatch" width="26" height="14" viewBox="0 0 32 22" aria-hidden="true">
          <rect className="lg-box is-ghost" x="1" y="3" width="30" height="16" rx="4" />
        </svg>
      ),
      words: stubLines
        ? "code outside this map"
        : "code outside this map (pick a box to see its arrows)",
    });
    if (stubLines)
      items.push({ key: "stub", swatch: line("lg-edge is-stub"), words: "leads outside this map" });
  }
  if (items.length === 0) return null;
  if (
    kinds.length === 1 &&
    kinds[0] === "calls" &&
    items.every((item) => item.key !== "kind-calls")
  )
    items.splice(sharedBadge ? 1 : 0, 0, ...kindItems);
  return (
    // a11y: a list a screen reader names and counts, each item with the look of its mark in words
    <ul className="key-line" data-testid="key-line" aria-label="Key to this map's lines">
      {items.map((item) => (
        <li key={item.key} className="key-line-item" data-key-item={item.key}>
          {item.swatch}
          {markWords(item.key) && <span className="sr-only">{markWords(item.key)}: </span>}
          {item.words}
        </li>
      ))}
    </ul>
  );
}

/** What a key line's swatch looks like, in words (its swatch is hidden from screen readers). */
function markWords(key: string): string | undefined {
  if (key.startsWith("kind-")) {
    const head = headOf(key.slice(5));
    return head === "hollow"
      ? "solid arrow, hollow head"
      : head === "open"
        ? "solid arrow, open head"
        : "solid arrow";
  }
  return {
    authored: "thick purple arrow",
    found: "solid arrow",
    heuristic: "dashed arrow",
    mixed: "partly dashed arrow",
    ghost: "dashed box",
    stub: "dotted arrow",
  }[key];
}

export interface FlowKeyShows {
  decision: boolean;
  terminal: boolean;
  /** A loop or branch label over a step. */
  frames: boolean;
  /** Arrows drawn dashed: the order of the calls, read from the code (a projected flow). */
  projected: boolean;
  /** A recursive call: the same steps again, one level down. */
  recurse?: boolean;
  /** A return to the caller, up one level. */
  returns?: boolean;
  /** An end drawn again near another way into it (`repeatEnds`). */
  copies?: boolean;
  /** A flow of states, its moves drawn as labelled arrows between them (`stateMachine`). */
  states?: boolean;
}

/** The key of a process flow (FlowDiagram). */
export function FlowKey({ shows }: { shows: FlowKeyShows }) {
  // a flow of states has no steps and no "then": its boxes are states, its labelled arrows the moves
  if (shows.states)
    return (
      <KeyButton foot="Click a state or a move to see its code.">
        <Row label="A state the value can be in. States have no fixed order, so no numbers.">
          <g className="flow-stage is-state">
            <rect x="1" y="3" width="30" height="16" rx="8" />
          </g>
        </Row>
        <Row label="Moves to: the label names the move, the code that changes the state">
          <g className="flow-transition is-move">
            <line className="lg-move-line" x1="1" y1="11" x2="26" y2="11" />
            <path className="lg-move-head" d="M25 7 L31 11 L25 15 Z" />
            <rect x="7" y="5" width="13" height="12" rx="3" fill="var(--panel)" />
          </g>
        </Row>
        <Row label="Selected">
          <g className="flow-stage is-selected">
            <rect x="2" y="4" width="28" height="14" rx="7" />
          </g>
        </Row>
        <Row label="Linked to the code you selected">
          <g className="flow-stage is-related">
            <rect x="2" y="4" width="28" height="14" rx="7" />
          </g>
        </Row>
      </KeyButton>
    );
  return (
    <KeyButton foot="Click a step to see its code.">
      <Row label="One step: what runs, with the name of its code under it">
        <g className="flow-stage">
          <rect x="1" y="3" width="30" height="16" rx="5" />
        </g>
      </Row>
      {shows.decision && (
        <Row label="A choice: the path splits here">
          <g className="flow-stage">
            <polygon points="16,1 31,11 16,21 1,11" />
          </g>
        </Row>
      )}
      {shows.terminal && (
        <Row label="Where it starts or ends">
          <g className="flow-stage">
            <rect x="1" y="3" width="30" height="16" rx="8" />
          </g>
        </Row>
      )}
      {shows.copies && (
        <Row label="Dashed, no number: the same end, drawn again to keep arrows short">
          <g className="flow-stage is-copy">
            <rect x="1" y="3" width="30" height="16" rx="8" />
          </g>
        </Row>
      )}
      <Row label="Selected">
        <g className="flow-stage is-selected">
          <rect x="2" y="4" width="28" height="14" rx="5" />
        </g>
      </Row>
      <Row label="Linked to the code you selected">
        <g className="flow-stage is-related">
          <rect x="2" y="4" width="28" height="14" rx="5" />
        </g>
      </Row>
      <Row label={shows.projected ? "Then: the order the steps run in" : "Then: what runs next"}>
        <Arrow className={`lg-edge${shows.projected ? " is-projected" : ""}`} />
      </Row>
      {shows.recurse && (
        <Row label="One level down: the function calls itself, and the steps from the arrow's end run again for the smaller piece">
          <Arrow className="lg-edge is-recurse" />
        </Row>
      )}
      {shows.returns && (
        <Row label="Up one level: the call returns, to the step at the arrow's end (an arrow that ends on no step: to whoever made the call)">
          <Arrow className="lg-edge is-return" />
        </Row>
      )}
      {shows.frames && (
        <Row label="A condition: the purple words above a step say when it and the steps after it run">
          <text className="lg-frame" x="16" y="15">
            if…
          </text>
        </Row>
      )}
    </KeyButton>
  );
}

export interface SequenceKeyShows {
  returns: boolean;
  async: boolean;
  /** Boxes around steps: a loop, a choice, an optional part. */
  frames: boolean;
  /** An alt box split into its choices by dashed lines. */
  arms?: boolean;
}

/** The key of a sequence diagram (SequenceView). */
export function SequenceKey({ shows }: { shows: SequenceKeyShows }) {
  return (
    <KeyButton foot="Click a name or an arrow to see its code.">
      <Row label="Who takes part: a part of the code, or someone outside it. Time runs down.">
        <g className="lifeline-head">
          <rect className="head" x="1" y="3" width="30" height="12" rx="3" />
        </g>
        <line className="lg-lifeline" x1="16" y1="15" x2="16" y2="22" />
      </Row>
      <Row label="A call: one asks the other to do something">
        <g className="step kind-call">
          <path className="line" d="M1 11 H25" />
          <path className="head" d="M24 7 L31 11 L24 15 Z" />
        </g>
      </Row>
      {shows.returns && (
        <Row label="An answer going back">
          <g className="step kind-return">
            <path className="line" d="M1 11 H30" />
            <path className="head" d="M25 7 L30 11 L25 15" />
          </g>
        </Row>
      )}
      {shows.async && (
        <Row label="A message sent without waiting for the answer">
          <g className="step kind-async">
            <path className="line" d="M1 11 H30" />
            <path className="head" d="M25 7 L30 11 L25 15" />
          </g>
        </Row>
      )}
      {shows.frames && (
        <Row label="A box around steps: they repeat (loop), run only when a condition holds (opt), or one of its arms runs (alt). Its condition has no code link of its own: it is in the code above the first step">
          <g className="frame">
            <rect className="frame-box" x="1" y="2" width="30" height="18" rx="2" />
            <path className="frame-tab" d="M1 2 h12 v5 l-3 3 h-9 z" />
          </g>
        </Row>
      )}
      {shows.arms && (
        <Row label="A dashed line in an alt box splits its arms. Click an arm's condition to see its steps and their code">
          <g className="frame">
            <rect className="frame-box" x="1" y="2" width="30" height="18" rx="2" />
            <line className="frame-divider" x1="1" y1="11" x2="31" y2="11" />
          </g>
        </Row>
      )}
    </KeyButton>
  );
}

/** The "Key" button and the panel it opens: Escape or a click elsewhere closes it. */
function KeyButton({ foot, children }: { foot: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  return (
    <div className="legend" ref={root}>
      <button
        type="button"
        data-testid="legend-button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title="What the boxes, lines and colours mean"
        onClick={() => setOpen((was) => !was)}
      >
        Key
      </button>
      {open && (
        <div id={id} className="legend-panel" role="dialog" aria-label="Key" data-testid="legend">
          {children}
          <p className="legend-foot">{foot}</p>
        </div>
      )}
    </div>
  );
}

function Row({ label, text, children }: { label: string; text?: string; children: ReactNode }) {
  return (
    <div className="legend-row">
      <svg width="32" height="22" viewBox="0 0 32 22" aria-hidden="true">
        {children}
        {text !== undefined && (
          <text className="lg-count" x="13" y="8">
            {text}
          </text>
        )}
      </svg>
      <span>{label}</span>
    </div>
  );
}

type Head = "filled" | "hollow" | "open";

/** A short arrow with the head its kind ends in on the map (keyMarks `headOf`). */
function Arrow({ className, head = "filled" }: { className: string; head?: Head }) {
  return (
    <g className={className}>
      <line x1="1" y1="11" x2={head === "hollow" ? 20 : 25} y2="11" />
      {head === "filled" && <path d="M24 7 L31 11 L24 15 Z" />}
      {head === "hollow" && <path className="is-hollow" d="M20 5.5 L31 11 L20 16.5 Z" />}
      {head === "open" && <path className="is-open" d="M24 6.5 L31 11 L24 15.5" />}
    </g>
  );
}

/** A box's corner button as the map draws it (GraphView `CornerButton`), scaled into the row. */
function CornerMark({ children }: { children: ReactNode }) {
  return (
    <g className="node">
      <g className="corner-button" transform="translate(5 0) scale(0.95)">
        <rect className="corner-button-face" width={22} height={22} rx={5} />
        {children}
      </g>
    </g>
  );
}
