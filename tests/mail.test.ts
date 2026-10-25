import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import { getReadyDb } from "../src/lib/db";
import { createGmailClient, gmailConfigured, type GmailClient, type GmailMessage } from "../src/lib/gmail";
import { extractCompany, extractNeoIds, htmlToText } from "../src/lib/mailParse";
import { MAX_MAILS_PER_SYNC, mailSyncStatus, previewSync, saveSync, validateDecisions } from "../src/lib/mailSync";
import { adminSummary, lookupStudents } from "../src/lib/students";
import { freshDb } from "./helpers";

/* ---------------------------------------------------------------- parsing */

describe("Company from the subject line", () => {
  const cases: [string, string | null][] = [
    ["Congratulations ! E.I.D. – Parry (India) Murugappa Group Dream Core Internship Selection List!!", "E.I.D. – Parry (India) Murugappa Group"],
    ["Congratulations !! Sobha Limited Dream Core Internship selection list - 2027 Batch !!", "Sobha Limited"],
    ["Congratulations !! Myntra Super Dream Internship Selection list - 2027 Batch !!", "Myntra"],
    ["Congratulations!! Urban Company Dream Internship / Placement Offer Selection List - 2027 Batch - VLR", "Urban Company"],
    ["Congratulations !! Valeo Regular Internship Selection List!! - Additional", "Valeo"],
    // other shapes
    ["Re: Fwd: Congratulations !! Valeo Regular Internship Selection List", "Valeo"],
    ["CONGRATULATIONS!! VALEO REGULAR INTERNSHIP SELECTION LIST", "VALEO"],
    ["Congratulations !! Core Compete Dream Internship Selection List", "Core Compete"],
    ["Congratulations !! Dream11 Super Dream Internship Selection List", "Dream11"],
    ["Congratulations !! Acme Internship Selection List", "Acme"],
    ["Congratulations !! Acme Marquee Placement Selection List", "Acme"],
    ["  Congratulations   !!   Tata   Steel  Dream  Internship  Selection List ", "Tata Steel"],
    // not usable: the admin types the company in
    ["Interview schedule for Google - 2027 batch", null],
    ["Congratulations !! Selection List", null],
    ["Congratulations !! Dream Internship Selection List", null],
    ["", null],
  ];
  for (const [subject, company] of cases) {
    it(`${JSON.stringify(company)} <- ${subject.trim().slice(0, 60)}`, () => assert.equal(extractCompany(subject), company));
  }
  it("refuses an absurdly long company", () => {
    assert.equal(extractCompany(`Congratulations ${"x".repeat(150)} Dream Internship Selection List`), null);
  });
});

describe("Neo IDs from the body", () => {
  it("reads the layouts seen in real mails", () => {
    const withLabel = "Congratulations !! \n\nSobha Limited Dream Core Internship selection list - 2027 Batch !!\n\n\nNeo ID\nQ1W2E3R4\nZ9X8C7V6\n";
    assert.deepEqual(extractNeoIds(withLabel), ["Q1W2E3R4", "Z9X8C7V6"]);
    const noLabel = "Congratulations !\n\n E.I.D. – Parry (India) Murugappa Group Dream Core Internship Selection List!!\n\nP0O9I8U7\nL1K2J3H4\n";
    assert.deepEqual(extractNeoIds(noLabel), ["P0O9I8U7", "L1K2J3H4"]);
    assert.deepEqual(extractNeoIds("NEO ID\nM5N6B7V8\n"), ["M5N6B7V8"]);
  });
  it("accepts IDs separated by commas, spaces or in a table, any case, once each", () => {
    assert.deepEqual(extractNeoIds("q1w2e3r4, Z9X8C7V6 ; P0O9I8U7\tL1K2J3H4 Q1W2E3R4"), ["Q1W2E3R4", "Z9X8C7V6", "P0O9I8U7", "L1K2J3H4"]);
  });
  it("does not pick IDs out of web addresses or longer codes", () => {
    const footer = "https://groups.google.com/a/example.ac.in/d/msgid/q1w2e3r4/CAB1C2D3E4F5 ref-A1B2C3D4E5 vitianscdc2027+unsubscribe@example.ac.in";
    assert.deepEqual(extractNeoIds(footer), []);
  });
  it("finds nothing in a mail without IDs", () => assert.deepEqual(extractNeoIds("Congratulations to all! 2027 Batch"), []));
});

