"use client";

import { useMemo, useRef, useState } from "react";
import { NeoIdText } from "@/components/NeoIdText";
import { api, downloadText, formatCell, toCsv, toTsv } from "@/lib/client";
import { classifyTokens, tokenize } from "@/lib/neo";
import { cellHas, rowMatches, searchTerms } from "@/lib/search";
import { nextSort, sortRows, type SortState, type SortValue } from "@/lib/sort";
import type { LookupResult, LookupRow, LookupStatus } from "@/lib/students";

const MAX_CHIPS = 300;

const STATUS_LABEL: Record<LookupStatus, string> = {
  found: "Found",
  not_found: "Not found",
};

type Filter = "all" | LookupStatus;

// Built-in columns use keys that an uploaded column can never have (those start with a letter or digit).
const SORT_NEO = "@neo";
const SORT_STATUS = "@status";
const SORT_COMPANIES = "@companies";

function sortValue(r: LookupRow, key: string): SortValue {
  if (key === SORT_NEO) return r.neoId;
  if (key === SORT_STATUS) return STATUS_LABEL[r.status];
  if (key === SORT_COMPANIES) return r.companies.join(", ");
  const v = r.data?.[key];
  return typeof v === "boolean" ? formatCell(v) : v;
}

/**
 * The text of each searchable column in a row: Neo ID, the detail columns, then Companies.
 * Status isn't searched ("found" is inside "Not found"); the Found / Not found buttons filter by it.
 */
