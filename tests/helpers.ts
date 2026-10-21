import { PGlite } from "@electric-sql/pglite";
import type { Db } from "../src/lib/db";
import { setDb } from "../src/lib/db";

/** A fresh in-memory Postgres wired in as the app's database. */
export async function freshDb(): Promise<Db> {
  const pg = new PGlite();
  const wrap = (q: { query: PGlite["query"] }): Db => ({
    query: (sql, params) => q.query(sql, params) as Promise<{ rows: never[] }>,
    transaction: (fn) => fn(wrap(q)),
  });
  const db: Db = {
    query: (sql, params) => pg.query(sql, params) as Promise<{ rows: never[] }>,
    transaction: (fn) =>
      pg.transaction((tx) =>
        fn({
          query: (sql, params) => tx.query(sql, params) as Promise<{ rows: never[] }>,
          transaction: (inner) => inner(wrap(tx as unknown as { query: PGlite["query"] })),
        }),
      ),
  };
  setDb(db);
  return db;
}
