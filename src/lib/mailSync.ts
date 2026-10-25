import type { Db } from "./db";
import { readEnv } from "./env";
import { gmailConfigured, type GmailClient } from "./gmail";
import { extractCompany, extractNeoIds } from "./mailParse";
import { isValidNeoId, normalizeNeoId } from "./neo";
import { changePlacements } from "./placements";
import { HttpError, MAX_LOOKUP_TOKENS } from "./students";

/**
 * Syncing placements from Gmail.
 *
 * A sync is two steps so nothing is saved by surprise:
 *   1. previewSync reads the mail that arrived since the last sync and works out
 *      the company and Neo IDs of each one. It writes nothing.
 *   2. saveSync stores what the admin confirmed (they can correct a company name
 *      first) and moves the "last synced" date forward.
 *
 * Mails already handled are remembered by Gmail message id, so a mail is never
 * processed twice, and the search deliberately starts a little before the saved
 * date to catch mail Gmail was slow to index.
 */

/** Gmail search used to find selection lists. Override with MAIL_SYNC_QUERY (e.g. add `from:...`). */
export const DEFAULT_MAIL_QUERY = 'subject:"selection list"';

/** Mails read per sync. Keeps one click inside the free Cloudflare plan's limit of 50 outside requests. */
export const MAX_MAILS_PER_SYNC = 25;
const MAX_LISTED = 300;
const OVERLAP_MS = 2 * 24 * 3600_000;
const FETCH_CONCURRENCY = 5;

export function mailQuery(): string {
  return readEnv("MAIL_SYNC_QUERY")?.trim() || DEFAULT_MAIL_QUERY;
}

export interface MailPreview {
  id: string;
  subject: string;
  from: string;
  date: string;
  /** The company worked out from the subject, or null when it couldn't be. */
  company: string | null;
  ids: string[];
}

export interface SyncPreview {
  query: string;
  /** Where the search started. */
  since: string;
  /** Mails that matched the search in that window. */
  matched: number;
  /** Of those, how many were already handled in an earlier sync. */
  alreadySynced: number;
  /** New mails, oldest first, at most MAX_MAILS_PER_SYNC. */
  mails: MailPreview[];
  /** New mails left for the next sync because of the cap. */
  waiting: number;
}

export interface MailSyncStatus {
  configured: boolean;
  query: string;
  /** When a sync last saved, or null if none has. */
  lastSyncedAt: string | null;
  /** Mail up to this moment has been handled. */
  checkedUpTo: string | null;
}

export async function mailSyncStatus(db: Db): Promise<MailSyncStatus> {
  const { rows } = await db.query<{ cursor: Date | string; last_run_at: Date | string }>(
    "select cursor, last_run_at from mail_sync where id = 1",
  );
  const iso = (v: Date | string) => new Date(v).toISOString();
  return {
    configured: gmailConfigured(),
    query: mailQuery(),
    lastSyncedAt: rows[0] ? iso(rows[0].last_run_at) : null,
    checkedUpTo: rows[0] ? iso(rows[0].cursor) : null,
  };
}

function parseSinceDate(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, "Choose the start date again.");
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, "That isn't a real date.");
  }
  if (date.getTime() > Date.now() + 24 * 3600_000) throw new HttpError(400, "The start date can't be in the future.");
  return date;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function previewSync(
  db: Db,
  gmail: GmailClient,
  options: { since?: unknown; query?: string },
): Promise<SyncPreview> {
  const query = options.query ?? mailQuery();
  const chosen = parseSinceDate(options.since);

  const { rows: cursorRows } = await db.query<{ cursor: Date | string }>("select cursor from mail_sync where id = 1");
  const cursor = cursorRows[0] ? new Date(cursorRows[0].cursor) : null;

  // An explicit date wins; otherwise continue a little before where the last sync stopped.
  let since: Date;
  if (chosen) since = chosen;
  else if (cursor) since = new Date(cursor.getTime() - OVERLAP_MS);
  else throw new HttpError(400, "This is the first sync. Choose the date to start from.");

  // Seconds, not a date: Gmail reads a plain date as midnight Pacific time.
  const listed = await gmail.listMessageIds(`${query} after:${Math.floor(since.getTime() / 1000)}`, MAX_LISTED);

  let handled = new Set<string>();
  if (listed.length > 0) {
    const { rows } = await db.query<{ message_id: string }>(
      "select message_id from synced_mails where message_id in (select jsonb_array_elements_text($1::jsonb))",
      [JSON.stringify(listed)],
    );
    handled = new Set(rows.map((r) => r.message_id));
  }

  // Gmail lists newest first; work oldest first so "last synced" only ever moves forward.
  const fresh = listed.filter((id) => !handled.has(id)).reverse();
  const batch = fresh.slice(0, MAX_MAILS_PER_SYNC);

  const mails = await mapLimit(batch, FETCH_CONCURRENCY, async (id): Promise<MailPreview> => {
    const m = await gmail.getMessage(id);
    return { id: m.id, subject: m.subject, from: m.from, date: m.date, company: extractCompany(m.subject), ids: extractNeoIds(m.text) };
  });
  mails.sort((a, b) => a.date.localeCompare(b.date));

  return {
    query,
    since: since.toISOString(),
    matched: listed.length,
    alreadySynced: handled.size,
    mails,
    waiting: fresh.length - batch.length,
  };
}

