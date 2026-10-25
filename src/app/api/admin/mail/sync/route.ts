import { getReadyDb } from "@/lib/db";
import { createGmailClient, gmailConfigured } from "@/lib/gmail";
import { handle, json, readJson, requireAdmin } from "@/lib/http";
import { previewSync } from "@/lib/mailSync";
import { HttpError } from "@/lib/students";

/** Reads new mail and returns what it found. Saves nothing. */
export const POST = handle(async (request) => {
  await requireAdmin(request);
  if (!gmailConfigured()) {
    throw new HttpError(
      400,
      "Mail sync isn't set up yet. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN (see the README).",
    );
  }
  const body = (await readJson(request)) as { since?: unknown } | null;
  return json(await previewSync(await getReadyDb(), createGmailClient(), { since: body?.since }));
});
