/**
 * The key of a map: what its boxes, outlines, lines and pills mean, behind a "Key" button beside the zoom
 * buttons. Each row draws the real mark (the same classes as the diagram, so the colours follow the theme) and
 * says what it means in plain words. Rows for things the map does not show are left out.
 */
import { useEffect, useId, useRef, useState } from "react";

export interface LegendShows {
  /** Calls that leave the view (stubs) and boxes outside it (ghosts). */
  outside: boolean;
  /** Links the explainer's author drew (events, configuration). */
  authored: boolean;
  /** Links found by name only (heuristic). */
  heuristic: boolean;
  /** The change's New / Changed pills. */
  change: boolean;
}

export function Legend({ shows }: { shows: LegendShows }) {
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
          <Row label="A part of the code: a file, a function, a group of files">
            <rect className="lg-box" x="1" y="3" width="30" height="16" rx="4" />
          </Row>
          <Row label="The one you picked">
            <rect className="lg-box is-selected" x="1" y="3" width="30" height="16" rx="4" />
          </Row>
          <Row label="Related to the one you picked">
            <rect className="lg-box is-related" x="1" y="3" width="30" height="16" rx="4" />
          </Row>
          <Row label="Calls: the arrow points at the code being called">
            <Arrow className="lg-edge" />
          </Row>
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
          <p className="legend-foot">Click a box or an arrow to see its code.</p>
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="legend-row">
      <svg width="32" height="22" viewBox="0 0 32 22" aria-hidden="true">
        {children}
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
