/**
 * Text contrast of the theme tokens in styles.css, light and dark (WCAG AA: 4.5:1 for normal text).
 * Code: every syntax colour on the editor background and on every focus and change tint; the dimmed palette
 * on the background; the line numbers. Chrome: the small labels and the accent text on its soft tint.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");

type Rgba = [number, number, number, number];

function block(start: string): string {
  const from = css.indexOf("{", css.indexOf(start));
  let depth = 0;
  let at = from;
  for (; at < css.length; at++) {
    if (css[at] === "{") depth++;
    else if (css[at] === "}" && --depth === 0) break;
  }
  return css.slice(from, at);
}

function tokens(text: string): Record<string, string> {
  return Object.fromEntries(
    [...text.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}

const light = tokens(block(":root {"));
const dark = { ...light, ...tokens(block("@media (prefers-color-scheme: dark)")) };

function parse(color: string): Rgba {
  if (color.startsWith("#")) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(1) as Rgba;
  }
  const parts = /rgba?\(([^)]+)\)/
    .exec(color)![1]!
    .split(/[ ,/]+/)
    .filter(Boolean)
    .map(Number);
  return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
}

const over = (top: Rgba, under: Rgba): Rgba =>
  [0, 1, 2].map((i) => top[i]! * top[3] + under[i]! * (1 - top[3])).concat(1) as Rgba;

function luminance([r, g, b]: Rgba): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg: Rgba, bg: Rgba): number {
  const [a, b] = [luminance(over(fg, bg)), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const TINTS = [
  "--hl-definition",
  "--hl-usage",
  "--hl-config",
  "--hl-test",
  "--hl-call-site",
  "--diff-add-bg",
  "--diff-del-bg",
];

describe.each([
  ["light", light],
  ["dark", dark],
] as const)("contrast, %s theme", (_name, t) => {
  const v = (name: string) => {
    expect(t[name], name).toBeDefined();
    return parse(t[name]!);
  };
  const code = v("--code-bg");
  const syntax = Object.keys(t).filter(
    (k) => (k.startsWith("--syn-") && !k.endsWith("-dim")) || k === "--code-fg",
  );

  it("syntax colours on the background and on every focus and change tint", () => {
    const low: string[] = [];
    for (const k of syntax) {
      for (const bg of [code, ...TINTS.map((tint) => over(v(tint), code))]) {
        const ratio = contrast(v(k), bg);
        if (ratio < 4.5) low.push(`${k} ${ratio.toFixed(2)}`);
      }
      // the exact expression of a call site: its tint over the call-site line
      const site = contrast(v(k), over(v("--site-bg"), over(v("--hl-call-site"), code)));
      if (site < 4.5) low.push(`${k} on a call site ${site.toFixed(2)}`);
    }
    expect(low).toEqual([]);
  });

  it("dimmed code keeps 4.5:1 and is dimmer than the colour it stands for", () => {
    for (const k of syntax) {
      const dim = `${k}-dim`;
      expect(contrast(v(dim), code), dim).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v(dim), code), dim).toBeLessThanOrEqual(contrast(v(k), code));
    }
  });

  it("line numbers, also on a changed line", () => {
    const gutter = v("--code-gutter-bg");
    for (const bg of [gutter, over(v("--diff-add-bg"), gutter), over(v("--diff-del-bg"), gutter)]) {
      expect(contrast(v("--code-gutter-fg"), bg)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(v("--diff-add-fg"), over(v("--diff-add-bg"), gutter))).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it("small chrome text: labels, the current tab, change pills", () => {
    for (const bg of ["--bg", "--panel", "--panel-2"]) {
      expect(contrast(v("--faint"), v(bg)), `--faint on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v("--muted"), v(bg)), `--muted on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v("--accent"), v(bg)), `--accent on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(v("--accent"), v("--accent-soft"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v("--accent-fg"), v("--accent"))).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(v("--diff-add-fg"), over(v("--diff-add-bg"), v("--panel"))),
    ).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v("--warn"), v("--warn-soft"))).toBeGreaterThanOrEqual(4.5);
  });
});
