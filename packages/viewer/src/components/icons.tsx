/**
 * The icon in the corner of a diagram box: what the box is, at a glance. Architecture boxes show their role
 * (a server for a service, a cylinder for a database, a globe for an outside system); boxes of code show
 * their level (a book for the repo, a folder, a file, stacked layers for a group) and symbols a letter
 * (C class, I interface, ƒ function, m method, ...). Drawn here, in a 16x16 box, so no icon set is bundled.
 */
import type { ReactNode } from "react";

/** Letters for kinds of symbols, drawn in a rounded square. */
const LETTERS: Record<string, string> = {
  class: "C",
  interface: "I",
  function: "ƒ",
  method: "m",
  type: "T",
  variable: "x",
  enum: "E",
  key: "k",
  symbol: "•",
  other: "•",
};

const SHAPES: Record<string, ReactNode> = {
  // ── architecture roles ──
  person: (
    <>
      <circle cx={8} cy={5} r={2.8} />
      <path d="M2.5 14.5a5.5 5 0 0 1 11 0" />
    </>
  ),
  system: (
    <>
      <rect x={1.5} y={1.5} width={13} height={13} rx={2.5} />
      <rect x={4.2} y={4.2} width={3} height={3} rx={0.6} />
      <rect x={8.8} y={4.2} width={3} height={3} rx={0.6} />
      <rect x={4.2} y={8.8} width={3} height={3} rx={0.6} />
      <rect x={8.8} y={8.8} width={3} height={3} rx={0.6} />
    </>
  ),
  service: (
    <>
      <rect x={1.5} y={2} width={13} height={5} rx={1.5} />
      <rect x={1.5} y={9} width={13} height={5} rx={1.5} />
      <path d="M4.5 4.5h.01M4.5 11.5h.01M8 4.5h4M8 11.5h4" />
    </>
  ),
  component: <path d="M8 1.5l6 3.25v6.5L8 14.5l-6-3.25v-6.5zM2 4.75L8 8l6-3.25M8 8v6.5" />,
  database: (
    <>
      <ellipse cx={8} cy={3.5} rx={5.5} ry={2} />
      <path d="M2.5 3.5v9a5.5 2 0 0 0 11 0v-9M2.5 8a5.5 2 0 0 0 11 0" />
    </>
  ),
  cache: <path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z" />,
  queue: <path d="M1.5 4H10M1.5 8H10M1.5 12H10M11.5 5l3 3-3 3" />,
  storage: (
    <>
      <rect x={1.5} y={2.5} width={13} height={3.5} rx={1} />
      <path d="M2.5 6v7.5h11V6M6.5 9h3" />
    </>
  ),
  external: (
    <>
      <circle cx={8} cy={8} r={6.5} />
      <ellipse cx={8} cy={8} rx={2.8} ry={6.5} />
      <path d="M1.5 8h13" />
    </>
  ),
  // ── levels of code ──
  repo: <path d="M3 2.5h9.5v11h-8A1.5 1.5 0 0 1 3 12zM3 12a1.5 1.5 0 0 1 1.5-1.5h8" />,
  dir: (
    <path d="M1.5 4a1 1 0 0 1 1-1H6l1.5 1.5h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
  ),
  file: <path d="M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M5.5 8h5M5.5 10.5h5" />,
  group: (
    <path d="M8 2l6.5 3.25L8 8.5 1.5 5.25zM1.5 8.25L8 11.5l6.5-3.25M1.5 11.25L8 14.5l6.5-3.25" />
  ),
};

/** The name of the icon a box shows: its role, else the kind of code it is. */
export function iconName(box: { role?: string | undefined; kindClass: string }): string {
  return box.role ?? box.kindClass;
}

/** The icon, with its top-left corner at (x, y). */
export function BoxIcon({ name, x, y }: { name: string; x: number; y: number }) {
  const letter = LETTERS[name];
  return (
    <g
      className={`box-icon icon-${name}`}
      transform={`translate(${x} ${y})`}
      aria-hidden="true"
      data-icon={name}
    >
      {letter !== undefined ? (
        <>
          <rect x={1} y={1} width={14} height={14} rx={3.5} />
          <text x={8} y={12}>
            {letter}
          </text>
        </>
      ) : (
        (SHAPES[name] ?? SHAPES.group)
      )}
    </g>
  );
}
