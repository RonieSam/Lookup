import { Client } from "@neondatabase/serverless";
import { readEnv } from "./env";

/** The small slice of a Postgres client the app needs. Tests swap in their own. */
export interface Db {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

type NeonClient = InstanceType<typeof Client>;

/**
 * Neon's serverless driver talks to Postgres over WebSockets, so it runs on
 * Cloudflare Workers, Vercel and Node alike (the standard `pg` driver needs raw
 * TCP sockets, which Workers doesn't have).
 *
 * A WebSocket can't outlive the request that opened it on a serverless
 * platform, so nothing is pooled: each query or transaction opens a
 * connection, does its work, and closes it before returning.
 */
function neonAdapter(connectionString: string): Db {
  const wrap = (client: NeonClient): Db => ({
    query: async <T>(sql: string, params?: unknown[]) =>
      (await client.query(sql, params as unknown[])) as unknown as { rows: T[] },
    transaction: (fn) => fn(wrap(client)), // already inside a transaction
  });

  const open = async () => {
    const client = new Client({ connectionString });
    await client.connect();
    return client;
  };
  // Closing normally takes one round trip. The cap means a connection that never
  // acknowledges the close can't hold up the response.
  const close = async (client: NeonClient) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      client.end().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2000);
      }),
    ]);
    clearTimeout(timer);
  };

  return {
    async query<T>(sql: string, params?: unknown[]) {
      const client = await open();
      try {
        return (await client.query(sql, params as unknown[])) as unknown as { rows: T[] };
      } finally {
        await close(client);
      }
    },
    async transaction(fn) {
      const client = await open();
      try {
        await client.query("BEGIN");
        const result = await fn(wrap(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        await close(client);
      }
    },
  };
}

const globalForDb = globalThis as unknown as {
  __neoDb?: Db;
  __neoSchema?: Promise<void>;
};

/** Replace the database (used by tests). Forces the schema to be re-checked. */
export function setDb(db: Db | undefined) {
  globalForDb.__neoDb = db;
  globalForDb.__neoSchema = undefined;
}

function getDb(): Db {
  if (!globalForDb.__neoDb) {
    const url = readEnv("DATABASE_URL");
    if (!url) {
      throw new Error("DATABASE_URL is not set. Add your Neon connection string to the environment.");
    }
    globalForDb.__neoDb = neonAdapter(url);
  }
  return globalForDb.__neoDb;
}

/**
 * Creates the tables on first use, so deploying needs no manual migration.
 * Safe to run repeatedly and from several cold starts at once.
 */
async function ensureSchema(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(7424001)");
    await tx.query(`
      create table if not exists students (
        neo_id     text primary key check (neo_id ~ '^([A-Z][0-9]){4}$'),
        data       jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`);
    await tx.query(`
      create table if not exists student_columns (
        key      text primary key,
        label    text not null,
        position integer not null
      )`);
    await tx.query(`
      create table if not exists companies (
        key        text primary key,
        name       text not null,
        created_at timestamptz not null default now()
      )`);
    // One row per (student, company), so a student can be placed in several companies.
    // No foreign key to students: a placement can be recorded before the student is uploaded.
    await tx.query(`
      create table if not exists placements (
        neo_id      text not null check (neo_id ~ '^([A-Z][0-9]){4}$'),
        company_key text not null references companies (key) on delete cascade,
        created_at  timestamptz not null default now(),
        primary key (neo_id, company_key)
      )`);
    await tx.query("create index if not exists placements_company_idx on placements (company_key)");
    // Mail sync: one row remembering how far the last sync got, and one row per mail already handled.
    await tx.query(`
      create table if not exists mail_sync (
        id          integer primary key check (id = 1),
        cursor      timestamptz not null,
        last_run_at timestamptz not null default now()
      )`);
    await tx.query(`
      create table if not exists synced_mails (
        message_id    text primary key,
        subject       text not null,
        mail_date     timestamptz not null,
        company       text,
        student_count integer not null default 0,
        status        text not null check (status in ('saved', 'skipped')),
        synced_at     timestamptz not null default now()
      )`);
    await tx.query(`
      create table if not exists login_throttle (
        ip           text primary key,
        fails        integer not null default 0,
        window_start timestamptz not null default now()
      )`);
  });
}

/** Returns the database with the schema guaranteed to exist. */
export async function getReadyDb(): Promise<Db> {
  const db = getDb();
  if (!globalForDb.__neoSchema) {
    globalForDb.__neoSchema = ensureSchema(db).catch((err) => {
      globalForDb.__neoSchema = undefined; // retry on the next request
      throw err;
    });
  }
  await globalForDb.__neoSchema;
  return db;
}