/* ------------------------------------------------------------------ */

export interface MailDecision {
  id: string;
  subject: string;
  date: string;
  /** The company to save these students under, or null to skip the mail. */
  company: string | null;
  ids: string[];
}

export interface SavedMail {
  company: string;
  added: number;
  alreadyIn: number;
  unknownStudents: number;
}

export interface SaveResult {
  saved: SavedMail[];
  skipped: number;
  checkedUpTo: string | null;
}

const MAX_DECISIONS = 100;

export function validateDecisions(body: unknown): MailDecision[] {
  const list = (body as { mails?: unknown } | null)?.mails;
  if (!Array.isArray(list)) throw new HttpError(400, "Expected a list of mails.");
  if (list.length > MAX_DECISIONS) throw new HttpError(413, `Send at most ${MAX_DECISIONS} mails at a time.`);

  const seen = new Set<string>();
  return list.map((raw) => {
    const m = raw as Partial<MailDecision> | null;
    if (!m || typeof m.id !== "string" || m.id === "" || m.id.length > 200) throw new HttpError(400, "A mail is missing its id.");
    if (seen.has(m.id)) throw new HttpError(400, "The same mail was sent twice.");
    seen.add(m.id);

    const date = new Date(typeof m.date === "string" ? m.date : NaN);
    if (Number.isNaN(date.getTime())) throw new HttpError(400, "A mail has no valid date.");

    if (m.company !== null && m.company !== undefined && typeof m.company !== "string") throw new HttpError(400, "Invalid company.");
    if (!Array.isArray(m.ids) || m.ids.length > MAX_LOOKUP_TOKENS) throw new HttpError(400, "Invalid list of Neo IDs.");
    const ids = [...new Set(m.ids.map((x) => {
      if (typeof x !== "string" || !isValidNeoId(x.trim())) throw new HttpError(400, `Invalid Neo ID: ${JSON.stringify(x)}.`);
      return normalizeNeoId(x);
    }))];

    return {
      id: m.id,
      subject: typeof m.subject === "string" ? m.subject.slice(0, 500) : "",
      date: date.toISOString(),
      company: typeof m.company === "string" && m.company.trim() !== "" ? m.company : null,
      ids,
    };
  });
}

export async function saveSync(db: Db, decisions: MailDecision[]): Promise<SaveResult> {
  return db.transaction(async (tx) => {
    const saved: SavedMail[] = [];
    let skipped = 0;
    let newest: string | null = null;

    for (const d of decisions) {
      if (newest === null || d.date > newest) newest = d.date;

      const keep = d.company !== null && d.ids.length > 0;
      if (keep) {
        const r = await changePlacements(tx, { action: "add", company: d.company, text: d.ids.join(" ") });
        saved.push({ company: r.company, added: r.added, alreadyIn: r.alreadyIn, unknownStudents: r.unknownStudents.count });
      } else {
        skipped++;
      }

      await tx.query(
        `insert into synced_mails (message_id, subject, mail_date, company, student_count, status)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (message_id) do nothing`,
        [d.id, d.subject, d.date, keep ? d.company : null, keep ? d.ids.length : 0, keep ? "saved" : "skipped"],
      );
    }

    // "Last synced" only moves forward, and never past mail that wasn't part of this save.
    if (newest !== null) {
      await tx.query(
        `insert into mail_sync (id, cursor, last_run_at) values (1, $1, now())
         on conflict (id) do update
           set cursor = greatest(mail_sync.cursor, excluded.cursor), last_run_at = now()`,
        [newest],
      );
    }
    const { rows } = await tx.query<{ cursor: Date | string }>("select cursor from mail_sync where id = 1");
    return { saved, skipped, checkedUpTo: rows[0] ? new Date(rows[0].cursor).toISOString() : null };
  });
}
