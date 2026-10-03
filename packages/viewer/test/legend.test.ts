/** The map's Key lists only what the map shows: outside systems, icons, corner buttons, counts (M9). */
import { describe, expect, it } from "vitest";
import { mapKeyShows } from "../src/keyMarks.js";
import type { LayoutEdge, LayoutNode } from "../src/layout/graphLayout.js";

const node = (id: string, extra: Partial<LayoutNode> = {}): LayoutNode => ({
  id,
  label: id,
  badge: "group",
  kindClass: "group",
  ghost: false,
  x: 0,
  y: 0,
  width: 100,
  height: 40,
  children: [],
  edges: [],
  ...extra,
});

const edge = (id: string, extra: Partial<LayoutEdge> = {}): LayoutEdge =>
  ({
    id,
    stub: false,
    resolution: "precise",
    kind: "calls",
    title: "calls ×2",
    from: "a",
    to: "b",
    counted: false,
    points: [],
    ...extra,
  }) as LayoutEdge;

const boxes = (zoom: string[] = [], expand: string[] = []) => ({
  canZoomInto: (id: string) => zoom.includes(id),
  canExpandInPlace: (id: string) => expand.includes(id),
  changed: false,
});

describe("mapKeyShows", () => {
  it("names outside systems, whole systems and code apart, with one icon each", () => {
    const shows = mapKeyShows(
      [
        node("grp:app", { role: "system" }),
        node("grp:ky", { role: "service", opens: "view:inside", expandable: true }),
        node("grp:fetch", { role: "external" }),
        node("grp:web", { role: "external" }),
      ],
      [edge("e1", { resolution: "llm" })],
      boxes(["grp:ky"], ["grp:ky"]),
    );
    expect(shows).toMatchObject({
      code: true,
      outsideSystems: true,
      systems: true,
      stores: false,
      zoom: true,
      expandHere: true,
      authored: true,
      counts: false,
      outside: false,
    });
    expect(shows.icons!.map((icon) => icon.name)).toEqual(["system", "service", "external"]);
  });

  it("a map of code: no architecture rows, the count row only with a counted label", () => {
    const fn = node("sym:a#f", { kindClass: "function", badge: "function" });
    const shows = mapKeyShows(
      [node("file:a", { kindClass: "file", badge: "file", children: [fn] })],
      [
        edge("e1", {
          counted: true,
          label: { text: "calls ×3", x: 0, y: 0, width: 50, height: 16 },
        }),
      ],
      boxes(),
    );
    expect(shows).toMatchObject({
      code: true,
      outsideSystems: false,
      systems: false,
      zoom: false,
      expandHere: false,
      counts: true,
    });
    expect(shows.icons!.map((icon) => icon.name)).toEqual(["file", "function"]);
  });

  it("a box whose inside cannot be opened shows no corner button row", () => {
    const shows = mapKeyShows([node("grp:ky", { opens: "view:inside" })], [], boxes());
    expect(shows.zoom).toBe(false);
  });

  it("ghosts and stubs, also inside a container, show the outside rows", () => {
    const shows = mapKeyShows(
      [node("file:a", { edges: [edge("s", { stub: true })] }), node("ghost:x", { ghost: true })],
      [],
      boxes(),
    );
    expect(shows.outside).toBe(true);
    expect(shows.icons!.map((icon) => icon.name)).toEqual(["group"]);
  });
});
