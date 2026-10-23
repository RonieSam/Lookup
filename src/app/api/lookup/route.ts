import { getReadyDb } from "@/lib/db";
import { handle, json, readJson } from "@/lib/http";
import { HttpError, lookupStudents } from "@/lib/students";

const MAX_TEXT = 200_000;

/** Public on purpose: looking students up needs no sign-in. Only uploading is admin-only. */
export const POST = handle(async (request) => {
  const body = (await readJson(request)) as { text?: unknown };
  if (typeof body?.text !== "string") throw new HttpError(400, "Expected a text field.");
  if (body.text.length > MAX_TEXT) throw new HttpError(413, "That's too much text to look up at once.");

  return json(await lookupStudents(await getReadyDb(), body.text));
});
