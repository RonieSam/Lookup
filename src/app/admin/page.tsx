"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { NeoIdText } from "@/components/NeoIdText";
import { ApiError, api } from "@/lib/client";
import { buildMapping, detectNeoColumn, parseRows, type MappedColumn } from "@/lib/columns";
import type { FindResult } from "@/lib/find";
import type { MailSyncStatus, SaveResult, SyncPreview } from "@/lib/mailSync";
import { classifyTokens, tokenize } from "@/lib/neo";
import type { PlacementResult } from "@/lib/placements";
import { cellHas } from "@/lib/search";
import type { CompanySummary, UploadStats } from "@/lib/students";

interface Summary {
  studentCount: number;
  columns: { key: string; label: string }[];
  companies: CompanySummary[];
}

interface ParsedFile {
  name: string;
  headers: string[];
  rows: unknown[][];
  /** The row number each data row has in the spreadsheet, so reports match what the admin sees. */
  rowNumbers: number[];
  isCsv: boolean;
}

const BATCH = 500;
const fmt = (n: number) => n.toLocaleString("en-IN");

export default function AdminPage() {
  const [phase, setPhase] = useState<"checking" | "login" | "ready">("checking");
  const [summary, setSummary] = useState<Summary | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSummary(await api<Summary>("/api/admin/status"));
      setPhase("ready");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setPhase("login");
      else throw err;
    }
  }, []);

  const [fatal, setFatal] = useState<string | null>(null);
  useEffect(() => {
    refresh().catch((err) => setFatal(err instanceof Error ? err.message : "Couldn't reach the server."));
  }, [refresh]);

  async function logout() {
    await api("/api/admin/logout", { method: "POST", json: {} });
    setSummary(null);
    setPhase("login");
  }

  return (
    <>
      <div className="row spread">
        <h1>Admin</h1>
        {phase === "ready" && (
          <button className="btn quiet" onClick={logout}>
            Sign out
          </button>
        )}
      </div>

      {fatal && (
        <div className="notice bad" role="alert">
          {fatal}
        </div>
      )}
      {phase === "checking" && !fatal && <p className="lede">Checking your session…</p>}
      {phase === "login" && <LoginForm onDone={refresh} />}
      {phase === "ready" && summary && <Dashboard summary={summary} onChanged={refresh} />}
    </>
  );
}

/* ------------------------------------------------------------------ */

