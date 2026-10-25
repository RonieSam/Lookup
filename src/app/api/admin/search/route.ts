import { getReadyDb } from "@/lib/db";
import { findStudents } from "@/lib/find";
import { handle, json, readJson, requireAdmin } from "@/lib/http";

/**
 * Admin-only on purpose. Looking a student up needs their Neo ID, but searching
 * by name, number or company would let anyone list the whole student database.
 */
export const POST = handle(async (request) => {
  await requireAdmin(request);
  const body = (await readJson(request)) as { q?: unknown };
  return json(await findStudents(await getReadyDb(), body?.q));
});
