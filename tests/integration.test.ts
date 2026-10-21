import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { before, describe, it } from "node:test";
import { readSheet } from "read-excel-file/node";
import { buildMapping, detectNeoColumn, parseRows } from "../src/lib/columns";
import { getReadyDb } from "../src/lib/db";
import { applyUpload, adminSummary, lookupStudents, validateUpload, HttpError } from "../src/lib/students";
import { freshDb } from "./helpers";

async function upload(db: Awaited<ReturnType<typeof freshDb>>, rows: { neoId: string; values: Record<string, string | number> }[], columns: { key: string; label: string }[], opts: { overwrite?: boolean; dryRun?: boolean } = {}) {
  return applyUpload(db, validateUpload({ rows, columns, overwrite: false, dryRun: false, ...opts }));
}

describe("Upload and lookup", () => {
  let db: Awaited<ReturnType<typeof freshDb>>;
  before(async () => {
    await freshDb();
    db = await getReadyDb();
  });

  const base = [
    { key: "full_name", label: "Name" },
    { key: "cgpa", label: "CGPA" },
  ];

  it("creates the schema and stores a first upload", async () => {
    const stats = await upload(db, [
      { neoId: "A1B2C3D4", values: { full_name: "Asha", cgpa: 8.5 } },
      { neoId: "K1M3P5R7", values: { full_name: "Ravi" } },
    ], base);
    assert.equal(stats.newStudents, 2);
    assert.deepEqual(stats.newColumns, ["full_name", "cgpa"]);
    assert.deepEqual(await adminSummary(db), { studentCount: 2, columns: base });
  });

  it("dry run reports the same numbers and writes nothing", async () => {
    const rows = [{ neoId: "A1B2C3D4", values: { email: "asha@x.in" } }, { neoId: "E9G7J5L3", values: { email: "q@x.in" } }];
    const cols = [{ key: "email", label: "Email" }];
    const preview = await upload(db, rows, cols, { dryRun: true });
    assert.equal((await adminSummary(db)).studentCount, 2);
    assert.equal((await adminSummary(db)).columns.length, 2);
    const applied = await upload(db, rows, cols);
    assert.deepEqual({ ...applied, newColumns: [] }, { ...preview, newColumns: [] });
    assert.deepEqual(applied.newColumns, ["email"]);
  });

  it("adds a new column to existing students and keeps their old data", async () => {
    const r = await lookupStudents(db, "A1B2C3D4 e9g7j5l3");
    assert.deepEqual(r.columns.map((c) => c.key), ["full_name", "cgpa", "email"]);
    assert.deepEqual(r.rows[0].data, { full_name: "Asha", cgpa: 8.5, email: "asha@x.in" });
    assert.deepEqual(r.rows[1].data, { email: "q@x.in" });
  });

  it("keeps stored values unless overwrite is on, and never erases with blanks", async () => {
    const rows = [{ neoId: "A1B2C3D4", values: { cgpa: 9.9 } }];
    const kept = await upload(db, rows, base);
    assert.equal(kept.cellsSkipped, 1);
    assert.equal((await lookupStudents(db, "A1B2C3D4")).rows[0].data!.cgpa, 8.5);
    const changed = await upload(db, rows, base, { overwrite: true });
    assert.equal(changed.cellsChanged, 1);
    const after = (await lookupStudents(db, "A1B2C3D4")).rows[0].data!;
    assert.deepEqual(after, { full_name: "Asha", cgpa: 9.9, email: "asha@x.in" });
  });

  it("lookup classifies every word and counts repeats", async () => {
    const r = await lookupStudents(db, "A1B2C3D4, a1b2c3d4 Z9Z9Z9Z9 BAD123 K1M3P5R7\nA1B2C3D4");
    assert.deepEqual(r.rows.map((x) => [x.neoId, x.status, x.count]), [
      ["A1B2C3D4", "found", 3],
      ["Z9Z9Z9Z9", "not_found", 1],
      ["BAD123", "invalid", 1],
      ["K1M3P5R7", "found", 1],
    ]);
    assert.deepEqual(r.summary, { words: 6, unique: 4, found: 2, notFound: 1, invalid: 1, repeats: 2 });
    assert.match(r.rows[2].reason!, /6 characters/);
  });

  it("empty text returns an empty result", async () => {
    const r = await lookupStudents(db, "  \n ");
    assert.deepEqual(r.rows, []);
    assert.equal(r.summary.words, 0);
  });

  it("is safe against SQL and JSON tricks in IDs", async () => {
    const r = await lookupStudents(db, `'; drop table students;-- ") or 1=1 A1B2C3D4`);
    assert.equal(r.summary.found, 1);
    assert.equal((await adminSummary(db)).studentCount, 3);
  });

  it("rejects bad upload payloads", () => {
    const bad: unknown[] = [
      null,
      { rows: [{ neoId: "nope", values: {} }], columns: [] },
      { rows: [{ neoId: "A1B2C3D4", values: { x: "1" } }], columns: [] },
      { rows: [{ neoId: "A1B2C3D4", values: {} }, { neoId: "a1b2c3d4", values: {} }], columns: [] },
      { rows: [], columns: [{ key: "__proto__", label: "x" }] },
      { rows: [], columns: [{ key: "neo_id", label: "x" }] },
      { rows: [], columns: [{ key: "Has Space", label: "x" }] },
      { rows: [{ neoId: "A1B2C3D4", values: { a: { nested: 1 } } }], columns: [{ key: "a", label: "a" }] },
      { rows: [{ neoId: "A1B2C3D4", values: { a: "x".repeat(501) } }], columns: [{ key: "a", label: "a" }] },
      { rows: new Array(1001).fill({ neoId: "A1B2C3D4", values: {} }), columns: [] },
    ];
    for (const b of bad) assert.throws(() => validateUpload(b), HttpError, JSON.stringify(b).slice(0, 80));
  });

  it("the database itself refuses a malformed Neo ID", async () => {
    await assert.rejects(db.query("insert into students (neo_id) values ('a1b2c3d4')"));
    await assert.rejects(db.query("insert into students (neo_id) values ('A1B2C3D')"));
  });
});