function LoginForm({ onDone }: { onDone: () => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/login", { json: { password } });
      setPassword("");
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card login" onSubmit={submit}>
      <p className="lede" style={{ marginBottom: 16 }}>
        Uploading student details needs the admin password.
      </p>
      <label htmlFor="pw">Admin password</label>
      <input
        id="pw"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {error && (
        <div className="notice bad" role="alert">
          {error}
        </div>
      )}
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn primary" disabled={busy || password === ""}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */

function Dashboard({ summary, onChanged }: { summary: Summary; onChanged: () => Promise<void> }) {
  return (
    <div className="stack">
      <section className="card" aria-labelledby="db-title">
        <h2 id="db-title">What's stored</h2>
        <div className="stats">
          <div className="stat">
            <b>{fmt(summary.studentCount)}</b>
            <span>students</span>
          </div>
          <div className="stat">
            <b>{summary.columns.length}</b>
            <span>detail columns</span>
          </div>
          <div className="stat">
            <b>{summary.companies.length}</b>
            <span>{summary.companies.length === 1 ? "company" : "companies"}</span>
          </div>
        </div>
        {summary.columns.length > 0 ? (
          <div className="cols">
            {summary.columns.map((c) => (
              <span key={c.key} className="badge plain">
                {c.label}
              </span>
            ))}
          </div>
        ) : (
          <p className="hint">Nothing uploaded yet. Add a spreadsheet below to get started.</p>
        )}
      </section>

      <FindStudents summary={summary} onChanged={onChanged} />
      <Uploader summary={summary} onChanged={onChanged} />
      <MailSync onChanged={onChanged} />
      <Placements summary={summary} onChanged={onChanged} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function FindStudents({ summary, onChanged }: { summary: Summary; onChanged: () => Promise<void> }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<{ result: FindResult; query: string } | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (busy || q.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      setFound({ result: await api<FindResult>("/api/admin/search", { json: { q } }), query: q.trim() });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await onChanged(); // session expired: back to the sign-in form
        return;
      }
      setError(err instanceof Error ? err.message : "The search failed.");
    } finally {
      setBusy(false);
    }
  }

  const terms = found?.result.terms ?? [];
  const hit = (text: string) => terms.some((t) => cellHas(text, t));

  return (
    <section className="card" aria-labelledby="find-title">
      <h2 id="find-title">Find students</h2>
      <form onSubmit={run}>
        <label htmlFor="find-q">Search everything stored</label>
        <div className="searchbar">
          <input
            id="find-q"
            type="search"
            value={q}
            autoComplete="off"
            spellCheck={false}
            maxLength={100}
            placeholder="Name, registration number, Neo ID, campus, company…"
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="btn primary" disabled={busy || q.trim() === ""}>
            {busy ? "Searching…" : "Search"}
          </button>
        </div>
        <p className="hint">
          Looks in the Neo ID, every detail column and company names. Capital letters don't matter, and part of a word is
          enough. With several words, each one has to match somewhere in the student's details.
        </p>
      </form>

      {error && (
        <div className="notice bad" role="alert">
          {error}
        </div>
      )}

      {found && (
        <div role="status">
          {found.result.total === 0 ? (
            <p className="empty">Nothing matches “{found.query}”.</p>
          ) : (
            <>
              <p className="hint">
                {found.result.total > found.result.hits.length
                  ? `Showing the first ${fmt(found.result.hits.length)} of ${fmt(found.result.total)} matches. Add a word to narrow it down.`
                  : `${fmt(found.result.total)} ${found.result.total === 1 ? "match" : "matches"}.`}
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Neo ID</th>
                      {summary.columns.map((c) => (
                        <th key={c.key} scope="col">
                          {c.label}
                        </th>
                      ))}
                      <th scope="col">Companies</th>
                    </tr>
                  </thead>
                  <tbody>
                    {found.result.hits.map((h) => (
                      <tr key={h.neoId}>
                        <td className={hit(h.neoId) ? "hit" : undefined}>
                          <NeoIdText id={h.neoId} />
                        </td>
                        {h.inStudents ? (
                          summary.columns.map((c) => {
                            const v = h.data[c.key];
                            const text = v === undefined ? "" : String(v);
                            return (
                              <td key={c.key} className={[typeof v === "number" ? "num" : "", hit(text) ? "hit" : ""].filter(Boolean).join(" ") || undefined}>
                                {text}
                              </td>
                            );
                          })
                        ) : (
                          <td className="note" colSpan={Math.max(summary.columns.length, 1)}>
                            No student record yet (only placements are saved for this Neo ID).
                          </td>
                        )}
                        <td className={hit(h.companies.join(" ")) ? "hit" : undefined}>
                          {h.companies.length > 0 ? (
                            <span className="companies">
                              {h.companies.map((name) => (
                                <span key={name} className="badge info">
                                  {name}
                                </span>
                              ))}
                            </span>
                          ) : (
                            <span className="none">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function MailSync({ onChanged }: { onChanged: () => Promise<void> }) {
  const [status, setStatus] = useState<MailSyncStatus | null>(null);
  const [since, setSince] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  // The company to save each mail under; blank means skip that mail.
  const [companies, setCompanies] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<SaveResult | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api<MailSyncStatus>("/api/admin/mail"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read the mail sync status.");
    }
  }, []);
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

  async function check() {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const p = await api<SyncPreview>("/api/admin/mail/sync", { json: { since: since || undefined } });
      setPreview(p);
      setCompanies(Object.fromEntries(p.mails.map((m) => [m.id, m.company ?? ""])));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await onChanged();
        return;
      }
      setError(err instanceof Error ? err.message : "Couldn't check the mail.");
    } finally {
      setBusy(false);
    }
  }

  const willSave = preview?.mails.filter((m) => (companies[m.id] ?? "").trim() !== "" && m.ids.length > 0) ?? [];

  async function save() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<SaveResult>("/api/admin/mail/save", {
        json: {
          mails: preview.mails.map((m) => ({
            id: m.id,
            subject: m.subject,
            date: m.date,
            company: (companies[m.id] ?? "").trim() || null,
            ids: m.ids,
          })),
        },
      });
      setSaved(result);
      setPreview(null);
      setSince("");
      await Promise.all([loadStatus(), onChanged()]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await onChanged();
        return;
      }
      setError(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="mail-title">
      <h2 id="mail-title">Sync placements from Gmail</h2>
      {status && !status.configured ? (
        <div className="notice warn">
          Not set up yet. Add <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> and{" "}
          <code>GOOGLE_REFRESH_TOKEN</code> as settings, then redeploy. The README has the steps.
        </div>
      ) : (
        <>
          <p className="hint">
            Reads mails matching <code>{status?.query ?? "…"}</code>, takes the company from the subject and the Neo IDs
            from the body, and only looks at mail it hasn't handled before.{" "}
            {status?.checkedUpTo ? <>Checked up to <b>{when(status.checkedUpTo)}</b>.</> : status ? <>Nothing has been synced yet.</> : null}
          </p>
          <div className="searchbar">
            <label htmlFor="mail-since" className="sr-only">
              Start from
            </label>
            <input
              id="mail-since"
              type="date"
              value={since}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setSince(e.target.value)}
              style={{ maxWidth: 190 }}
            />
            <button className="btn primary" onClick={check} disabled={busy || !status || (!status.checkedUpTo && !since)}>
              {busy && !preview ? "Checking…" : "Check mail"}
            </button>
          </div>
          <p className="hint">
            {status?.checkedUpTo
              ? "Leave the date empty to continue from where the last sync stopped, or pick an earlier date to look further back."
              : "Pick the date to start from. Nothing is saved until you confirm."}
          </p>
        </>
      )}

      {error && (
        <div className="notice bad" role="alert">
          {error}
        </div>
      )}

      {saved && (
        <div className="notice ok" role="status">
          Saved {saved.saved.length} {saved.saved.length === 1 ? "mail" : "mails"}
          {saved.skipped > 0 && <>, skipped {saved.skipped}</>}.
          {saved.saved.length > 0 && (
            <ul>
              {saved.saved.map((r, i) => (
                <li key={i}>
                  {r.company}: {r.added} added{r.alreadyIn > 0 && <>, {r.alreadyIn} already there</>}
                  {r.unknownStudents > 0 && <>, {r.unknownStudents} with no student record yet</>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {preview && (
        <div role="status">
          {preview.mails.length === 0 ? (
            <p className="empty">
              No new mail since {when(preview.since)}
              {preview.alreadySynced > 0 && <> ({preview.alreadySynced} already handled)</>}.
            </p>
          ) : (
            <>
              <p className="hint">
                {preview.mails.length} new {preview.mails.length === 1 ? "mail" : "mails"} since {when(preview.since)}.
                Fix a company name if it's wrong, or clear it to skip that mail.
                {preview.waiting > 0 && <> {preview.waiting} more are waiting. Save these, then check again.</>}
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Received</th>
                      <th scope="col">Subject</th>
                      <th scope="col">Company</th>
                      <th scope="col">Neo IDs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.mails.map((m) => (
                      <tr key={m.id}>
                        <td>{when(m.date)}</td>
                        <td>{m.subject || <span className="none">(no subject)</span>}</td>
                        <td>
                          <input
                            type="text"
                            aria-label={`Company for: ${m.subject}`}
                            value={companies[m.id] ?? ""}
                            maxLength={100}
                            disabled={m.ids.length === 0}
                            placeholder={m.company === null ? "Type the company" : ""}
                            onChange={(e) => setCompanies((c) => ({ ...c, [m.id]: e.target.value }))}
                          />
                        </td>
                        <td className="num">
                          {m.ids.length > 0 ? m.ids.length : <span className="none">none found, will be skipped</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn primary" onClick={save} disabled={busy}>
                  {busy ? "Saving…" : `Save ${willSave.length} ${willSave.length === 1 ? "mail" : "mails"}`}
                </button>
                <button className="btn quiet" onClick={() => setPreview(null)} disabled={busy}>
                  Discard
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function describePlacement(r: PlacementResult): string {
  const students = (n: number) => `${fmt(n)} ${n === 1 ? "student" : "students"}`;
  const parts: string[] = [];
  if (r.action === "add") {
    parts.push(`Added ${students(r.added)} to ${r.company}.`);
    if (r.alreadyIn > 0) parts.push(`${fmt(r.alreadyIn)} ${r.alreadyIn === 1 ? "was" : "were"} already in it.`);
  } else if (r.action === "remove") {
    parts.push(`Removed ${students(r.removed)} from ${r.company}.`);
    if (r.notIn > 0) parts.push(`${fmt(r.notIn)} ${r.notIn === 1 ? "wasn't" : "weren't"} in it.`);
    if (r.companyGone) parts.push("That was the last student, so the company was removed.");
  } else {
    parts.push(`Deleted ${r.company} and its ${students(r.removed)}.`);
  }
  if (r.ignored > 0) parts.push(`${fmt(r.ignored)} other ${r.ignored === 1 ? "word" : "words"} ignored.`);
  return parts.join(" ");
}

function Placements({ summary, onChanged }: { summary: Summary; onChanged: () => Promise<void> }) {
  const [company, setCompany] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<PlacementResult | null>(null);

  const counts = useMemo(() => {
    const all = classifyTokens(tokenize(text));
    return {
      ids: all.filter((t) => t.status === "valid").length,
      repeats: all.filter((t) => t.status === "duplicate").length,
      ignored: all.filter((t) => t.status === "invalid").length,
    };
  }, [text]);

  async function run(action: "add" | "remove" | "delete_company", name: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await api<PlacementResult>("/api/admin/placements", { json: { action, company: name, text } });
      setDone(result);
      if (action !== "delete_company") {
        setCompany("");
        setText("");
      }
      await onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await onChanged(); // session expired: back to the sign-in form
        return;
      }
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  const ready = company.trim() !== "" && counts.ids > 0 && !busy;

  return (
    <section className="card" aria-labelledby="pl-title">
      <h2 id="pl-title">Placements</h2>
      <p className="lede">
        Choose a company and paste the Neo IDs of the students placed in it. A student can be in as many companies as
        you like. Company names match ignoring capital letters, so "tcs" and "TCS" are one company.
      </p>

      <div className="stack">
        <div>
          <label htmlFor="company">Company</label>
          <input
            id="company"
            type="text"
            list="company-names"
            autoComplete="off"
            maxLength={100}
            value={company}
            disabled={busy}
            onChange={(e) => setCompany(e.target.value)}
          />
          <datalist id="company-names">
            {summary.companies.map((c) => (
              <option key={c.name} value={c.name} />
            ))}
          </datalist>
        </div>

        <div>
          <label htmlFor="placed-ids">Neo IDs</label>
          <textarea
            id="placed-ids"
            value={text}
            disabled={busy}
            spellCheck={false}
            autoCapitalize="characters"
            autoComplete="off"
            placeholder={"A1B2C3D4 K1M3P5R7\nT2V4X6Z8"}
            style={{ minHeight: 120 }}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="hint">
            {counts.ids === 0 && counts.ignored === 0 ? (
              <>Anything that isn't a Neo ID is ignored, so you can paste a whole list or email.</>
            ) : (
              <>
                <b>{fmt(counts.ids)}</b> Neo {counts.ids === 1 ? "ID" : "IDs"}
                {counts.repeats > 0 && <> · {fmt(counts.repeats)} repeated</>}
                {counts.ignored > 0 && (
                  <>
                    {" "}
                    · {fmt(counts.ignored)} other {counts.ignored === 1 ? "word" : "words"} ignored
                  </>
                )}
              </>
            )}
          </p>
        </div>

        <div className="row">
          <button className="btn primary" onClick={() => run("add", company)} disabled={!ready}>
            {busy ? "Saving…" : "Add to company"}
          </button>
          <button className="btn" onClick={() => run("remove", company)} disabled={!ready}>
            Remove from company
          </button>
        </div>

        {error && (
          <div className="notice bad" role="alert">
            {error}
          </div>
        )}
        {done && (
          <div className="notice ok" role="status">
            {describePlacement(done)}
          </div>
        )}
        {done && done.action === "add" && done.unknownStudents.count > 0 && (
          <div className="notice warn" role="status">
            {fmt(done.unknownStudents.count)} {done.unknownStudents.count === 1 ? "Neo ID has" : "Neo IDs have"} no student
            record yet, so only the company is saved for them. If that's a typo, remove{" "}
            {done.unknownStudents.count === 1 ? "it" : "them"} from the company and add the right ID:{" "}
            {done.unknownStudents.sample.slice(0, 10).map((id, i) => (
              <span key={id}>
                {i > 0 && ", "}
                <NeoIdText id={id} />
              </span>
            ))}
            {done.unknownStudents.count > 10 && <> and {fmt(done.unknownStudents.count - 10)} more</>}
          </div>
        )}
      </div>

      {summary.companies.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Company</th>
                <th scope="col">Students</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {summary.companies.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td className="num">{fmt(c.count)}</td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="btn quiet"
                      disabled={busy}
                      aria-label={`Delete ${c.name}`}
                      onClick={() => {
                        if (window.confirm(`Delete ${c.name} and remove all ${fmt(c.count)} of its placements? This can't be undone.`)) {
                          run("delete_company", c.name);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function Uploader({ summary, onChanged }: { summary: Summary; onChanged: () => Promise<void> }) {
  const [file, setFile] = useState<ParsedFile | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [neoIndex, setNeoIndex] = useState(-1);
  const [left, setLeft] = useState<Set<number>>(new Set());
  const [overwrite, setOverwrite] = useState(false);
  const [dragging, setDragging] = useState(false);

  const [preview, setPreview] = useState<UploadStats | null>(null);
  const [progress, setProgress] = useState<{ phase: "preview" | "apply"; done: number; total: number } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [done, setDone] = useState<UploadStats | null>(null);

  const existingKeys = useMemo(() => summary.columns.map((c) => c.key), [summary.columns]);
  const labelFor = useMemo(() => new Map(summary.columns.map((c) => [c.key, c.label])), [summary.columns]);

  const mapping: MappedColumn[] = useMemo(() => {
    if (!file) return [];
    return buildMapping(file.headers, neoIndex, existingKeys).map((m) =>
      left.has(m.index) && (m.kind === "new" || m.kind === "existing")
        ? { ...m, kind: "skipped" as const, note: "Left out" }
        : m,
    );
  }, [file, neoIndex, existingKeys, left]);

  const report = useMemo(
    () => (file && neoIndex >= 0 ? parseRows(file.rows, mapping, file.isCsv, file.rowNumbers) : null),
    [file, neoIndex, mapping],
  );

  const columnsToSend = useMemo(
    () =>
      mapping
        .filter((m) => m.kind === "new" || m.kind === "existing")
        .map((m) => ({ key: m.key, label: (labelFor.get(m.key) ?? m.header).slice(0, 100) })),
    [mapping, labelFor],
  );

  // Any change to the inputs makes an earlier preview stale.
  useEffect(() => {
    setPreview(null);
    setRunError(null);
  }, [file, neoIndex, left, overwrite]);

  async function readFile(f: File) {
    setParseError(null);
    setDone(null);
    setFile(null);
    setLeft(new Set());
    setOverwrite(false);
    try {
      const isCsv = /\.(csv|txt)$/i.test(f.name);
      let sheet: unknown[][];
      if (isCsv) {
        const Papa = (await import("papaparse")).default;
        const text = await f.text();
        sheet = Papa.parse<string[]>(text.replace(/^\uFEFF/, "")).data;
      } else if (/\.xlsx$/i.test(f.name)) {
        const { readSheet } = await import("read-excel-file/universal");
        sheet = (await readSheet(f)) as unknown[][];
      } else {
        throw new Error("Choose an .xlsx or .csv file. Older .xls files need to be re-saved as .xlsx first.");
      }

      const kept = sheet
        .map((row, i) => ({ row, number: i + 1 }))
        .filter(({ row }) => row.some((c) => c !== null && c !== undefined && String(c).trim() !== ""));
      if (kept.length < 2) throw new Error("The file needs a header row and at least one row of data.");

      const headers = kept[0].row.map((h) => String(h ?? "").trim());
      const rows = kept.slice(1).map((k) => k.row);
      const rowNumbers = kept.slice(1).map((k) => k.number);
      const detected = detectNeoColumn(headers, rows);
      setFile({ name: f.name, headers, rows, rowNumbers, isCsv });
      setNeoIndex(detected);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "That file couldn't be read.");
    }
  }

  async function sendBatches(dryRun: boolean): Promise<UploadStats> {
    if (!report) throw new Error("Pick the Neo ID column first.");
    const total: UploadStats = {
      rows: 0, newStudents: 0, existingStudents: 0, studentsChanged: 0,
      cellsAdded: 0, cellsChanged: 0, cellsUnchanged: 0, cellsSkipped: 0, newColumns: [],
    };
    const newCols = new Set<string>();
    for (let i = 0; i < report.rows.length; i += BATCH) {
      setProgress({ phase: dryRun ? "preview" : "apply", done: i, total: report.rows.length });
      const stats = await api<UploadStats>("/api/admin/upload", {
        json: { rows: report.rows.slice(i, i + BATCH), columns: columnsToSend, overwrite, dryRun },
      });
      for (const k of Object.keys(total) as (keyof UploadStats)[]) {
        if (k !== "newColumns") (total[k] as number) += stats[k] as number;
      }
      stats.newColumns.forEach((k) => newCols.add(k));
    }
    total.newColumns = [...newCols];
    return total;
  }

  async function run(dryRun: boolean) {
    setRunError(null);
    try {
      const stats = await sendBatches(dryRun);
      if (dryRun) setPreview(stats);
      else {
        setDone(stats);
        setFile(null);
        setPreview(null);
        await onChanged();
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await onChanged(); // session expired: back to the sign-in form
        return;
      }
      setRunError(
        (err instanceof Error ? err.message : "The upload failed.") +
          (dryRun ? "" : " Nothing is lost by running the same upload again; already-saved rows are simply matched."),
      );
    } finally {
      setProgress(null);
    }
  }

  const busy = progress !== null;
  const labelOf = (key: string) => columnsToSend.find((c) => c.key === key)?.label ?? key;

  return (
    <section className="card" aria-labelledby="up-title">
      <h2 id="up-title">Upload student details</h2>
      <p className="lede">
        Upload an .xlsx or .csv file with a column of Neo IDs. Students are matched by Neo ID. Columns the database
        doesn't have yet, such as Email, are added automatically.
      </p>

      <label
        className={`dropzone ${dragging ? "over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) readFile(f);
        }}
      >
        <input
          type="file"
          accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) readFile(f);
            e.target.value = "";
          }}
        />
        {file ? <>Loaded <b>{file.name}</b>. Click or drop to replace it.</> : <>Drop a spreadsheet here, or click to choose one</>}
      </label>

      {parseError && (
        <div className="notice bad" role="alert">
          {parseError}
        </div>
      )}

      {done && (
        <div className="notice ok" role="status">
          <b>Upload saved.</b> {fmt(done.newStudents)} new {done.newStudents === 1 ? "student" : "students"},{" "}
          {fmt(done.existingStudents)} matched,
          {" "}{fmt(done.cellsAdded)} values added
          {done.cellsChanged > 0 && <>, {fmt(done.cellsChanged)} updated</>}
          {done.newColumns.length > 0 && <>, new {done.newColumns.length === 1 ? "column" : "columns"}: {done.newColumns.map(labelOf).join(", ")}</>}.
        </div>
      )}

      {file && (
        <div className="stack" style={{ marginTop: 20 }}>
          <div>
            <label htmlFor="neo-col">Which column holds the Neo IDs?</label>
            <select id="neo-col" value={neoIndex} disabled={busy} onChange={(e) => setNeoIndex(Number(e.target.value))}>
              <option value={-1} disabled>
                Choose a column…
              </option>
              {file.headers.map((h, i) => (
                <option key={i} value={i}>
                  {h || `(column ${i + 1}, no header)`}
                </option>
              ))}
            </select>
          </div>

          {neoIndex >= 0 && report && (
            <>
              <div className="table-wrap" style={{ marginTop: 0 }}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Column in file</th>
                      <th scope="col">Saved as</th>
                      <th scope="col">What happens</th>
                      <th scope="col">Include</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mapping.map((m) => {
                      const canToggle = m.kind !== "neo" && !(m.kind === "skipped" && m.note !== "Left out");
                      return (
                        <tr key={m.index}>
                          <td>{m.header || <span className="hint">(no header)</span>}</td>
                          <td>{m.kind === "neo" ? "Neo ID" : m.key ? (labelFor.get(m.key) ?? m.header) : "—"}</td>
                          <td>
                            {m.kind === "neo" && <span className="badge info">Matches students</span>}
                            {m.kind === "existing" && <span className="badge ok">Fills existing column</span>}
                            {m.kind === "new" && <span className="badge warn">Creates new column</span>}
                            {m.kind === "skipped" && <span className="badge plain">{m.note}</span>}
                          </td>
                          <td>
                            {canToggle ? (
                              <input
                                type="checkbox"
                                aria-label={`Include ${m.header}`}
                                checked={m.kind !== "skipped"}
                                disabled={busy}
                                onChange={(e) =>
                                  setLeft((prev) => {
                                    const next = new Set(prev);
                                    if (e.target.checked) next.delete(m.index);
                                    else next.add(m.index);
                                    return next;
                                  })
                                }
                              />
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div>
                <b>{fmt(report.rows.length)}</b> {report.rows.length === 1 ? "student" : "students"} ready to upload
                {report.duplicates > 0 && <> · {fmt(report.duplicates)} repeated {report.duplicates === 1 ? "ID" : "IDs"} combined</>}
                {report.invalid.length > 0 && (
                  <>
                    {" "}· <b style={{ color: "var(--bad)" }}>{fmt(report.invalid.length)} {report.invalid.length === 1 ? "row" : "rows"} skipped</b> for a missing or invalid Neo ID
                  </>
                )}
                {report.invalid.length > 0 && (
                  <details style={{ marginTop: 8 }}>
                    <summary>See skipped rows</summary>
                    <ul className="hint">
                      {report.invalid.slice(0, 25).map((r) => (
                        <li key={r.row}>
                          Row {r.row}: {r.value ? <span className="neo">{r.value}</span> : "no Neo ID"}
                        </li>
                      ))}
                      {report.invalid.length > 25 && <li>…and {fmt(report.invalid.length - 25)} more</li>}
                    </ul>
                  </details>
                )}
              </div>

              <label className="check">
                <input type="checkbox" checked={overwrite} disabled={busy} onChange={(e) => setOverwrite(e.target.checked)} />
                <span>
                  <strong>Replace values that are already saved</strong>
                  <br />
                  <span className="hint">
                    Off by default: existing values are kept, and only missing details are filled in. Blank cells never
                    erase anything either way.
                  </span>
                </span>
              </label>

              {busy && progress && (
                <div role="status">
                  <progress max={progress.total} value={progress.done} />
                  <p className="hint">
                    {progress.phase === "preview" ? "Checking" : "Saving"} {fmt(Math.min(progress.done + BATCH, progress.total))} of{" "}
                    {fmt(progress.total)}…
                  </p>
                </div>
              )}

              {runError && (
                <div className="notice bad" role="alert">
                  {runError}
                </div>
              )}

              {preview && !busy && (
                <div className="notice" role="status">
                  <b>Preview, nothing saved yet</b>
                  <div className="stats">
                    <div className="stat"><b>{fmt(preview.newStudents)}</b><span>new students</span></div>
                    <div className="stat"><b>{fmt(preview.existingStudents)}</b><span>already stored</span></div>
                    <div className="stat"><b>{fmt(preview.cellsAdded)}</b><span>values added</span></div>
                    {overwrite && <div className="stat"><b>{fmt(preview.cellsChanged)}</b><span>values replaced</span></div>}
                    {!overwrite && preview.cellsSkipped > 0 && (
                      <div className="stat"><b>{fmt(preview.cellsSkipped)}</b><span>values kept (file differs)</span></div>
                    )}
                  </div>
                  {preview.newColumns.length > 0 && (
                    <p style={{ margin: 0 }}>
                      New {preview.newColumns.length === 1 ? "column" : "columns"}:{" "}
                      <b>{preview.newColumns.map(labelOf).join(", ")}</b>
                    </p>
                  )}
                  {preview.studentsChanged === 0 && <p style={{ margin: 0 }}>Everything in this file is already saved. Applying it changes nothing.</p>}
                </div>
              )}

              <div className="row">
                <button className="btn" onClick={() => run(true)} disabled={busy || report.rows.length === 0}>
                  Preview changes
                </button>
                {preview && (
                  <button className="btn primary" onClick={() => run(false)} disabled={busy || preview.studentsChanged === 0}>
                    Save to database
                  </button>
                )}
              </div>
            </>
          )}
          {neoIndex >= 0 && report && report.rows.length === 0 && (
            <p className="hint">
              No valid Neo IDs found in that column. A Neo ID looks like <NeoIdText id="A1B2C3D4" />.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
