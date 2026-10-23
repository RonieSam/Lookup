import { getReadyDb } from "@/lib/db";
import { handle, json, readJson, requireAdmin } from "@/lib/http";
import { PLACEMENT_ACTIONS, changePlacements, type PlacementAction } from "@/lib/placements";
import { HttpError } from "@/lib/students";

const MAX_TEXT = 200_000;

export const POST = handle(async (request) => {
  await requireAdmin(request);
  const body = (await readJson(request)) as { action?: unknown; company?: unknown; text?: unknown };

  const action = body?.action as PlacementAction;
  if (!PLACEMENT_ACTIONS.includes(action)) throw new HttpError(400, "Unknown action.");
  if (typeof body.text === "string" && body.text.length > MAX_TEXT) {
    throw new HttpError(413, "That's too much text at once.");
  }
  return json(await changePlacements(await getReadyDb(), { action, company: body.company, text: body.text }));
});
