import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { getReadyDb } from "../src/lib/db";
import { MAX_FIND_RESULTS, findStudents } from "../src/lib/find";
import { changePlacements } from "../src/lib/placements";
import { MAX_SEARCH_TERMS, cellHas, rowMatches, searchTerms } from "../src/lib/search";
import { applyUpload, validateUpload } from "../src/lib/students";
import { freshDb } from "./helpers";

describe("Search rules", () => {
  it("splits into folded, distinct words and caps how many", () => {
    assert.deepEqual(searchTerms("  Alpha   VELLORE\tALPHA "), ["alpha", "vellore"]);
    assert.deepEqual(searchTerms("Ａｌｐｈａ"), ["alpha"], "full-width letters fold to plain ones");
    assert.deepEqual(searchTerms("   "), []);
    assert.deepEqual(searchTerms(""), []);
    assert.equal(searchTerms("a b c d e f g h i j k").length, MAX_SEARCH_TERMS);
  });

  it("matches a word anywhere inside a cell, ignoring case", () => {
    assert.ok(cellHas("Chennai", "enna"));
    assert.ok(cellHas("99XYZ0001", "xyz00"));
    assert.ok(cellHas("7.77", "7.7"));
    assert.ok(!cellHas("Chennai", "vellore"));
  });

  it("needs every word to match, each in any column", () => {
    const cells = ["A1B2C3D4", "Found", "Alpha Rivera", "Vellore", "Google"];
    assert.ok(rowMatches(cells, ["alpha"]));
    assert.ok(rowMatches(cells, ["alpha", "vellore", "google"]), "words may match different columns");
    assert.ok(!rowMatches(cells, ["alpha", "chennai"]), "one missing word rules the row out");
    assert.ok(rowMatches(cells, []), "nothing typed shows everything");
    assert.ok(!rowMatches([], ["x"]));
  });
});

const ID = (n: number) => {
  const d = String(n).padStart(4, "0");
  return `Q${d[0]}W${d[1]}E${d[2]}R${d[3]}`; // Q0W0E0R1 … : always letter-digit ×4
};

