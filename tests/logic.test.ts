import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMapping, cleanCell, detectNeoColumn, headerToKey, parseRows } from "../src/lib/columns";
import { mergeRecord } from "../src/lib/merge";
import { classifyTokens, explainNeoIdError, isValidNeoId, tokenize } from "../src/lib/neo";

describe("Neo ID validation", () => {
  it("accepts L-D-L-D-L-D-L-D in either case", () => {
    for (const ok of ["A1B2C3D4", "a1b2c3d4", "K1M3P5R7", "t2V4x6Z8"]) assert.ok(isValidNeoId(ok), ok);
  });

  it("rejects everything else", () => {
    const bad = [
      "", "A1B2C3D", "A1B2C3D45", "1A2B3C4D", "AA1B2C3D", "A1B2C3DD", "A1B2C3D-", "A1B2 C3D4",
      "A1B2C3D4\n", " A1B2C3D4", "Ａ1B2C3D4", "A1B2C3D٤", "ÀAB2C3D4",
    ];
    for (const b of bad) assert.ok(!isValidNeoId(b), JSON.stringify(b));
  });

  it("explains why", () => {
    assert.match(explainNeoIdError("A1B2C3")!, /6 characters/);
    assert.match(explainNeoIdError("A1B2C3D45")!, /9 characters/);
    assert.match(explainNeoIdError("1A2B3C4D")!, /Character 1 must be a letter, found “1”/);
    assert.match(explainNeoIdError("A1B2C3DD")!, /Character 8 must be a digit/);
    assert.equal(explainNeoIdError("A1B2C3D4"), null);
  });

  it("splits several IDs on a line and strips wrapping punctuation", () => {
    assert.deepEqual(tokenize("A1B2C3D4 K1M3P5R7,T2V4X6Z8;\nE9G7J5L3|N8Q6S4U2"), [
      "A1B2C3D4", "K1M3P5R7", "T2V4X6Z8", "E9G7J5L3", "N8Q6S4U2",
    ]);
    assert.deepEqual(tokenize(`"A1B2C3D4", 'K1M3P5R7' [T2V4X6Z8]. (E9G7J5L3):`), [
      "A1B2C3D4", "K1M3P5R7", "T2V4X6Z8", "E9G7J5L3",
    ]);
    assert.deepEqual(tokenize("  \n\t "), []);
  });

  it("ignores invalid words and keeps duplicate valid IDs detectable", () => {
    const c = classifyTokens(tokenize("A1B2C3D4 12:00 PM BAD a1b2c3d4 21st Oct 2026 A1B2C3D4"));
    assert.deepEqual(c.map((t) => t.status), ["valid", "duplicate", "duplicate"]);
    assert.deepEqual(c.map((t) => t.id), ["A1B2C3D4", "A1B2C3D4", "A1B2C3D4"]);
  });

  it("discards invalid tokens without affecting valid IDs around them", () => {
    const c = classifyTokens(tokenize("A1B2C3D4 A1B2C3D K1M3P5R7"));
    assert.deepEqual(c.map((t) => t.status), ["valid", "valid"]);
    assert.deepEqual(c.map((t) => t.id), ["A1B2C3D4", "K1M3P5R7"]);
  });
});