describe("HTML bodies", () => {
  it("turns an HTML list into lines of text", () => {
    const html = "<html><head><style>p{color:red}</style></head><body><p>Neo&nbsp;ID</p><div>Q1W2E3R4<br>Z9X8C7V6</div><table><tr><td>P0O9I8U7</td><td>L1K2J3H4</td></tr></table></body></html>";
    assert.deepEqual(extractNeoIds(htmlToText(html)), ["Q1W2E3R4", "Z9X8C7V6", "P0O9I8U7", "L1K2J3H4"]);
    assert.ok(!htmlToText(html).includes("color:red"));
  });
  it("decodes entities, including numbers", () => {
    assert.equal(htmlToText("A &amp; B &lt;C&gt; &#8211; &#x41; &quot;").replace(/\s+/g, " ").trim(), 'A & B <C> – A "');
    assert.equal(htmlToText("&#99999999999;").trim(), "", "out-of-range numbers don't throw");
  });
});

/* ------------------------------------------------------- Gmail client */

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const ENV = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REFRESH_TOKEN: "refresh" };
const savedEnv = { ...process.env };
function setGoogleEnv() { Object.assign(process.env, ENV); }
afterEach(() => {
  for (const k of [...Object.keys(ENV), "MAIL_SYNC_QUERY"]) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

interface Call { url: string; init?: RequestInit }
function fakeFetch(routes: (url: URL, init?: RequestInit) => unknown | Response, calls: Call[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    const out = routes(url, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const tokenOk = (url: URL) => (url.hostname === "oauth2.googleapis.com" ? { access_token: "tok-1", expires_in: 3600 } : undefined);

describe("Gmail client", () => {
  it("reports whether it is set up", () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    assert.equal(gmailConfigured(), false);
    setGoogleEnv();
    assert.equal(gmailConfigured(), true);
    delete process.env.GOOGLE_REFRESH_TOKEN;
    assert.equal(gmailConfigured(), false);
  });

  it("exchanges the refresh token once and sends it as a bearer token", async () => {
    setGoogleEnv();
    const calls: Call[] = [];
    const gmail = createGmailClient(fakeFetch((url) => tokenOk(url) ?? { messages: [{ id: "m1" }] }, calls));
    await gmail.listMessageIds("subject:x", 10);
    await gmail.listMessageIds("subject:x", 10);
    const tokenCalls = calls.filter((c) => c.url.startsWith("https://oauth2.googleapis.com/token"));
    assert.equal(tokenCalls.length, 1, "the token is reused");
    const form = new URLSearchParams(String(tokenCalls[0].init!.body));
    assert.deepEqual(Object.fromEntries(form), { client_id: "cid", client_secret: "secret", refresh_token: "refresh", grant_type: "refresh_token" });
    const api = calls.find((c) => c.url.includes("gmail.googleapis.com"))!;
    assert.equal((api.init!.headers as Record<string, string>).authorization, "Bearer tok-1");
  });

  it("follows pages until it has enough, and stops at the limit", async () => {
    setGoogleEnv();
    const calls: Call[] = [];
    const pages: Record<string, unknown> = {
      "": { messages: [{ id: "a" }, { id: "b" }], nextPageToken: "p2" },
      p2: { messages: [{ id: "c" }, { id: "d" }], nextPageToken: "p3" },
      p3: { messages: [{ id: "e" }] },
    };
    const gmail = createGmailClient(fakeFetch((url) => tokenOk(url) ?? pages[url.searchParams.get("pageToken") ?? ""], calls));
    assert.deepEqual(await gmail.listMessageIds('subject:"selection list" after:100', 300), ["a", "b", "c", "d", "e"]);
    const first = new URL(calls.find((c) => c.url.includes("/messages?"))!.url);
    assert.equal(first.searchParams.get("q"), 'subject:"selection list" after:100');
    assert.deepEqual(await gmail.listMessageIds("q", 3), ["a", "b", "c", "d"].slice(0, 4).slice(0, 4).length === 4 ? ["a", "b", "c", "d"] : []);
  });

  it("returns nothing when no mail matches", async () => {
    setGoogleEnv();
    const gmail = createGmailClient(fakeFetch((url) => tokenOk(url) ?? { resultSizeEstimate: 0 }));
    assert.deepEqual(await gmail.listMessageIds("q", 10), []);
  });

  it("reads a nested multipart message, including non-English characters", async () => {
    setGoogleEnv();
    const message = {
      id: "m1", internalDate: String(Date.UTC(2026, 9, 21, 9, 38, 0)),
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "subject", value: "Congratulations !! Café – Dream Internship Selection List" }, { name: "From", value: "'No Reply' via Group <g@x.ac.in>" }],
        parts: [
          { mimeType: "multipart/alternative", parts: [
            { mimeType: "text/plain", body: { data: b64("Neo ID\nQ1W2E3R4\nZ9X8C7V6 – ok") } },
            { mimeType: "text/html", body: { data: b64("<p>HTML copy P0O9I8U7</p>") } },
          ] },
          { mimeType: "application/pdf", filename: "list.pdf", body: { data: b64("Q9Q9Q9Q9") } },
        ],
      },
    };
    const gmail = createGmailClient(fakeFetch((url) => tokenOk(url) ?? message));
    const m: GmailMessage = await gmail.getMessage("m1");
    assert.equal(m.subject, "Congratulations !! Café – Dream Internship Selection List");
    assert.equal(m.from, "'No Reply' via Group <g@x.ac.in>");
    assert.equal(m.date, "2026-10-21T09:38:00.000Z");
    assert.deepEqual(extractNeoIds(m.text), ["Q1W2E3R4", "Z9X8C7V6"], "plain text wins; attachments are ignored");
  });

  it("falls back to HTML when there is no plain text", async () => {
    setGoogleEnv();
    const message = { id: "m2", internalDate: "1", payload: { mimeType: "text/html", headers: [], body: { data: b64("<div>Q1W2E3R4<br>Z9X8C7V6</div>") } } };
    const m = await createGmailClient(fakeFetch((url) => tokenOk(url) ?? message)).getMessage("m2");
    assert.deepEqual(extractNeoIds(m.text), ["Q1W2E3R4", "Z9X8C7V6"]);
  });

  it("explains each way Google can say no, without echoing Google's reply", async () => {
    setGoogleEnv();
    const failing = (status: number, body: unknown) => createGmailClient(fakeFetch(() => new Response(JSON.stringify(body), { status })));
    await assert.rejects(failing(400, { error: "invalid_grant", error_description: "SECRET-DETAIL" }).listMessageIds("q", 1), (e: Error) => /no longer accepts/.test(e.message) && !e.message.includes("SECRET-DETAIL"));
    await assert.rejects(failing(401, { error: "invalid_client" }).listMessageIds("q", 1), /GOOGLE_CLIENT_ID/);
    await assert.rejects(failing(500, {}).listMessageIds("q", 1), /error 500/);

    const apiFail = (status: number) => createGmailClient(fakeFetch((url) => tokenOk(url) ?? new Response("{}", { status })));
    await assert.rejects(apiFail(401).listMessageIds("q", 1), /no longer accepts/);
    await assert.rejects(apiFail(403).listMessageIds("q", 1), /Gmail refused access/);
    await assert.rejects(apiFail(429).listMessageIds("q", 1), /limiting requests/);
    await assert.rejects(apiFail(503).listMessageIds("q", 1), /\(503\)/);
  });

  it("tries the sign-in again after a failure instead of remembering it", async () => {
    setGoogleEnv();
    let n = 0;
    const gmail = createGmailClient(fakeFetch((url) => {
      if (url.hostname === "oauth2.googleapis.com") return ++n === 1 ? new Response("{}", { status: 500 }) : { access_token: "t" };
      return { messages: [] };
    }));
    await assert.rejects(gmail.listMessageIds("q", 1));
    assert.deepEqual(await gmail.listMessageIds("q", 1), []);
  });
});

/* -------------------------------------------------------------- sync */

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 9, 1, 6, 0, 0); // 1 Oct 2026

