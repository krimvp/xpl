/**
 * The key of a diagram: what its boxes, outlines, lines, icons and buttons mean, behind a "Key" button beside
 * the zoom buttons. Each row draws the real mark (the same classes as the diagram, so the colours follow the
 * theme) and says what it means in plain words. Rows for things the diagram does not show are left out.
 * `Legend` is the key of a map, `FlowKey` of a process flow, `SequenceKey` of a sequence diagram.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { LegendShows } from "../keyMarks.js";
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
  repo: "the repository",
  dir: "a folder",
  file: "a file",
  group: "a group of files",
  class: "a class",
  interface: "an interface",
  function: "a function",
  method: "a method",
  type: "a type",
  variable: "a variable",
  enum: "an enum",
  key: "a setting",
};

export function Legend({ shows }: { shows: LegendShows }) {
  return (
    <KeyButton foot="Click a box or an arrow to see its code.">
      {shows.code !== false && (
        <Row label="A part of the code: a file, a function, a group of files">
          <rect className="lg-box" x="1" y="3" width="30" height="16" rx="4" />
        </Row>
      )}
      {shows.outsideSystems && (
        <Row label="Something outside this code: your app, the browser, a server">
          <rect className="lg-box is-outside" x="1" y="3" width="30" height="16" rx="4" />
        </Row>
      )}
      {shows.systems && (
        <Row label="A whole system, this one or one it works with">
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
      <Row label="The one you picked">
        <rect className="lg-box is-selected" x="1" y="3" width="30" height="16" rx="4" />
      </Row>
      <Row label="Related to the one you picked">
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
        <Row label="See what is inside: opens the map of its parts (or double-click the box)">
          <CornerMark>
            <circle cx={9.5} cy={9.5} r={5} />
            <path d="M13.2 13.2 L17.5 17.5 M7 9.5 H12 M9.5 7 V12" />
          </CornerMark>
        </Row>
      )}
      {shows.expandHere && (
        <Row label="Show its parts inside the box, on this map">
          <CornerMark>
            <rect x={3.5} y={3.5} width={15} height={15} rx={2.5} />
            <rect x={6.5} y={9} width={4} height={4} rx={1} />
            <rect x={11.5} y={9} width={4} height={4} rx={1} />
            <path d="M6.5 6.5h9" />
          </CornerMark>
        </Row>
      )}
      <Row label="Calls: the arrow points at the code being called">
        <Arrow className="lg-edge" />
      </Row>
      {shows.counts && (
        <Row label="calls ×3: the code calls it from 3 places" text="×3">
          <Arrow className="lg-edge" />
        </Row>
      )}
      {shows.authored && (
        <Row label="A link the explainer's author added: an event, a setting, a request">
          <Arrow className="lg-edge is-authored" />
        </Row>
      )}
      {shows.heuristic && (
        <Row label="A likely link, found by name only">
          <Arrow className="lg-edge is-heuristic" />
        </Row>
      )}
      {shows.outside && (
        <>
          <Row label="Code outside this map (+ adds it): how often it is called">
            <rect className="lg-box is-ghost" x="1" y="3" width="30" height="16" rx="4" />
          </Row>
          <Row label="A call to or from code outside this map">
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

export interface FlowKeyShows {
  decision: boolean;
  terminal: boolean;
  /** A loop or branch label over a box. */
  frames: boolean;
  /** Arrows drawn dashed: the order of the calls, read from the code (a projected flow). */
  projected: boolean;
}

/** The key of a process flow (FlowDiagram). */
export function FlowKey({ shows }: { shows: FlowKeyShows }) {
  return (
    <KeyButton foot="Click a step to see its code.">
      <Row label="One step: what runs, and the code that runs it under it">
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
      <Row label="The one you picked">
        <g className="flow-stage is-selected">
          <rect x="2" y="4" width="28" height="14" rx="5" />
        </g>
      </Row>
      <Row label="A step in the code you picked">
        <g className="flow-stage is-related">
          <rect x="2" y="4" width="28" height="14" rx="5" />
        </g>
      </Row>
      <Row label={shows.projected ? "Then: the order the steps run in" : "Then: what runs next"}>
        <Arrow className={`lg-edge${shows.projected ? " is-stub" : ""}`} />
      </Row>
      {shows.frames && (
        <Row label="When it runs: the purple words above a box hold for it and the boxes after it">
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
        <Row label="A box around steps: they repeat (loop), or run only sometimes (alt, opt)">
          <g className="frame">
            <rect className="frame-box" x="1" y="2" width="30" height="18" rx="2" />
            <path className="frame-tab" d="M1 2 h12 v5 l-3 3 h-9 z" />
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

function Arrow({ className }: { className: string }) {
  return (
    <g className={className}>
      <line x1="1" y1="11" x2="25" y2="11" />
      <path d="M24 7 L31 11 L24 15 Z" />
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
