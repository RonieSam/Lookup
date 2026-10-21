import {
  COLUMN_KEY_PATTERN,
  MAX_COLUMNS,
  MAX_TEXT_LENGTH,
  NEO_KEY,
  type Cell,
  type ColumnDef,
  type RecordData,
} from "./columns";
import type { Db } from "./db";
import { mergeRecord } from "./merge";
import { classifyTokens, isValidNeoId, normalizeNeoId, tokenize } from "./neo";

export const MAX_LOOKUP_TOKENS = 5000;
export const MAX_UPLOAD_ROWS = 1000;

/* ------------------------------------------------------------------ */
/* Lookup                                                              */
/* ------------------------------------------------------------------ */

export type LookupStatus = "found" | "not_found" | "invalid";

export interface LookupRow {
  /** The word as typed, minus any wrapping quotes or brackets. */
  input: string;
  neoId: string;
  status: LookupStatus;
  reason?: string;
  /** How many times this ID appeared in the pasted text. */
  count: number;
  data?: RecordData;
}

export interface LookupResult {
  columns: ColumnDef[];
  rows: LookupRow[];
  summary: {
    words: number;
    unique: number;
    found: number;
    notFound: number;
    invalid: number;
    repeats: number;
  };
}

export async function lookupStudents(db: Db, text: string): Promise<LookupResult> {
  const classified = classifyTokens(tokenize(text));
  if (classified.length > MAX_LOOKUP_TOKENS) {
    throw new HttpError(413, `Too many words. Paste at most ${MAX_LOOKUP_TOKENS} at a time.`);
  }

  // One row per distinct input, in first-seen order, with repeat counts.
  const rows: LookupRow[] = [];
  const byKey = new Map<string, LookupRow>();
  let repeats = 0;

  for (const t of classified) {
    if (t.status === "duplicate") {
      byKey.get(t.id)!.count++;
      repeats++;
      continue;
    }
    const row: LookupRow = {
      input: t.raw,
      neoId: t.id,
      status: t.status === "invalid" ? "invalid" : "not_found",
      reason: t.reason,
      count: 1,
    };
    rows.push(row);
    if (t.status === "valid") byKey.set(t.id, row);
  }

  const ids = [...byKey.keys()];
  if (ids.length > 0) {
    const { rows: found } = await db.query<{ neo_id: string; data: RecordData }>(
      `select neo_id, data from students
       where neo_id in (select jsonb_array_elements_text($1::jsonb))`,
      [JSON.stringify(ids)],
    );
    for (const f of found) {
      const row = byKey.get(f.neo_id);
      if (row) {
        row.status = "found";
        row.data = f.data;
      }
    }
  }

  // Only show columns that have a value for at least one student in this result.
  const { rows: allColumns } = await db.query<ColumnDef>(
    "select key, label from student_columns order by position",
  );
  const used = new Set<string>();
  for (const r of rows) if (r.data) for (const k of Object.keys(r.data)) used.add(k);
  const columns = allColumns.filter((c) => used.has(c.key));

  const count = (s: LookupStatus) => rows.filter((r) => r.status === s).length;
  return {
    columns,
    rows,
    summary: {
      words: classified.length,
      unique: rows.length,
      found: count("found"),
      notFound: count("not_found"),
      invalid: count("invalid"),
      repeats,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Upload                                                              */
/* ------------------------------------------------------------------ */

export interface UploadRowInput {
  neoId: string;
  values: RecordData;
}

export interface UploadInput {
  rows: UploadRowInput[];
  columns: ColumnDef[];
  overwrite: boolean;
  dryRun: boolean;
}

export interface UploadStats {
  rows: number;
  newStudents: number;
  existingStudents: number;
  /** Students whose stored data would change (or be created). */
  studentsChanged: number;
  cellsAdded: number;
  cellsChanged: number;
  cellsUnchanged: number;
  /** Fields where the file disagreed but the stored value was kept. */
  cellsSkipped: number;
  newColumns: string[];
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function isCell(v: unknown): v is Cell {
  return (
    typeof v === "boolean" ||
    (typeof v === "number" && Number.isFinite(v)) ||
    (typeof v === "string" && v.length <= MAX_TEXT_LENGTH)
  );
}

/** Validates an upload payload from the browser. The server never trusts the client's checks. */
export function validateUpload(body: unknown): UploadInput {
  const b = body as Partial<UploadInput> | null;
  if (!b || typeof b !== "object") throw new HttpError(400, "Invalid request body.");
  if (!Array.isArray(b.rows) || !Array.isArray(b.columns)) throw new HttpError(400, "Expected rows and columns.");
  if (b.rows.length > MAX_UPLOAD_ROWS) throw new HttpError(413, `Send at most ${MAX_UPLOAD_ROWS} rows per request.`);
  if (b.columns.length > MAX_COLUMNS) throw new HttpError(400, `At most ${MAX_COLUMNS} columns are allowed.`);

  const columns: ColumnDef[] = [];
  const keys = new Set<string>();
  for (const c of b.columns) {
    const key = (c as ColumnDef)?.key;
    const label = (c as ColumnDef)?.label;
    if (typeof key !== "string" || !COLUMN_KEY_PATTERN.test(key) || key === NEO_KEY) {
      throw new HttpError(400, `Invalid column name: ${JSON.stringify(key)}.`);
    }
    if (typeof label !== "string" || label.trim() === "" || label.length > 100) {
      throw new HttpError(400, `Invalid label for column ${key}.`);
    }
    if (keys.has(key)) throw new HttpError(400, `Column ${key} is listed twice.`);
    keys.add(key);
    columns.push({ key, label: label.trim() });
  }

  const rows: UploadRowInput[] = [];
  const seen = new Set<string>();
  for (const r of b.rows) {
    const neoRaw = (r as UploadRowInput)?.neoId;
    if (typeof neoRaw !== "string" || !isValidNeoId(neoRaw.trim())) {
      throw new HttpError(400, `Invalid Neo ID: ${JSON.stringify(neoRaw)}.`);
    }
    const neoId = normalizeNeoId(neoRaw);
    if (seen.has(neoId)) throw new HttpError(400, `Neo ID ${neoId} appears twice in one request.`);
    seen.add(neoId);

    const values: RecordData = {};
    const raw = (r as { values?: unknown }).values as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "Invalid row values.");
    for (const [k, v] of Object.entries(raw)) {
      if (!keys.has(k)) throw new HttpError(400, `Row has a value for unknown column ${k}.`);
      if (!isCell(v)) throw new HttpError(400, `Invalid value for ${k} on ${neoId}.`);
      values[k] = v;
    }
    rows.push({ neoId, values });
  }

  return { rows, columns, overwrite: b.overwrite === true, dryRun: b.dryRun === true };
}

/**
 * Previews or applies one batch of uploaded rows.
 *
 * Preview and apply share the same merge code, so the preview numbers are
 * exactly what applying will do. Applying runs in one transaction with the
 * affected rows locked, and registers any new columns.
 */
export async function applyUpload(db: Db, input: UploadInput): Promise<UploadStats> {
  const run = async (q: Db, lock: boolean): Promise<UploadStats> => {
    const ids = input.rows.map((r) => r.neoId);
    const existing = new Map<string, RecordData>();
    if (ids.length > 0) {
      const { rows } = await q.query<{ neo_id: string; data: RecordData }>(
        `select neo_id, data from students
         where neo_id in (select jsonb_array_elements_text($1::jsonb))
         ${lock ? "for update" : ""}`,
        [JSON.stringify(ids)],
      );
      for (const r of rows) existing.set(r.neo_id, r.data);
    }

    const { rows: registered } = await q.query<{ key: string }>("select key from student_columns");
    const registeredKeys = new Set(registered.map((r) => r.key));
    const newColumns = input.columns.filter((c) => !registeredKeys.has(c.key));

    const stats: UploadStats = {
      rows: input.rows.length,
      newStudents: 0,
      existingStudents: 0,
      studentsChanged: 0,
      cellsAdded: 0,
      cellsChanged: 0,
      cellsUnchanged: 0,
      cellsSkipped: 0,
      newColumns: newColumns.map((c) => c.key),
    };

    const writes: { neo_id: string; data: RecordData }[] = [];
    for (const row of input.rows) {
      const before = existing.get(row.neoId);
      const result = mergeRecord(before, row.values, input.overwrite);
      stats.cellsAdded += result.added;
      stats.cellsChanged += result.changed;
      stats.cellsUnchanged += result.unchanged;
      stats.cellsSkipped += result.skipped;

      if (!before) {
        stats.newStudents++;
        stats.studentsChanged++;
        writes.push({ neo_id: row.neoId, data: result.merged });
      } else {
        stats.existingStudents++;
        if (result.added + result.changed > 0) {
          stats.studentsChanged++;
          writes.push({ neo_id: row.neoId, data: result.merged });
        }
      }
    }

    if (!input.dryRun) {
      if (newColumns.length > 0) {
        await q.query(
          `insert into student_columns (key, label, position)
           select x.key, x.label,
                  (select coalesce(max(position), 0) from student_columns) + x.ord
           from jsonb_to_recordset($1::jsonb) as x(key text, label text, ord integer)
           on conflict (key) do nothing`,
          [JSON.stringify(newColumns.map((c, i) => ({ ...c, ord: i + 1 })))],
        );
      }
      if (writes.length > 0) {
        await q.query(
          `insert into students (neo_id, data)
           select x.neo_id, x.data
           from jsonb_to_recordset($1::jsonb) as x(neo_id text, data jsonb)
           on conflict (neo_id) do update
             set data = excluded.data, updated_at = now()`,
          [JSON.stringify(writes)],
        );
      }
    }
    return stats;
  };

  return input.dryRun ? run(db, false) : db.transaction((tx) => run(tx, true));
}

/* ------------------------------------------------------------------ */
/* Admin summary                                                       */
/* ------------------------------------------------------------------ */

export async function adminSummary(db: Db) {
  // Sequential on purpose: each request then needs only one database connection,
  // which matters on free plans with tight connection limits.
  const { rows: count } = await db.query<{ n: string }>("select count(*)::text as n from students");
  const { rows: columns } = await db.query<ColumnDef>("select key, label from student_columns order by position");
  return { studentCount: Number(count[0]?.n ?? 0), columns };
}