class FakeGmail implements GmailClient {
  messages: GmailMessage[] = [];
  queries: string[] = [];
  fetched: string[] = [];
  add(id: string, subject: string, body: string, at: number) {
    this.messages.push({ id, subject, from: "cdc@x.ac.in", date: new Date(at).toISOString(), text: body });
  }
  async listMessageIds(query: string, max: number) {
    this.queries.push(query);
    const after = Number(/after:(\d+)/.exec(query)?.[1] ?? 0);
    return [...this.messages].filter((m) => Date.parse(m.date) >= after * 1000).sort((a, b) => b.date.localeCompare(a.date)).slice(0, max).map((m) => m.id);
  }
  async getMessage(id: string) {
    this.fetched.push(id);
    return this.messages.find((m) => m.id === id)!;
  }
}

const SOBHA = "Congratulations !! Sobha Limited Dream Core Internship selection list - 2027 Batch !!";
const MYNTRA = "Congratulations !! Myntra Super Dream Internship Selection list - 2027 Batch !!";
const VALEO = "Congratulations !! Valeo Regular Internship Selection List!! - Additional";

describe("Mail sync", () => {
  let db: Awaited<ReturnType<typeof freshDb>>;
  let gm: FakeGmail;
  beforeEach(async () => {
    await freshDb();
    db = await getReadyDb();
    gm = new FakeGmail();
  });

  const confirm = (p: Awaited<ReturnType<typeof previewSync>>) =>
    validateDecisions({ mails: p.mails.map((m) => ({ id: m.id, subject: m.subject, date: m.date, company: m.company, ids: m.ids })) });

  it("needs a start date the first time", async () => {
    await assert.rejects(previewSync(db, gm, {}), { status: 400, message: /first sync/ });
    assert.equal(gm.queries.length, 0, "Gmail isn't even asked");
  });

  it("reads new mail since the chosen date, oldest first, with company and IDs worked out", async () => {
    gm.add("old", VALEO, "NEO ID\nM5N6B7V8", Date.UTC(2026, 8, 22, 5, 54)); // before the start date
    gm.add("m2", MYNTRA, "Neo ID\nQ1W2E3R4\nZ9X8C7V6", t0 + 2 * DAY);
    gm.add("m1", SOBHA, "Neo ID\nP0O9I8U7\nL1K2J3H4", t0 + 1 * DAY);
    gm.add("m3", "Interview schedule for Google", "see you at 10:00", t0 + 3 * DAY);
    const p = await previewSync(db, gm, { since: "2026-10-01" });
    assert.match(gm.queries[0], /^subject:"selection list" after:\d+$/);
    assert.equal(Number(/after:(\d+)/.exec(gm.queries[0])![1]), Date.UTC(2026, 9, 1) / 1000, "an exact timestamp, not a date");
    assert.deepEqual(p.mails.map((m) => [m.id, m.company, m.ids]), [
      ["m1", "Sobha Limited", ["P0O9I8U7", "L1K2J3H4"]],
      ["m2", "Myntra", ["Q1W2E3R4", "Z9X8C7V6"]],
      ["m3", null, []],
    ]);
    assert.equal(p.waiting, 0);
    assert.equal(p.alreadySynced, 0);
  });

  it("saves nothing until confirmed", async () => {
    gm.add("m1", SOBHA, "P0O9I8U7", t0 + DAY);
    await previewSync(db, gm, { since: "2026-10-01" });
    assert.equal((await adminSummary(db)).companies.length, 0);
    assert.equal((await mailSyncStatus(db)).lastSyncedAt, null);
  });

  it("saves placements, remembers the date, and then only looks at newer mail", async () => {
    gm.add("m1", SOBHA, "P0O9I8U7 L1K2J3H4", t0 + 1 * DAY);
    gm.add("m2", MYNTRA, "Q1W2E3R4", t0 + 2 * DAY);
    const saved = await saveSync(db, await previewSync(db, gm, { since: "2026-10-01" }).then(confirm));
    assert.deepEqual(saved.saved.map((s) => [s.company, s.added]), [["Sobha Limited", 2], ["Myntra", 1]]);
    assert.equal(saved.checkedUpTo, new Date(t0 + 2 * DAY).toISOString());
    assert.deepEqual((await adminSummary(db)).companies, [{ name: "Myntra", count: 1 }, { name: "Sobha Limited", count: 2 }]);
    assert.deepEqual((await lookupStudents(db, "P0O9I8U7")).rows[0].companies, ["Sobha Limited"]);

    const status = await mailSyncStatus(db);
    assert.equal(status.checkedUpTo, new Date(t0 + 2 * DAY).toISOString());
    assert.ok(status.lastSyncedAt);

    // a new mail arrives; the next sync (no date given) fetches only that one
    gm.add("m3", VALEO, "NEO ID\nM5N6B7V8", t0 + 5 * DAY);
    gm.fetched = [];
    const next = await previewSync(db, gm, { });
    assert.deepEqual(next.mails.map((m) => m.id), ["m3"]);
    assert.deepEqual(gm.fetched, ["m3"], "mails handled before are not read again");
    assert.equal(next.alreadySynced, 2, "the overlap window re-lists them, but they're recognised");
    assert.equal(Number(/after:(\d+)/.exec(gm.queries.at(-1)!)![1]), (t0 + 2 * DAY - 2 * DAY) / 1000, "starts 2 days before the saved date");
  });

  it("finds nothing new when nothing arrived", async () => {
    gm.add("m1", SOBHA, "P0O9I8U7", t0 + DAY);
    await saveSync(db, await previewSync(db, gm, { since: "2026-10-01" }).then(confirm));
    const again = await previewSync(db, gm, {});
    assert.deepEqual(again.mails, []);
    assert.equal(again.alreadySynced, 1);
  });

  it("catches a mail Gmail was slow to index, if it falls inside the overlap", async () => {
    gm.add("m2", MYNTRA, "Q1W2E3R4", t0 + 3 * DAY);
    await saveSync(db, await previewSync(db, gm, { since: "2026-10-01" }).then(confirm));
    gm.add("late", SOBHA, "P0O9I8U7", t0 + 2 * DAY + 3600_000); // older than the saved date, but only by a day
    assert.deepEqual((await previewSync(db, gm, {})).mails.map((m) => m.id), ["late"]);
  });

  it("reads at most 25 mails at a time and carries on with the rest next time", async () => {
    for (let i = 0; i < 30; i++) gm.add(`m${String(i).padStart(2, "0")}`, SOBHA, `P0O9I8U7`, t0 + i * 3600_000);
    const first = await previewSync(db, gm, { since: "2026-10-01" });
    assert.equal(MAX_MAILS_PER_SYNC, 25);
    assert.equal(first.mails.length, 25);
    assert.equal(first.waiting, 5);
    assert.equal(gm.fetched.length, 25, "only 25 mails are fetched, keeping within Cloudflare's request limit");
    assert.equal(first.mails[0].id, "m00", "the oldest come first");
    await saveSync(db, confirm(first));

    const second = await previewSync(db, gm, {});
    assert.deepEqual(second.mails.map((m) => m.id), ["m25", "m26", "m27", "m28", "m29"]);
    assert.equal(second.waiting, 0);
  });

  it("lets the admin fill in a company the subject didn't give, and skip mails", async () => {
    gm.add("odd", "Congratulations !! Selection List", "Q1W2E3R4", t0 + DAY);
    gm.add("junk", "Selection list FAQ", "no ids here", t0 + 2 * DAY);
    gm.add("skipme", VALEO, "M5N6B7V8", t0 + 3 * DAY);
    const p = await previewSync(db, gm, { since: "2026-10-01" });
    assert.equal(p.mails[0].company, null);
    const decisions = validateDecisions({
      mails: [
        { id: "odd", subject: p.mails[0].subject, date: p.mails[0].date, company: "  Zoho  ", ids: p.mails[0].ids },
        { id: "junk", subject: "x", date: p.mails[1].date, company: null, ids: [] },
        { id: "skipme", subject: "x", date: p.mails[2].date, company: null, ids: ["M5N6B7V8"] },
      ],
    });
    const r = await saveSync(db, decisions);
    assert.deepEqual(r.saved.map((s) => s.company), ["Zoho"]);
    assert.equal(r.skipped, 2);
    assert.deepEqual((await adminSummary(db)).companies, [{ name: "Zoho", count: 1 }]);
    // skipped mails are remembered, so they don't come back
    assert.deepEqual((await previewSync(db, gm, {})).mails, []);
  });

  it("saving the same mails twice changes nothing", async () => {
    gm.add("m1", SOBHA, "P0O9I8U7 L1K2J3H4", t0 + DAY);
    const decisions = await previewSync(db, gm, { since: "2026-10-01" }).then(confirm);
    await saveSync(db, decisions);
    const again = await saveSync(db, decisions);
    assert.deepEqual(again.saved.map((s) => [s.added, s.alreadyIn]), [[0, 2]]);
    assert.deepEqual((await adminSummary(db)).companies, [{ name: "Sobha Limited", count: 2 }]);
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from synced_mails");
    assert.equal(rows[0].n, 1);
  });

  it("never moves the saved date backwards", async () => {
    gm.add("new", SOBHA, "P0O9I8U7", t0 + 9 * DAY);
    await saveSync(db, await previewSync(db, gm, { since: "2026-10-01" }).then(confirm));
    const before = (await mailSyncStatus(db)).checkedUpTo;
    gm.add("older", MYNTRA, "Q1W2E3R4", t0 + 1 * DAY);
    const p = await previewSync(db, gm, { since: "2026-10-01" }); // admin re-scans from an earlier date
    assert.deepEqual(p.mails.map((m) => m.id), ["older"]);
    await saveSync(db, confirm(p));
    assert.equal((await mailSyncStatus(db)).checkedUpTo, before);
  });

  it("is all-or-nothing: one bad company name saves none of the batch", async () => {
    const decisions = validateDecisions({
      mails: [
        { id: "a", subject: "s", date: new Date(t0).toISOString(), company: "Good Co", ids: ["Q1W2E3R4"] },
        { id: "b", subject: "s", date: new Date(t0 + DAY).toISOString(), company: "x".repeat(101), ids: ["Z9X8C7V6"] },
      ],
    });
    await assert.rejects(saveSync(db, decisions), { status: 400 });
    assert.equal((await adminSummary(db)).companies.length, 0);
    assert.equal((await mailSyncStatus(db)).checkedUpTo, null);
    assert.equal((await db.query("select 1 from synced_mails")).rows.length, 0);
  });

  it("rejects a bad start date", async () => {
    for (const bad of ["yesterday", "2026-13-01", "2026-02-30", "01/10/2026", 5, "2099-01-01"]) {
      await assert.rejects(previewSync(db, gm, { since: bad }), { status: 400 }, String(bad));
    }
    assert.equal(gm.queries.length, 0);
  });

  it("uses MAIL_SYNC_QUERY when set", async () => {
    process.env.MAIL_SYNC_QUERY = 'from:cdc@x.ac.in subject:"selection list"';
    gm.add("m1", SOBHA, "P0O9I8U7", t0 + DAY);
    const p = await previewSync(db, gm, { since: "2026-10-01" });
    assert.match(gm.queries[0], /^from:cdc@x\.ac\.in subject:"selection list" after:\d+$/);
    assert.equal(p.query, 'from:cdc@x.ac.in subject:"selection list"');
  });

  it("checks what the browser sends before saving it", () => {
    const good = { id: "a", subject: "s", date: "2026-10-01T00:00:00Z", company: "Co", ids: ["q1w2e3r4", "Q1W2E3R4"] };
    assert.deepEqual(validateDecisions({ mails: [good] })[0].ids, ["Q1W2E3R4"], "normalised and de-duplicated");
    const bad: unknown[] = [
      null, {}, { mails: "x" },
      { mails: [{ ...good, id: "" }] },
      { mails: [{ ...good, date: "nope" }] },
      { mails: [{ ...good, ids: ["not an id"] }] },
      { mails: [{ ...good, ids: "Q1W2E3R4" }] },
      { mails: [{ ...good, company: 5 }] },
      { mails: [good, good] },
      { mails: new Array(101).fill(0).map((_, i) => ({ ...good, id: `m${i}` })) },
    ];
    for (const b of bad) assert.throws(() => validateDecisions(b), { name: "Error" }, JSON.stringify(b)?.slice(0, 60));
  });
});

