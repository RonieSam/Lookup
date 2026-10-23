/**
 * Column sorting for the results table.
 *
 * - Numbers sort as numbers; text sorts "naturally" and ignoring case, so
 *   "99XYZ7271" comes before "99XYZ10034".
 * - Empty cells always sit at the bottom, whichever direction is chosen.
 * - Ties keep the order the rows were in before sorting.
 */

export type SortDir = "asc" | "desc";
export interface SortState {
  key: string;
  dir: SortDir;
}
export type SortValue = string | number | null | undefined;

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const isBlank = (v: SortValue) => v === null || v === undefined || v === "";

export function compareValues(a: Exclude<SortValue, null | undefined>, b: Exclude<SortValue, null | undefined>): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return collator.compare(String(a), String(b));
}

export function sortRows<T>(rows: readonly T[], value: (row: T) => SortValue, dir: SortDir): T[] {
  const keyed = rows.map((row, index) => ({ row, index, v: value(row) }));
  keyed.sort((x, y) => {
    const xBlank = isBlank(x.v);
    const yBlank = isBlank(y.v);
    if (xBlank || yBlank) return xBlank === yBlank ? x.index - y.index : xBlank ? 1 : -1;
    const c = compareValues(x.v as string | number, y.v as string | number);
    return c !== 0 ? (dir === "asc" ? c : -c) : x.index - y.index;
  });
  return keyed.map((k) => k.row);
}

/** Clicking a header: a new column sorts ascending, the same column flips direction. */
export function nextSort(current: SortState | null, key: string): SortState {
  if (current?.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: "asc" };
}
