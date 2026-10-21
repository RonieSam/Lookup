import { isAdmin } from "@/lib/auth";
import { getReadyDb } from "@/lib/db";
import { handle, json, readJson } from "@/lib/http";
import { HttpError, lookupStudents } from "@/lib/students";

const MAX_TEXT = 200_000;

export const POST = handle(async (request) => {
  // Optional: set REQUIRE_LOGIN_FOR_LOOKUP=true to keep lookups behind the admin password too.
  if (process.env.REQUIRE_LOGIN_FOR_LOOKUP === "true" && !(await isAdmin(request))) {
    return json({ error: "Lookups are restricted. Sign in on the admin page first.", loginRequired: true }, 401);
  }

  const body = (await readJson(request)) as { text?: unknown };
  if (typeof body?.text !== "string") throw new HttpError(400, "Expected a text field.");
  if (body.text.length > MAX_TEXT) throw new HttpError(413, "That's too much text to look up at once.");

  return json(await lookupStudents(await getReadyDb(), body.text));
});
