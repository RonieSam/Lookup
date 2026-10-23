import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { getReadyDb } from "../src/lib/db";
import { cleanCompanyName, changePlacements } from "../src/lib/placements";
import { HttpError, adminSummary, applyUpload, lookupStudents, validateUpload } from "../src/lib/students";
import { nextSort, sortRows } from "../src/lib/sort";
import { freshDb } from "./helpers";

describe("Company names", () => {
  it("trims, collapses spaces, and matches ignoring case", () => {
    assert.deepEqual(cleanCompanyName("  Tata   Consultancy\tServices "), { name: "Tata Consultancy Services", key: "tata consultancy services" });
    assert.equal(cleanCompanyName("TCS").key, cleanCompanyName(" tcs ").key);
    assert.equal(cleanCompanyName("Ｔｃｓ").key, "tcs", "full-width letters match too");
  });
  it("rejects empty, non-text and over-long names", () => {
    for (const bad of ["", "   ", "\n\t", null, undefined, 5, {}]) assert.throws(() => cleanCompanyName(bad), HttpError);
    assert.throws(() => cleanCompanyName("x".repeat(101)), HttpError);
    assert.doesNotThrow(() => cleanCompanyName("x".repeat(100)));
  });
});

describe("Placements", () => {
  let db: Awaited<ReturnType<typeof freshDb>>;
  before(async () => {
    await freshDb();
    db = await getReadyDb();
    await applyUpload(db, validateUpload({
      rows: [
        { neoId: "A1B2C3D4", values: { full_name: "Asha" } },
        { neoId: "K1M3P5R7", values: { full_name: "Ravi" } },
        { neoId: "T2V4X6Z8", values: { full_name: "Meera" } },
      ],
      columns: [{ key: "full_name", label: "Name" }], overwrite: false, dryRun: false,
    }));
  });

  const add = (company: string, text: string) => changePlacements(db, { action: "add", company, text });
  const remove = (company: string, text: string) => changePlacements(db, { action: "remove", company, text });

  it("places pasted IDs, ignoring non-ID words and repeats", async () => {
    const r = await add("Google", "A1B2C3D4 12:00 PM 21st K1M3P5R7, a1b2c3d4");
    assert.equal(r.company, "Google");
    assert.equal(r.ids, 2);
    assert.equal(r.ignored, 3); // 12:00, PM, 21st
    assert.equal(r.added, 2);
    assert.equal(r.alreadyIn, 0);
    assert.deepEqual(r.unknownStudents, { count: 0, sample: [] });
  });

  it("is idempotent: adding the same students again changes nothing", async () => {
    const r = await add("Google", "A1B2C3D4 K1M3P5R7");
    assert.equal(r.added, 0);
    assert.equal(r.alreadyIn, 2);
  });

  it("matches the company ignoring case and keeps the first spelling", async () => {
    const r = await add("  GOOGLE ", "T2V4X6Z8");
    assert.equal(r.company, "Google");
    assert.equal(r.added, 1);
    assert.deepEqual((await adminSummary(db)).companies, [{ name: "Google", count: 3 }]);
  });

  it("lets one student be in several companies, listed alphabetically", async () => {
    await add("Amazon", "A1B2C3D4");
    await add("microsoft", "A1B2C3D4 K1M3P5R7");
    const r = await lookupStudents(db, "A1B2C3D4 K1M3P5R7 T2V4X6Z8 Z9Z9Z9Z9");
    assert.equal(r.hasPlacements, true);
    assert.deepEqual(r.rows.map((x) => [x.neoId, x.companies]), [
      ["A1B2C3D4", ["Amazon", "Google", "microsoft"]],
      ["K1M3P5R7", ["Google", "microsoft"]],
      ["T2V4X6Z8", ["Google"]],
      ["Z9Z9Z9Z9", []],
    ]);
    assert.deepEqual((await adminSummary(db)).companies.map((c) => [c.name, c.count]), [["Amazon", 1], ["Google", 3], ["microsoft", 2]]);
  });

  it("saves placements for IDs with no student record yet, and reports them", async () => {
    const r = await add("Adobe", "E9G7J5L3 A1B2C3D4 N8Q6S4U2");
    assert.equal(r.added, 3);
    assert.deepEqual(r.unknownStudents, { count: 2, sample: ["E9G7J5L3", "N8Q6S4U2"] });
    const l = await lookupStudents(db, "E9G7J5L3");
    assert.equal(l.rows[0].status, "not_found");
    assert.deepEqual(l.rows[0].companies, ["Adobe"]);
  });

  it("removes only the IDs named, and counts IDs that weren't there", async () => {
    const r = await remove("google", "A1B2C3D4 N8Q6S4U2");
    assert.equal(r.removed, 1);
    assert.equal(r.notIn, 1);
    assert.equal(r.companyGone, false);
    assert.deepEqual((await lookupStudents(db, "A1B2C3D4")).rows[0].companies, ["Adobe", "Amazon", "microsoft"]);
  });

  it("removes a company once its last student is taken out", async () => {
    const r = await remove("Amazon", "A1B2C3D4");
    assert.equal(r.companyGone, true);
    assert.ok(!(await adminSummary(db)).companies.some((c) => c.name === "Amazon"));
  });

  it("deletes a whole company and its placements", async () => {
    const r = await changePlacements(db, { action: "delete_company", company: "MICROSOFT" });
    assert.equal(r.removed, 2);
    assert.equal(r.companyGone, true);
    assert.deepEqual((await lookupStudents(db, "K1M3P5R7")).rows[0].companies, ["Google"]);
  });

  it("refuses unknown companies, empty pastes and bad names", async () => {
    await assert.rejects(remove("Nope Inc", "A1B2C3D4"), { status: 404 });
    await assert.rejects(changePlacements(db, { action: "delete_company", company: "Nope Inc" }), { status: 404 });
    await assert.rejects(add("Google", "12:00 PM nothing here"), { status: 400 });
    await assert.rejects(add("Google", ""), { status: 400 });
    await assert.rejects(add("", "A1B2C3D4"), { status: 400 });
    await assert.rejects(changePlacements(db, { action: "add", company: "Google", text: 5 }), { status: 400 });
    assert.equal((await adminSummary(db)).companies.some((c) => c.name === ""), false, "no blank company was created");
  });

  it("a failed add leaves nothing half-written", async () => {
    const before = (await adminSummary(db)).companies.length;
    await assert.rejects(add("Ghost Co", "no ids at all"));
    assert.equal((await adminSummary(db)).companies.length, before, "no empty company was created");
  });

  it("is safe against SQL tricks in names and IDs", async () => {
    await add(`x'); drop table placements; --`, "A1B2C3D4");
    assert.ok((await adminSummary(db)).companies.some((c) => c.name.startsWith("x')")));
    assert.ok((await lookupStudents(db, "A1B2C3D4")).rows[0].companies.length >= 1);
  });

  it("lookup shows no Companies column data before any placement exists", async () => {
    await freshDb();
    const fresh = await getReadyDb();
    const r = await lookupStudents(fresh, "A1B2C3D4");
    assert.equal(r.hasPlacements, false);
    assert.deepEqual(r.rows[0].companies, []);
  });
});