/* ------------------------------------------------------------ routes */

describe("Mail sync routes", () => {
  let routes: { status: typeof import("../src/app/api/admin/mail/route"); sync: typeof import("../src/app/api/admin/mail/sync/route"); save: typeof import("../src/app/api/admin/mail/save/route") };
  let cookie: string;
  before(async () => {
    process.env.ADMIN_PASSWORD = "pw-pw-pw";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789";
    await freshDb();
    routes = {
      status: await import("../src/app/api/admin/mail/route"),
      sync: await import("../src/app/api/admin/mail/sync/route"),
      save: await import("../src/app/api/admin/mail/save/route"),
    };
    const { createSessionToken, SESSION_COOKIE } = await import("../src/lib/auth");
    cookie = `${SESSION_COOKIE}=${await createSessionToken()}`;
  });
  const post = (url: string, body: unknown, withCookie = true) =>
    new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", ...(withCookie ? { cookie } : {}) }, body: JSON.stringify(body) });

  it("is admin-only", async () => {
    assert.equal((await routes.status.GET(new Request("http://localhost/api/admin/mail"))).status, 401);
    assert.equal((await routes.sync.POST(post("/api/admin/mail/sync", {}, false))).status, 401);
    assert.equal((await routes.save.POST(post("/api/admin/mail/save", { mails: [] }, false))).status, 401);
  });

  it("says plainly when Gmail isn't set up", async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    const status = await (await routes.status.GET(new Request("http://localhost/api/admin/mail", { headers: { cookie } }))).json();
    assert.equal(status.configured, false);
    const res = await routes.sync.POST(post("/api/admin/mail/sync", { since: "2026-10-01" }));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /GOOGLE_CLIENT_ID.*GOOGLE_REFRESH_TOKEN/);
  });

  it("reports configured once the settings exist, and saves confirmed mail", async () => {
    setGoogleEnv();
    const status = await (await routes.status.GET(new Request("http://localhost/api/admin/mail", { headers: { cookie } }))).json();
    assert.equal(status.configured, true);
    assert.equal(status.lastSyncedAt, null);

    const res = await routes.save.POST(post("/api/admin/mail/save", { mails: [{ id: "x1", subject: "s", date: "2026-10-02T00:00:00Z", company: "Route Co", ids: ["Q1W2E3R4"] }] }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.saved.map((s: { company: string }) => s.company), ["Route Co"]);
    assert.equal(body.checkedUpTo, "2026-10-02T00:00:00.000Z");
    assert.equal((await routes.save.POST(post("/api/admin/mail/save", { mails: [{ id: "x2", date: "bad", ids: [] }] }))).status, 400);
  });
});
