/**
 * Turning spreadsheet headers and cells into stored columns and values.
 */

import { isValidNeoId, normalizeNeoId } from "./neo";

export type Cell = string | number | boolean;
export type RecordData = Record<string, Cell>;

export interface ColumnDef {
  key: string;
  label: string;
}

/** Keys are lower-case, start with a letter or digit, and are safe as object keys. */
export const COLUMN_KEY_PATTERN = /^[a-z0-9][a-z0-9_]{0,62}$/;
export const MAX_COLUMNS = 60;
export const MAX_TEXT_LENGTH = 500;

/** The key column. It identifies the student and is never stored as data. */
export const NEO_KEY = "neo_id";

/**
 * Headers that mean the same thing are folded onto one stored column, so an
 * upload with "Reg No" fills the "Registration Number" column rather than
 * creating a duplicate. Anything not listed here becomes its own column.
 */
const ALIASES: Record<string, string> = {
  neoid: NEO_KEY,
  neo_id: NEO_KEY,
  neo_identifier: NEO_KEY,
  neo_no: NEO_KEY,
  neo_number: NEO_KEY,

  regno: "registration_number",
  reg_no: "registration_number",
  reg_number: "registration_number",
  registration_no: "registration_number",
  registration_number: "registration_number",
  registration: "registration_number",

  name: "full_name",
  full_name: "full_name",
  fullname: "full_name",
  student_name: "full_name",
};

export function headerToKey(header: unknown): string {
  const base = String(header ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base) return "";
  return ALIASES[base] ?? base;
}

export type MappingKind = "neo" | "existing" | "new" | "skipped";

export interface MappedColumn {
  index: number;
  header: string;
  key: string;
  kind: MappingKind;
  /** Why the column is skipped, when `kind` is "skipped". */
  note?: string;
}

/**
 * Maps every header to a stored column.
 *
 * `neoIndex` is the column holding Neo IDs. Columns that collapse onto the
 * same key as an earlier column get a numeric suffix so no data is lost.
 */
export function buildMapping(
  headers: unknown[],
  neoIndex: number,
  existingKeys: Iterable<string>,
): MappedColumn[] {
  const existing = new Set(existingKeys);
  const used = new Set<string>([NEO_KEY]);

  return headers.map((h, index) => {
    const header = String(h ?? "").trim();
    if (index === neoIndex) {
      return { index, header, key: NEO_KEY, kind: "neo" as const };
    }

    let key = headerToKey(header);
    if (!key) {
      return { index, header, key: "", kind: "skipped" as const, note: "No header" };
    }
    if (key === NEO_KEY) key = "neo_id_2";

    const root = key;
    for (let n = 2; used.has(key); n++) key = `${root}_${n}`;
    key = key.slice(0, 63);

    if (!COLUMN_KEY_PATTERN.test(key)) {
      return { index, header, key: "", kind: "skipped" as const, note: "Header can't be used as a column name" };
    }

    used.add(key);
    return { index, header, key, kind: existing.has(key) ? ("existing" as const) : ("new" as const) };
  });
}

/**
 * Picks the column that holds Neo IDs: first by header name, otherwise the
 * column where nearly every filled cell is a valid Neo ID. Returns -1 if none.
 */
export function detectNeoColumn(headers: unknown[], rows: unknown[][]): number {
  const byHeader = headers.findIndex((h) => headerToKey(h) === NEO_KEY);
  if (byHeader !== -1) return byHeader;

  let best = -1;
  let bestShare = 0.8;
  for (let c = 0; c < headers.length; c++) {
    let filled = 0;
    let valid = 0;
    for (const row of rows) {
      const cell = row[c];
      if (cell === null || cell === undefined || String(cell).trim() === "") continue;
      filled++;
      if (isValidNeoId(String(cell).trim())) valid++;
    }
    if (filled > 0 && valid / filled >= bestShare) {
      best = c;
      bestShare = valid / filled;
    }
  }
  return best;
}

const PLAIN_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

/**
 * Normalises one spreadsheet cell. Blank cells return undefined ("no data"),
 * so a blank never overwrites a stored value.
 *
 * `parseNumbers` is for CSV, where every cell arrives as text. Values with
 * leading zeros ("0123") stay text so codes and phone numbers survive.
 */
export function cleanCell(value: unknown, parseNumbers = false): Cell | undefined {
  if (value === null || value === undefined) return undefined;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;

  const text = String(value).trim().slice(0, MAX_TEXT_LENGTH);
  if (text === "") return undefined;
  if (parseNumbers && text.length < 16 && PLAIN_NUMBER.test(text)) return Number(text);
  return text;
}

export interface ParsedRow {
  neoId: string;
  values: RecordData;
}

export interface ParseReport {
  rows: ParsedRow[];
  /** 1-based spreadsheet row numbers (header is row 1) with a bad or missing Neo ID. */
  invalid: { row: number; value: string }[];
  /** Neo IDs that appeared more than once; their rows were combined. */
  duplicates: number;
  blankRows: number;
}

/**
 * Converts raw sheet rows (after the header) into one record per Neo ID.
 * Repeated Neo IDs are combined, with later non-blank values winning.
 */
export function parseRows(
  rows: unknown[][],
  mapping: MappedColumn[],
  parseNumbers = false,
  /** Spreadsheet row number of each entry in `rows`, when blank rows were dropped before this call. */
  rowNumbers?: number[],
): ParseReport {
  const neo = mapping.find((m) => m.kind === "neo");
  const dataCols = mapping.filter((m) => m.kind === "existing" || m.kind === "new");

  const byId = new Map<string, RecordData>();
  const invalid: ParseReport["invalid"] = [];
  let duplicates = 0;
  let blankRows = 0;

  rows.forEach((row, i) => {
    const sheetRow = rowNumbers?.[i] ?? i + 2;
    const raw = neo ? row[neo.index] : undefined;
    const text = raw === null || raw === undefined ? "" : String(raw).trim();

    if (text === "") {
      const anyData = row.some((c) => c !== null && c !== undefined && String(c).trim() !== "");
      if (anyData) invalid.push({ row: sheetRow, value: "" });
      else blankRows++;
      return;
    }
    if (!isValidNeoId(text)) {
      invalid.push({ row: sheetRow, value: text });
      return;
    }

    const id = normalizeNeoId(text);
    let record = byId.get(id);
    if (record) duplicates++;
    else {
      record = {};
      byId.set(id, record);
    }
    for (const col of dataCols) {
      const cell = cleanCell(row[col.index], parseNumbers);
      if (cell !== undefined) record[col.key] = cell;
    }
  });

  return {
    rows: [...byId].map(([neoId, values]) => ({ neoId, values })),
    invalid,
    duplicates,
    blankRows,
  };
}
