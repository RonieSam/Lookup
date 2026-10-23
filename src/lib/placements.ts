import type { Db } from "./db";
import { classifyTokens, tokenize } from "./neo";
import { HttpError, MAX_LOOKUP_TOKENS } from "./students";

/**
 * Placements: which students have been placed in which companies.
 *
 * A student can be in any number of companies, and a company has any number of
 * students. Company names are matched ignoring case and extra spaces, so
 * "tcs", "TCS" and " Tcs " are one company, shown with the spelling it was
 * first entered with.
 */

export const MAX_COMPANY_LENGTH = 100;
const SAMPLE_SIZE = 50;

export type PlacementAction = "add" | "remove" | "delete_company";
export const PLACEMENT_ACTIONS: readonly PlacementAction[] = ["add", "remove", "delete_company"];

export function cleanCompanyName(input: unknown): { name: string; key: string } {
  if (typeof input !== "string") throw new HttpError(400, "Enter a company name.");
  const name = input
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (name === "") throw new HttpError(400, "Enter a company name.");
  if (name.length > MAX_COMPANY_LENGTH) {
    throw new HttpError(400, `Company names can be at most ${MAX_COMPANY_LENGTH} characters.`);
  }
  return { name, key: name.normalize("NFKC").toLowerCase() };
}

export interface PlacementResult {
  action: PlacementAction;
  /** The company's stored name (which may differ in case from what was typed). */
  company: string;
  /** Distinct Neo IDs found in the pasted text. */
  ids: number;
  /** Words in the pasted text that aren't Neo IDs. */
  ignored: number;
  /** add: students newly placed in the company. */
  added: number;
  /** add: students who were already in the company. */
  alreadyIn: number;
  /** remove or delete_company: students taken out of the company. */
  removed: number;
  /** remove: IDs that weren't in the company to begin with. */
  notIn: number;
  /** add: IDs with no student record yet. They are still saved. */
  unknownStudents: { count: number; sample: string[] };
  /** True when the company no longer exists (it was deleted, or its last student was removed). */
  companyGone: boolean;
}

function parseIds(text: unknown) {
  if (typeof text !== "string") throw new HttpError(400, "Paste the Neo IDs first.");
  const classified = classifyTokens(tokenize(text));
  if (classified.length > MAX_LOOKUP_TOKENS) {
    throw new HttpError(413, `Too many words. Paste at most ${MAX_LOOKUP_TOKENS} at a time.`);
  }
  const ids = classified.filter((t) => t.status === "valid").map((t) => t.id);
  const ignored = classified.filter((t) => t.status === "invalid").length;
  if (ids.length === 0) throw new HttpError(400, "No Neo IDs found in that text.");
  return { ids, ignored };
}

export async function changePlacements(
  db: Db,
  input: { action: PlacementAction; company: unknown; text?: unknown },
): Promise<PlacementResult> {
  const { name: typed, key } = cleanCompanyName(input.company);
  const empty: PlacementResult = {
    action: input.action,
    company: typed,
    ids: 0,
    ignored: 0,
    added: 0,
    alreadyIn: 0,
    removed: 0,
    notIn: 0,
    unknownStudents: { count: 0, sample: [] },
    companyGone: false,
  };

  if (input.action === "delete_company") {
    return db.transaction(async (tx) => {
      const { rows } = await tx.query<{ name: string }>("select name from companies where key = $1 for update", [key]);
      if (!rows[0]) throw new HttpError(404, `There's no company called ${typed}.`);
      const { rows: n } = await tx.query<{ n: number }>(
        "select count(*)::int as n from placements where company_key = $1",
        [key],
      );
      await tx.query("delete from companies where key = $1", [key]); // placements go with it
      return { ...empty, company: rows[0].name, removed: n[0]?.n ?? 0, companyGone: true };
    });
  }

  const { ids, ignored } = parseIds(input.text);
  const idsJson = JSON.stringify(ids);

  if (input.action === "add") {
    return db.transaction(async (tx) => {
      await tx.query("insert into companies (key, name) values ($1, $2) on conflict (key) do nothing", [key, typed]);
      const { rows: c } = await tx.query<{ name: string }>("select name from companies where key = $1", [key]);

      const { rows: inserted } = await tx.query<{ neo_id: string }>(
        `insert into placements (neo_id, company_key)
         select t.x, $2 from jsonb_array_elements_text($1::jsonb) as t(x)
         on conflict do nothing
         returning neo_id`,
        [idsJson, key],
      );
      const { rows: unknown } = await tx.query<{ neo_id: string }>(
        `select t.x as neo_id from jsonb_array_elements_text($1::jsonb) as t(x)
         where not exists (select 1 from students s where s.neo_id = t.x)
         order by t.x`,
        [idsJson],
      );
      return {
        ...empty,
        company: c[0]?.name ?? typed,
        ids: ids.length,
        ignored,
        added: inserted.length,
        alreadyIn: ids.length - inserted.length,
        unknownStudents: { count: unknown.length, sample: unknown.slice(0, SAMPLE_SIZE).map((u) => u.neo_id) },
      };
    });
  }

  // remove
  return db.transaction(async (tx) => {
    const { rows: c } = await tx.query<{ name: string }>("select name from companies where key = $1 for update", [key]);
    if (!c[0]) throw new HttpError(404, `There's no company called ${typed}.`);

    const { rows: deleted } = await tx.query<{ neo_id: string }>(
      `delete from placements
       where company_key = $2 and neo_id in (select jsonb_array_elements_text($1::jsonb))
       returning neo_id`,
      [idsJson, key],
    );
    // A company with nobody left in it disappears, so the list never shows empty companies.
    const { rows: gone } = await tx.query<{ key: string }>(
      `delete from companies c
       where c.key = $1 and not exists (select 1 from placements p where p.company_key = c.key)
       returning c.key`,
      [key],
    );
    return {
      ...empty,
      company: c[0].name,
      ids: ids.length,
      ignored,
      removed: deleted.length,
      notIn: ids.length - deleted.length,
      companyGone: gone.length > 0,
    };
  });
}
