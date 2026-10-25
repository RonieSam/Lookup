import type { Db } from "./db";
import type { RecordData } from "./columns";
import { HttpError } from "./students";
import { MAX_SEARCH_LENGTH, searchTerms } from "./search";

export const MAX_FIND_RESULTS = 100;

export interface FindHit {
  neoId: string;
  /** False when the ID has placements but no student record. */
  inStudents: boolean;
  data: RecordData;
  /** Alphabetical. */
  companies: string[];
}

export interface FindResult {
  /** The words that were searched for, folded to lower case. */
  terms: string[];
  hits: FindHit[];
  /** How many students match in all, which can be more than `hits.length`. */
  total: number;
}

/** Escapes LIKE wildcards so a typed "%" or "_" is searched for literally. */
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, "\\$&")}%`;

/**
 * Finds students across every stored detail: Neo ID, each detail column's value,
 * and company names. Column names are not searched (searching "name" must not
 * match everyone just because a column is called "full_name").
 *
 * Same rules as the results table: every word must match somewhere in the row.
 */
export async function findStudents(db: Db, query: unknown): Promise<FindResult> {
  if (typeof query !== "string") throw new HttpError(400, "Type something to search for.");
  if (query.length > MAX_SEARCH_LENGTH) {
    throw new HttpError(400, `Search for at most ${MAX_SEARCH_LENGTH} characters at a time.`);
  }
  const terms = searchTerms(query);
  if (terms.length === 0) throw new HttpError(400, "Type something to search for.");

  // One condition per word, each with its own parameter. Only parameter numbers are built into the SQL.
  const conditions = terms.map(
    (_, i) => `(
      p.neo_id ilike $${i + 1} escape '\\'
      or exists (select 1 from jsonb_each_text(s.data) e where e.value ilike $${i + 1} escape '\\')
      or exists (
        select 1 from placements pl join companies c on c.key = pl.company_key
        where pl.neo_id = p.neo_id and c.name ilike $${i + 1} escape '\\'
      )
    )`,
  );

  const { rows } = await db.query<{
    neo_id: string;
    data: RecordData | null;
    in_students: boolean;
    companies: string[];
    total: number;
  }>(
    `with people as (
       select neo_id from students
       union
       select neo_id from placements
     )
     select p.neo_id,
            s.data,
            (s.neo_id is not null) as in_students,
            coalesce(
              (select array_agg(c.name order by lower(c.name), c.name)
               from placements pl join companies c on c.key = pl.company_key
               where pl.neo_id = p.neo_id),
              '{}') as companies,
            (count(*) over ())::int as total
     from people p
     left join students s on s.neo_id = p.neo_id
     where ${conditions.join(" and ")}
     order by p.neo_id
     limit ${MAX_FIND_RESULTS}`,
    terms.map(likePattern),
  );

  return {
    terms,
    total: rows[0]?.total ?? 0,
    hits: rows.map((r) => ({
      neoId: r.neo_id,
      inStudents: r.in_students,
      data: r.data ?? {},
      companies: r.companies ?? [],
    })),
  };
}
