import { getReadyDb } from "@/lib/db";
import { handle, json, readJson, requireAdmin } from "@/lib/http";
import { applyUpload, validateUpload } from "@/lib/students";

export const POST = handle(async (request) => {
  await requireAdmin(request);
  const input = validateUpload(await readJson(request));
  return json(await applyUpload(await getReadyDb(), input));
});
