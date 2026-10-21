"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { NeoIdText } from "@/components/NeoIdText";
import { ApiError, api, downloadText, formatCell, toCsv, toTsv } from "@/lib/client";
import { classifyTokens, tokenize } from "@/lib/neo";
import type { LookupResult, LookupStatus } from "@/lib/students";

const MAX_CHIPS = 300;

const STATUS_LABEL: Record<LookupStatus, string> = {
  found: "Found",
  not_found: "Not found",
  invalid: "Invalid",
};

type Filter = "all" | LookupStatus;

export default function LookupPage() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<{ message: string; loginRequired: boolean } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [copied, setCopied] = useState(false);
  const resultsRef = useRef<HTMLDivElement>(null);

  const tokens = useMemo(() => classifyTokens(tokenize(text)), [text]);
  const tally = useMemo(() => {
    let valid = 0;
    let invalid = 0;
    let repeat = 0;
    for (const t of tokens) {
      if (t.status === "valid") valid++;
      else if (t.status === "invalid") invalid++;
      else repeat++;
    }
    return { words: tokens.length, valid, invalid, repeat };
  }, [tokens]);

  async function submit() {
    if (loading || tokens.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api<LookupResult>("/api/lookup", { json: { text } });
      setResult(data);
      setFilter("all");
      requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (err) {
      const loginRequired = err instanceof ApiError && err.body?.loginRequired === true;
      setError({ message: err instanceof Error ? err.message : "The lookup failed.", loginRequired });
    } finally {
      setLoading(false);
    }
  }

  function clearAll() {
    setText("");
    setResult(null);
    setError(null);
  }

  const visibleRows = result ? result.rows.filter((r) => filter === "all" || r.status === filter) : [];

  function exportRows(): unknown[][] {
    if (!result) return [];
    const head = ["Neo ID", "Status", ...result.columns.map((c) => c.label), "Note"];
    const body = visibleRows.map((r) => [
      r.neoId,
      STATUS_LABEL[r.status],
      ...result.columns.map((c) => (r.data ? formatCell(r.data[c.key]) : "")),
      r.status === "invalid" ? (r.reason ?? "") : "",
    ]);
    return [head, ...body];
  }

  async function copyTable() {
    try {
      await navigator.clipboard.writeText(toTsv(exportRows()));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError({ message: "Your browser blocked copying. Use Download CSV instead.", loginRequired: false });
    }
  }

  return (
    <>
      <h1>Look up students by Neo ID</h1>
      <p className="lede">
        Paste Neo IDs or copy a whole table. Only valid Neo IDs are processed; times, dates, headings, and other text are ignored. Each ID must be a letter then a digit, four times over, like{" "}
        <NeoIdText id="A1B2C3D4" />.
      </p>

      <section className="card" aria-labelledby="paste-label">
        <label id="paste-label" htmlFor="paste">
          Neo IDs
        </label>
        <textarea
          id="paste"
          value={text}
          spellCheck={false}
          autoCapitalize="characters"
          autoComplete="off"
          placeholder={"A1B2C3D4 K1M3P5R7\nT2V4X6Z8, E9G7J5L3"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") submit();
          }}
        />

        <div className="tally" aria-live="polite">
          {tally.words === 0 ? (
            <>Separate IDs with spaces, commas or new lines.</>
          ) : (
            <>
              <b>{tally.words}</b> {tally.words === 1 ? "word" : "words"} · <b>{tally.valid}</b> valid
              {tally.invalid > 0 && (
                <>
                  {" "}
                  · <b className="bad">{tally.invalid} invalid</b>
                </>
              )}
              {tally.repeat > 0 && (
                <>
                  {" "}
                  · <b>{tally.repeat}</b> repeated
                </>
              )}
            </>
          )}
        </div>

        {tokens.length > 0 && (
          <div className="chips" aria-label="Each word, checked">
            {tokens.slice(0, MAX_CHIPS).map((t, i) => (
              <span
                key={i}
                className={`chip ${t.status === "invalid" ? "invalid" : t.status === "duplicate" ? "repeat" : ""}`}
              >
                {t.status === "invalid" ? (
                  <>
                    <span className="neo">{t.raw}</span>
                    <span className="why">{t.reason}</span>
                  </>
                ) : (
                  <>
                    <NeoIdText id={t.id} />
                    {t.status === "duplicate" && <span className="why">repeat</span>}
                  </>
                )}
              </span>
            ))}
            {tokens.length > MAX_CHIPS && <span className="chip">+{tokens.length - MAX_CHIPS} more</span>}
          </div>
        )}

        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={submit} disabled={loading || tokens.length === 0}>
            {loading ? "Looking up…" : "Look up"}
          </button>
          <button className="btn quiet" onClick={clearAll} disabled={loading || (text === "" && !result)}>
            Clear
          </button>
          <span className="hint" style={{ margin: 0 }}>
            Ctrl or ⌘ + Enter also works
          </span>
        </div>

        {error && (
          <div className="notice bad" role="alert">
            {error.message}{" "}
            {error.loginRequired && (
              <>
                <Link href="/admin">Sign in on the admin page</Link>, then come back.
              </>
            )}
          </div>
        )}
      </section>

      <div ref={resultsRef} style={{ scrollMarginTop: 16 }}>
        {result && (
          <section className="card" aria-labelledby="results-title">
            <div className="row spread">
              <h2 id="results-title" style={{ margin: 0 }}>
                Results
              </h2>
              <div className="row">
                <button className="btn" onClick={copyTable} disabled={visibleRows.length === 0}>
                  {copied ? "Copied" : "Copy table"}
                </button>
                <button
                  className="btn"
                  onClick={() => downloadText("neo-id-results.csv", toCsv(exportRows()))}
                  disabled={visibleRows.length === 0}
                >
                  Download CSV
                </button>
              </div>
            </div>

            {result.summary.unique === 0 ? (
              <p className="empty">No Neo IDs in the pasted text.</p>
            ) : (
              <>
                <div className="filters" role="group" aria-label="Filter results" style={{ marginTop: 12 }}>
                  {(
                    [
                      ["all", "All", result.summary.unique],
                      ["found", "Found", result.summary.found],
                      ["not_found", "Not found", result.summary.notFound],
                      ["invalid", "Invalid", result.summary.invalid],
                    ] as [Filter, string, number][]
                  ).map(([key, label, n]) => (
                    <button key={key} className="filter" aria-pressed={filter === key} onClick={() => setFilter(key)}>
                      {label} <b>{n}</b>
                    </button>
                  ))}
                </div>
                {result.summary.repeats > 0 && (
                  <p className="hint">
                    {result.summary.repeats} repeated {result.summary.repeats === 1 ? "ID was" : "IDs were"} merged into
                    the first time they appeared.
                  </p>
                )}

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Neo ID</th>
                        <th scope="col">Status</th>
                        {result.columns.map((c) => (
                          <th key={c.key} scope="col">
                            {c.label}
                          </th>
                        ))}
                        {result.columns.length === 0 && <th scope="col">Details</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map((r, i) => (
                        <tr key={`${r.neoId}-${i}`}>
                          <td>
                            {r.status === "invalid" ? <span className="neo">{r.input}</span> : <NeoIdText id={r.neoId} />}
                            {r.count > 1 && <span className="times">×{r.count}</span>}
                          </td>
                          <td>
                            <span className={`badge ${r.status === "found" ? "ok" : r.status === "invalid" ? "bad" : "warn"}`}>
                              {STATUS_LABEL[r.status]}
                            </span>
                          </td>
                          {r.status === "found" && result.columns.length > 0 ? (
                            result.columns.map((c) => (
                              <td key={c.key} className={typeof r.data?.[c.key] === "number" ? "num" : undefined}>
                                {formatCell(r.data?.[c.key])}
                              </td>
                            ))
                          ) : r.status === "found" ? (
                            <td className="note">No details saved for this student.</td>
                          ) : (
                            <td className="note" colSpan={Math.max(result.columns.length, 1)}>
                              {r.status === "invalid" ? r.reason : "No student has this Neo ID."}
                            </td>
                          )}
                        </tr>
                      ))}
                      {visibleRows.length === 0 && (
                        <tr>
                          <td className="note" colSpan={2 + Math.max(result.columns.length, 1)}>
                            Nothing in this view.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </>
  );
}
