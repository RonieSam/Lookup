import { getReadyDb } from "@/lib/db";
import { handle, json, requireAdmin } from "@/lib/http";
import { mailSyncStatus } from "@/lib/mailSync";

export const GET = handle(async (request) => {
  await requireAdmin(request);
  return json(await mailSyncStatus(await getReadyDb()));
});
