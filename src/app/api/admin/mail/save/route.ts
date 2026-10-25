import { getReadyDb } from "@/lib/db";
import { handle, json, readJson, requireAdmin } from "@/lib/http";
import { saveSync, validateDecisions } from "@/lib/mailSync";

/** Saves the mails the admin confirmed and moves the "last synced" date forward. */
export const POST = handle(async (request) => {
  await requireAdmin(request);
  const decisions = validateDecisions(await readJson(request));
  return json(await saveSync(await getReadyDb(), decisions));
});