describe("Sorting", () => {
  type R = { id: string; v?: string | number };
  const rows = (...vs: (string | number | undefined)[]): R[] => vs.map((v, i) => ({ id: `r${i}`, v }));
  const ids = (rs: R[]) => rs.map((r) => r.id).join(",");
  const val = (r: R) => r.v;

  it("sorts numbers numerically, both directions", () => {
    const rs = rows(8.9, 10, 8.64, 9.08);
    assert.deepEqual(sortRows(rs, val, "asc").map(val), [8.64, 8.9, 9.08, 10]);
    assert.deepEqual(sortRows(rs, val, "desc").map(val), [10, 9.08, 8.9, 8.64]);
  });

  it("sorts text naturally and ignoring case", () => {
    const rs = rows("99XYZ10034", "99xyz7271", "99XYZ1062", "Zed", "amy");
    assert.deepEqual(sortRows(rs, val, "asc").map(val), ["99XYZ1062", "99xyz7271", "99XYZ10034", "amy", "Zed"]);
    assert.deepEqual(sortRows(rs, val, "desc").map(val), ["Zed", "amy", "99XYZ10034", "99xyz7271", "99XYZ1062"]);
  });

  it("keeps empty cells at the bottom in both directions", () => {
    const rs = rows(undefined, 3, "", 1, 2);
    assert.deepEqual(sortRows(rs, val, "asc").map(val), [1, 2, 3, undefined, ""]);
    assert.deepEqual(sortRows(rs, val, "desc").map(val), [3, 2, 1, undefined, ""]);
  });

  it("treats zero as a value, not as empty", () => {
    assert.deepEqual(sortRows(rows(2, 0, 1), val, "asc").map(val), [0, 1, 2]);
  });

  it("keeps ties in their original order, in both directions", () => {
    const rs = rows("b", "a", "b", "a");
    assert.equal(ids(sortRows(rs, val, "asc")), "r1,r3,r0,r2");
    assert.equal(ids(sortRows(rs, val, "desc")), "r0,r2,r1,r3");
  });

  it("does not modify the input array", () => {
    const rs = rows(3, 1, 2);
    sortRows(rs, val, "asc");
    assert.deepEqual(rs.map(val), [3, 1, 2]);
  });

  it("header clicks: new column ascending, same column flips, and keeps flipping", () => {
    let s = nextSort(null, "cgpa");
    assert.deepEqual(s, { key: "cgpa", dir: "asc" });
    s = nextSort(s, "cgpa");
    assert.deepEqual(s, { key: "cgpa", dir: "desc" });
    s = nextSort(s, "cgpa");
    assert.deepEqual(s, { key: "cgpa", dir: "asc" });
    s = nextSort(s, "campus");
    assert.deepEqual(s, { key: "campus", dir: "asc" });
  });
});
