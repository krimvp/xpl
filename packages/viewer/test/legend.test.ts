/** The map's Key lists only what the map shows: outside systems, icons, corner buttons, counts (M9). */
import { describe, expect, it } from "vitest";
import { keyLineItems, mapKeyShows, type LegendShows } from "../src/keyMarks.js";
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
  it("names sketch boxes apart from code and from what they stand for", () => {
    const shows = mapKeyShows(
      [node("grp:client", { role: "person", sketch: true }), node("grp:api", { sketch: true })],
      [],
      boxes(),
    );
    expect(shows).toMatchObject({ sketches: true, code: false, outsideSystems: false });
  });

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

  // "Your repository (git)" and "Browser (HTML page)" got the globe of an outside system
  it("keys a box by the icon its technology picks before its role's", () => {
    const shows = mapKeyShows(
      [
        node("grp:repo", { role: "external", badge: "git" }),
        node("grp:web", { role: "external", badge: "HTML page" }),
        node("grp:api", { role: "external", badge: "REST API" }),
      ],
      [],
      boxes(),
    );
    expect(shows.icons!.map((icon) => icon.name)).toEqual(["repo", "browser", "external"]);
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

  // the Key of a data map explained boxes as files and functions, rows as "a variable", and its one
  // kind of arrow as "uses a type", while the map labels it "holds"
  it("a data map: tables, the arrow a row holds, and no row icons or code-box row", () => {
    const row = node("sym:q#Queue.ready", { kindClass: "variable", badge: "variable", row: true });
    const shows = mapKeyShows(
      [node("sym:q#Queue", { kindClass: "class", badge: "class", rows: true, children: [row] })],
      [
        edge("e1", { kind: "references", title: "holds", from: row.id, to: "sym:j#Job" }),
        edge("e2", {
          kind: "implements",
          title: "implements ×1",
          counted: true,
          label: { text: "implements ×1", x: 0, y: 0, width: 80, height: 16 },
        }),
      ],
      boxes(),
    );
    expect(shows).toMatchObject({ tables: true, code: false, kinds: ["implements", "holds"] });
    expect(shows.countKind).toBe("implements");
    expect(shows.icons!.map((icon) => icon.name)).toEqual(["class"]);
  });

  // Go has no parent types: its embedded types were keyed "Extends: points at the parent class"
  it("keys Go's embedded types as embeds, apart from a class that extends another", () => {
    const shows = mapKeyShows(
      [node("sym:a#A"), node("sym:b#B")],
      [
        edge("e1", { kind: "extends", title: "embeds" }),
        edge("e2", { kind: "extends", title: "embeds a type in" }),
        edge("e3", { kind: "extends" }),
      ],
      boxes(),
    );
    expect(shows.kinds).toEqual(["extends", "embeds"]);
  });
});

// ky's "Inside ky": "→ calls · → added by the author · → found in the code", the first and last the same
// grey arrow; its system map drew only the author's arrows and still listed "→ calls"
describe("the key line under a map", () => {
  const keys = (shows: Partial<LegendShows>) =>
    keyLineItems({
      outside: false,
      authored: false,
      heuristic: false,
      change: false,
      ...shows,
    }).map((item) => `${item.key}: ${item.words}`);
  it("says calls found in the code once when the map's found arrows are all calls", () => {
    expect(keys({ kinds: ["calls"], found: true, authored: true })).toEqual([
      "authored: added by the author, checked against the code",
      "found: calls, found in the code",
    ]);
  });
  it("names no kind on a map whose only arrows are the author's", () => {
    expect(keys({ kinds: ["calls"], authored: true })).toEqual([
      "authored: added by the author, checked against the code",
    ]);
  });
  it("still names calls beside arrows matched by name, and every kind when the map mixes them", () => {
    expect(keys({ kinds: ["calls"], authored: true, heuristic: true })).toEqual([
      "kind-calls: calls",
      "authored: added by the author, checked against the code",
      "heuristic: matched by name",
    ]);
    expect(keys({ kinds: ["calls", "extends"], found: true, heuristic: true })).toEqual([
      "kind-calls: calls",
      "kind-extends: extends",
      "found: found in the code",
      "heuristic: matched by name",
    ]);
  });
});
