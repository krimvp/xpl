/**
 * Small internal helpers shared by the core modules. Not part of the public API (not re-exported
 * from index.ts).
 */

/** Locale-independent string comparison, so every ordering is deterministic across machines. */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deep copy of JSON-shaped data (explainers, patches). `undefined` properties are dropped. */
export function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural equality of JSON-shaped data. Missing and `undefined` properties are equal. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a !== "object" || Array.isArray(b)) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const key of keys) if (!deepEqual(ra[key], rb[key])) return false;
  return true;
}

/** Distinct values in first-seen order. */
export function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/** Sorted distinct strings. */
export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(cmp);
}