function searchCells(r: LookupRow, columns: { key: string }[], showCompanies: boolean): string[] {
  return [
    r.neoId,
    ...columns.map((c) => (r.data ? formatCell(r.data[c.key]) : "")),
    ...(showCompanies ? [r.companies.join(" ")] : []),
  ];
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: string;
  sort: SortState | null;
  onSort: (key: string) => void;
}) {
  const active = sort?.key === sortKey;
  return (
    <th scope="col" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="sort" onClick={() => onSort(sortKey)}>
        {label}
        <span className="sort-mark" aria-hidden="true">
          {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}

export default function LookupPage() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [copied, setCopied] = useState(false);
  const [sort, setSort] = useState<SortState | null>(null);
  const [search, setSearch] = useState("");
  const resultsRef = useRef<HTMLDivElement>(null);

  // Words that aren't Neo IDs (times, dates, labels...) are dropped; they're only counted.
  const { tokens, ignored } = useMemo(() => {
    const all = classifyTokens(tokenize(text));
    const ids = all.filter((t) => t.status !== "invalid");
    return { tokens: ids, ignored: all.length - ids.length };
  }, [text]);
  const tally = useMemo(() => {
    const repeat = tokens.filter((t) => t.status === "duplicate").length;
    return { ids: tokens.length - repeat, repeat };
  }, [tokens]);

  async function submit() {
    if (loading || tokens.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api<LookupResult>("/api/lookup", { json: { text } });
      setResult(data);
      setFilter("all");
      setSort(null);
      setSearch("");
      requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The lookup failed.");
    } finally {
      setLoading(false);
    }
  }

  function clearAll() {
    setText("");
    setResult(null);
    setSort(null);
    setSearch("");
    setError(null);
  }

  const showCompanies = result?.hasPlacements === true;

  const terms = useMemo(() => searchTerms(search), [search]);

  // The rows on screen: filtered by status, then searched, then sorted. Copy and CSV export use this same list.
  const { visibleRows, inView } = useMemo(() => {
    if (!result) return { visibleRows: [] as LookupRow[], inView: 0 };
    const filtered = result.rows.filter((r) => filter === "all" || r.status === filter);
    const searched =
      terms.length > 0
        ? filtered.filter((r) => rowMatches(searchCells(r, result.columns, result.hasPlacements), terms))
        : filtered;
    return {
      visibleRows: sort ? sortRows(searched, (r) => sortValue(r, sort.key), sort.dir) : searched,
      inView: filtered.length,
    };
  }, [result, filter, sort, terms]);

  /** A cell lights up when it contains any of the searched words, so it's clear why the row matched. */
  const hit = (text: string) => terms.length > 0 && terms.some((t) => cellHas(text, t));

  function exportRows(): unknown[][] {
    if (!result) return [];
    const head = ["Neo ID", "Status", ...result.columns.map((c) => c.label), ...(showCompanies ? ["Companies"] : [])];
    const body = visibleRows.map((r) => [
      r.neoId,
      STATUS_LABEL[r.status],
      ...result.columns.map((c) => (r.data ? formatCell(r.data[c.key]) : "")),
      ...(showCompanies ? [r.companies.join("; ")] : []),
    ]);
    return [head, ...body];
  }

  async function copyTable() {
    try {
      await navigator.clipboard.writeText(toTsv(exportRows()));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Your browser blocked copying. Use Download CSV instead.");
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
          {ignored === 0 && tokens.length === 0 ? (
            <>Separate IDs with spaces, commas or new lines.</>
          ) : (
            <>
              <b>{tally.ids}</b> Neo {tally.ids === 1 ? "ID" : "IDs"}
              {tally.repeat > 0 && (
                <>
                  {" "}
                  · <b>{tally.repeat}</b> repeated
                </>
              )}
              {ignored > 0 && (
                <>
                  {" "}
                  · {ignored} other {ignored === 1 ? "word" : "words"} ignored
                </>
              )}
            </>
          )}
        </div>

        {tokens.length > 0 && (
          <div className="chips" aria-label="Neo IDs found in the text">
            {tokens.slice(0, MAX_CHIPS).map((t, i) => (
              <span key={i} className={`chip ${t.status === "duplicate" ? "repeat" : ""}`}>
                <NeoIdText id={t.id} />
                {t.status === "duplicate" && <span className="why">repeat</span>}
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
            {error}
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
                <div className="searchbar">
                  <label htmlFor="result-search" className="sr-only">
                    Search these results
                  </label>
                  <input
                    id="result-search"
                    type="search"
                    value={search}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Search these results: name, number, company…"
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setSearch("");
                    }}
                  />
                  {search !== "" && (
                    <button className="btn quiet" onClick={() => setSearch("")}>
                      Clear
                    </button>
                  )}
                </div>
                {terms.length > 0 && (
                  <p className="hint" role="status">
                    {visibleRows.length === 0
                      ? "No rows match."
                      : `${visibleRows.length} of ${inView} ${inView === 1 ? "row matches" : "rows match"}.`}{" "}
                    Every word has to match somewhere in the row.
                  </p>
                )}

                <div className="row" style={{ marginTop: 12 }}>
                <div className="filters" role="group" aria-label="Filter results">
                  {(
                    [
                      ["all", "All", result.summary.unique],
                      ["found", "Found", result.summary.found],
                      ["not_found", "Not found", result.summary.notFound],
                    ] as [Filter, string, number][]
                  ).map(([key, label, n]) => (
                    <button key={key} className="filter" aria-pressed={filter === key} onClick={() => setFilter(key)}>
                      {label} <b>{n}</b>
                    </button>
                  ))}
                </div>
                {sort && (
                  <button className="btn quiet" onClick={() => setSort(null)}>
                    Original order
                  </button>
                )}
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
                        <SortHeader label="Neo ID" sortKey={SORT_NEO} sort={sort} onSort={(k) => setSort((cur) => nextSort(cur, k))} />
                        <SortHeader label="Status" sortKey={SORT_STATUS} sort={sort} onSort={(k) => setSort((cur) => nextSort(cur, k))} />
                        {result.columns.map((c) => (
                          <SortHeader key={c.key} label={c.label} sortKey={c.key} sort={sort} onSort={(k) => setSort((cur) => nextSort(cur, k))} />
                        ))}
                        {result.columns.length === 0 && <th scope="col">Details</th>}
                        {showCompanies && (
                          <SortHeader label="Companies" sortKey={SORT_COMPANIES} sort={sort} onSort={(k) => setSort((cur) => nextSort(cur, k))} />
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map((r, i) => (
                        <tr key={`${r.neoId}-${i}`}>
                          <td className={hit(r.neoId) ? "hit" : undefined}>
                            <NeoIdText id={r.neoId} />
                            {r.count > 1 && <span className="times">×{r.count}</span>}
                          </td>
                          <td>
                            <span className={`badge ${r.status === "found" ? "ok" : "warn"}`}>
                              {STATUS_LABEL[r.status]}
                            </span>
                          </td>
                          {r.status === "found" && result.columns.length > 0 ? (
                            result.columns.map((c) => (
                              <td
                                key={c.key}
                                className={[typeof r.data?.[c.key] === "number" ? "num" : "", hit(formatCell(r.data?.[c.key])) ? "hit" : ""].filter(Boolean).join(" ") || undefined}
                              >
                                {formatCell(r.data?.[c.key])}
                              </td>
                            ))
                          ) : r.status === "found" ? (
                            <td className="note">No details saved for this student.</td>
                          ) : (
                            <td className="note" colSpan={Math.max(result.columns.length, 1)}>
                              No student has this Neo ID.
                            </td>
                          )}
                          {showCompanies && (
                            <td className={hit(r.companies.join(" ")) ? "hit" : undefined}>
                              {r.companies.length > 0 ? (
                                <span className="companies">
                                  {r.companies.map((name) => (
                                    <span key={name} className="badge info">
                                      {name}
                                    </span>
                                  ))}
                                </span>
                              ) : (
                                <span className="none">—</span>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                      {visibleRows.length === 0 && (
                        <tr>
                          <td className="note" colSpan={2 + Math.max(result.columns.length, 1) + (showCompanies ? 1 : 0)}>
                            {terms.length > 0 ? "No rows match your search." : "Nothing in this view."}
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