const SAMPLE = process.env.NEO_SAMPLE_XLSX;
describe("Your real spreadsheet", { skip: !SAMPLE || !existsSync(SAMPLE) }, () => {
  it("loads in batches, and every student can be found again", async () => {
    await freshDb();
    const db = await getReadyDb();
    const sheet = (await readSheet(SAMPLE!)) as unknown[][];
    const [headers, ...rows] = sheet;
    const neoIndex = detectNeoColumn(headers, rows);
    assert.equal(neoIndex, 4);
    const mapping = buildMapping(headers, neoIndex, []);
    const report = parseRows(rows, mapping);
    assert.equal(report.rows.length, 4351);
    assert.equal(report.invalid.length, 0);
    assert.equal(report.duplicates, 0);

    const columns = mapping.filter((m) => m.kind === "new").map((m) => ({ key: m.key, label: m.header }));
    assert.deepEqual(columns.map((c) => c.key), ["registration_number", "full_name", "campus", "ug_mark"]);

    for (let i = 0; i < report.rows.length; i += 500) {
      await applyUpload(db, validateUpload({ rows: report.rows.slice(i, i + 500), columns, overwrite: false, dryRun: false }));
    }
    assert.equal((await adminSummary(db)).studentCount, 4351);

    // Every student comes back with exactly the values the spreadsheet holds.
    const all = await lookupStudents(db, report.rows.map((r) => r.neoId).join("\n"));
    assert.equal(all.summary.found, 4351);
    assert.equal(all.summary.invalid + all.summary.notFound, 0);
    const expected = new Map(report.rows.map((r) => [r.neoId, r.values]));
    for (const row of all.rows) assert.deepEqual(row.data, expected.get(row.neoId), row.neoId);

    // Lower-case input finds the same student; junk beside it is flagged without harm.
    const sample = report.rows[7].neoId;
    const mixed = await lookupStudents(db, `${sample.toLowerCase()} NOPE0000 A1B2C3`);
    assert.equal(mixed.rows[0].status, "found");
    assert.deepEqual(mixed.rows[0].data, expected.get(sample));
    assert.equal(mixed.rows[1].status, "invalid");
    assert.equal(mixed.rows[2].status, "invalid");

    // Re-uploading the same file changes nothing.
    const again = await applyUpload(db, validateUpload({ rows: report.rows.slice(0, 500), columns, overwrite: true, dryRun: true }));
    assert.equal(again.studentsChanged, 0);
    assert.equal(again.newColumns.length, 0);
  });
});
