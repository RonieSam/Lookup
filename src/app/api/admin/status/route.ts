import { getReadyDb } from "@/lib/db";
import { handle, json, requireAdmin } from "@/lib/http";
import { adminSummary } from "@/lib/students";

export const GET = handle(async (request) => {
  await requireAdmin(request);
  return json(await adminSummary(await getReadyDb()));
});