describe("Admin database search", () => {
  let db: Awaited<ReturnType<typeof freshDb>>;
  const people = [
    { neoId: "A1B2C3D4", values: { registration_number: "99XYZ0001", full_name: "Alpha Rivera", campus: "Vellore", ug_mark: 7.77 } },
    { neoId: "K1M3P5R7", values: { registration_number: "99XYZ0002", full_name: "Bravo Singh", campus: "Chennai", ug_mark: 6.66 } },
    { neoId: "T2V4X6Z8", values: { registration_number: "99XYZ0003", full_name: "Zed_50%", campus: "Bhopal", ug_mark: 9 } },
  ];
  const columns = [
    { key: "registration_number", label: "Registration Number" },
    { key: "full_name", label: "Full Name" },
    { key: "campus", label: "Campus" },
    { key: "ug_mark", label: "UG Mark" },
  ];
  const ids = async (q: string) => (await findStudents(db, q)).hits.map((h) => h.neoId);

  before(async () => {
    await freshDb();
    db = await getReadyDb();
    await applyUpload(db, validateUpload({ rows: people, columns, overwrite: false, dryRun: false }));
    await changePlacements(db, { action: "add", company: "Google", text: "A1B2C3D4 K1M3P5R7" });
    await changePlacements(db, { action: "add", company: "Adobe", text: "A1B2C3D4 E9G7J5L3" }); // E9G7J5L3 has no student record
  });

  it("finds by name, ignoring case and matching part of a word", async () => {
    assert.deepEqual(await ids("alpha"), ["A1B2C3D4"]);
    assert.deepEqual(await ids("RAVO"), ["K1M3P5R7"]);
  });

  it("finds by Neo ID, even a lower-case fragment", async () => {
    assert.deepEqual(await ids("k1m3"), ["K1M3P5R7"]);
    assert.deepEqual(await ids("t2v4x6z8"), ["T2V4X6Z8"]);
  });

  it("finds by any detail column, including numbers", async () => {
    assert.deepEqual(await ids("xyz0002"), ["K1M3P5R7"]);
    assert.deepEqual(await ids("vellore"), ["A1B2C3D4"]);
    assert.deepEqual(await ids("6.6"), ["K1M3P5R7"]);
  });

  it("finds by company, and reports every company alphabetically", async () => {
    const r = await findStudents(db, "google");
    assert.deepEqual(r.hits.map((h) => h.neoId), ["A1B2C3D4", "K1M3P5R7"]);
    assert.deepEqual(r.hits[0].companies, ["Adobe", "Google"]);
    assert.deepEqual(r.hits[1].companies, ["Google"]);
  });

  it("finds someone who has placements but no student record", async () => {
    const r = await findStudents(db, "adobe");
    assert.deepEqual(r.hits.map((h) => [h.neoId, h.inStudents]), [["A1B2C3D4", true], ["E9G7J5L3", false]]);
    assert.deepEqual(r.hits[1].data, {});
    assert.deepEqual((await findStudents(db, "e9g7")).hits.map((h) => h.neoId), ["E9G7J5L3"]);
  });

  it("needs every word to match, each in any column", async () => {
    assert.deepEqual(await ids("alpha google"), ["A1B2C3D4"]);
    assert.deepEqual(await ids("vellore adobe"), ["A1B2C3D4"]);
    assert.deepEqual(await ids("chennai adobe"), [], "Bravo is in Google, not Adobe");
    assert.deepEqual(await ids("google chennai 6.66"), ["K1M3P5R7"]);
  });

  it("doesn't match column names, only the values in them", async () => {
    assert.deepEqual(await ids("full_name"), []);
    assert.deepEqual(await ids("registration"), []);
    assert.deepEqual(await ids("ug_mark"), []);
  });

  it("treats % and _ as ordinary characters", async () => {
    assert.deepEqual(await ids("%"), ["T2V4X6Z8"], "only the value containing a percent sign");
    assert.deepEqual(await ids("_"), ["T2V4X6Z8"]);
    assert.deepEqual(await ids("50%"), ["T2V4X6Z8"]);
    assert.deepEqual(await ids("zed_"), ["T2V4X6Z8"]);
    assert.deepEqual(await ids("z_d"), [], "_ is not a wildcard for 'e'");
    assert.deepEqual(await ids("\\"), []);
  });

  it("is safe against SQL tricks", async () => {
    const r = await findStudents(db, `'; drop table students; -- ") or 1=1`);
    assert.equal(r.total, 0);
    assert.deepEqual(await ids("alpha"), ["A1B2C3D4"], "tables are intact");
  });

  it("matches full-width letters the way the browser does", async () => {
    assert.deepEqual(await ids("ａｌｐｈａ"), ["A1B2C3D4"]);
  });

  it("returns the first 100 matches in Neo ID order, and the real total", async () => {
    const bulk = Array.from({ length: 130 }, (_, i) => ({ neoId: ID(i + 1), values: { campus: "Bulk" } }));
    for (let i = 0; i < bulk.length; i += 65) {
      await applyUpload(db, validateUpload({ rows: bulk.slice(i, i + 65), columns, overwrite: false, dryRun: false }));
    }
    const r = await findStudents(db, "bulk");
    assert.equal(r.total, 130);
    assert.equal(r.hits.length, MAX_FIND_RESULTS);
    const sorted = [...r.hits.map((h) => h.neoId)].sort();
    assert.deepEqual(r.hits.map((h) => h.neoId), sorted);
    assert.equal(r.hits[0].neoId, ID(1));
  });

  it("rejects empty, non-text and over-long searches", async () => {
    for (const bad of ["", "   ", "\n\t", null, undefined, 5, {}]) await assert.rejects(findStudents(db, bad), { status: 400 });
    await assert.rejects(findStudents(db, "x".repeat(101)), { status: 400 });
    assert.equal((await findStudents(db, "x".repeat(100))).total, 0);
  });

  it("ignores words beyond the eighth", async () => {
    // Repeated words count once, then only the first eight distinct words are used.
    const r = await findStudents(db, "alpha vellore 7.77 99xyz0001 a1b2 google adobe alpha rivera zzzzzz");
    assert.equal(r.terms.length, 8);
    assert.deepEqual(r.terms.slice(-1), ["rivera"]);
    assert.equal(r.total, 1, "the ninth distinct word 'zzzzzz' was ignored");
  });

  it("gives the same answers as the results-table search for the same queries", async () => {
    // Rebuild each person's cells the way the table shows them, then compare with the database.
    const everyone = await findStudents(db, "a");
    const all = (await db.query<{ neo_id: string }>("select neo_id from (select neo_id from students union select neo_id from placements) x order by 1")).rows;
    assert.ok(all.length > everyone.hits.length || all.length > 0);
    const people = new Map<string, string[]>();
    for (const { neo_id } of all) {
      const hit = (await findStudents(db, neo_id.toLowerCase())).hits.find((h) => h.neoId === neo_id)!;
      people.set(neo_id, [hit.neoId, ...Object.values(hit.data).map(String), ...hit.companies]);
    }
    for (const q of ["alpha", "google", "alpha google", "vellore adobe", "chennai adobe", "6.6", "50%", "z_d", "ａｌｐｈａ", "bulk", "q0w0", "e9g7 adobe", "campus"]) {
      const inBrowser = [...people].filter(([, cells]) => rowMatches(cells, searchTerms(q))).map(([id]) => id).sort();
      const inDb = (await findStudents(db, q)).hits.map((h) => h.neoId);
      const inDbAll = q === "bulk" ? inDb : inDb; // bulk exceeds the 100-row cap; compared separately below
      if (q === "bulk") {
        assert.equal(inBrowser.length, 130);
        assert.deepEqual(inBrowser.slice(0, MAX_FIND_RESULTS), inDbAll);
      } else {
        assert.deepEqual(inDbAll, inBrowser, `query: ${q}`);
      }
    }
  });
});
