import { Pool } from "pg";

/** The small slice of a Postgres client the app needs. Tests swap in their own. */
export interface Db {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

function pgAdapter(connectionString: string): Db {
  const pool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 10_000 });
  return {
    query: async <T>(sql: string, params?: unknown[]) => (await pool.query(sql, params)) as unknown as { rows: T[] },
    async transaction(fn) {
      const client = await pool.connect();
      const tx: Db = {
        query: async <T>(sql: string, params?: unknown[]) => (await client.query(sql, params)) as unknown as { rows: T[] },
        transaction: (inner) => inner(tx), // already inside a transaction
      };
      try {
        await client.query("BEGIN");
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
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
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set. Add your Postgres connection string to the environment.");
    }
    globalForDb.__neoDb = pgAdapter(url);
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