describe("Columns", () => {
  it("normalises headers and folds aliases", () => {
    assert.equal(headerToKey("Registration Number"), "registration_number");
    assert.equal(headerToKey("Reg No."), "registration_number");
    assert.equal(headerToKey("regno"), "registration_number");
    assert.equal(headerToKey("Full Name"), "full_name");
    assert.equal(headerToKey("Name"), "full_name");
    assert.equal(headerToKey("Neo ID"), "neo_id");
    assert.equal(headerToKey("NEO-ID"), "neo_id");
    assert.equal(headerToKey("UG Mark"), "ug_mark");
    assert.equal(headerToKey("CGPA"), "cgpa");
    assert.equal(headerToKey("  E-mail  "), "e_mail");
    assert.equal(headerToKey("___"), "");
    assert.equal(headerToKey("__proto__"), "proto");
  });

  it("finds the Neo ID column by header or by content", () => {
    assert.equal(detectNeoColumn(["Name", "Neo ID"], []), 1);
    assert.equal(detectNeoColumn(["Name", "Code"], [["x", "A1B2C3D4"], ["y", "K1M3P5R7"], ["z", ""]]), 1);
    assert.equal(detectNeoColumn(["Name", "Code"], [["x", "nope"], ["y", "K1M3P5R7"]]), -1);
  });

  it("maps new vs existing columns and never loses a duplicate header", () => {
    const m = buildMapping(["Neo ID", "Name", "Email", "email", "", "CGPA"], 0, ["full_name", "cgpa"]);
    assert.deepEqual(m.map((c) => [c.key, c.kind]), [
      ["neo_id", "neo"], ["full_name", "existing"], ["email", "new"], ["email_2", "new"], ["", "skipped"], ["cgpa", "existing"],
    ]);
  });

  it("cleans cells: blanks are no-data, numbers and dates survive", () => {
    assert.equal(cleanCell(null), undefined);
    assert.equal(cleanCell("   "), undefined);
    assert.equal(cleanCell(NaN), undefined);
    assert.equal(cleanCell(8.62), 8.62);
    assert.equal(cleanCell(0), 0);
    assert.equal(cleanCell(false), false);
    assert.equal(cleanCell("  Hi  "), "Hi");
    assert.equal(cleanCell(new Date("2024-03-05T00:00:00Z")), "2024-03-05");
    assert.equal(cleanCell("8.62", true), 8.62);
    assert.equal(cleanCell("0123", true), "0123");
    assert.equal(cleanCell("99ZZZ0001", true), "99ZZZ0001");
    assert.equal(cleanCell("8.62", false), "8.62");
  });

  it("parses rows: reports bad IDs, combines duplicates, skips blank rows", () => {
    const headers = ["Neo ID", "Name", "CGPA"];
    const rows: unknown[][] = [
      ["a1b2c3d4", "Asha", 8.5],
      ["K1M3P5R7", "Ravi", null],
      ["A1B2C3D4", null, 9.1], // duplicate of row 2: later non-blank wins, blank name keeps "Asha"
      ["BAD", "Nope", 7],
      [null, "No id", 7],
      [null, null, null],
    ];
    const mapping = buildMapping(headers, 0, []);
    const r = parseRows(rows, mapping);
    assert.deepEqual(r.rows, [
      { neoId: "A1B2C3D4", values: { full_name: "Asha", cgpa: 9.1 } },
      { neoId: "K1M3P5R7", values: { full_name: "Ravi" } },
    ]);
    assert.deepEqual(r.invalid, [{ row: 5, value: "BAD" }, { row: 6, value: "" }]);
    assert.equal(r.duplicates, 1);
    assert.equal(r.blankRows, 1);
  });
});

describe("Row numbers", () => {
  it("reports the spreadsheet's own row numbers when blank rows were dropped", () => {
    const mapping = buildMapping(["Neo ID", "Name"], 0, []);
    // Sheet rows: 1 header, 2 ok, 3-4 blank (dropped), 5 bad id, 6 ok
    const r = parseRows([["A1B2C3D4", "a"], ["BAD", "b"], ["K1M3P5R7", "c"]], mapping, false, [2, 5, 6]);
    assert.deepEqual(r.invalid, [{ row: 5, value: "BAD" }]);
  });
});

describe("Merging", () => {
  it("adds new fields, keeps blanks out, and respects overwrite", () => {
    const base = { full_name: "Asha", cgpa: 8 };
    const keep = mergeRecord(base, { cgpa: 9, email: "a@x.in", full_name: "Asha" }, false);
    assert.deepEqual(keep.merged, { full_name: "Asha", cgpa: 8, email: "a@x.in" });
    assert.deepEqual([keep.added, keep.changed, keep.unchanged, keep.skipped], [1, 0, 1, 1]);

    const over = mergeRecord(base, { cgpa: 9 }, true);
    assert.deepEqual(over.merged, { full_name: "Asha", cgpa: 9 });
    assert.deepEqual([over.added, over.changed], [0, 1]);

    assert.deepEqual(mergeRecord(undefined, { a: 1 }, false).merged, { a: 1 });
    assert.equal(base.cgpa, 8, "input is not mutated");
  });
});
