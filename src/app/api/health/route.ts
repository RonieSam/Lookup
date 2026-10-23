import { getReadyDb } from "@/lib/db";
import { readEnv } from "@/lib/env";
import { databaseHint, json } from "@/lib/http";

/**
 * Open /api/health after a deploy to see what's missing. It reports whether each
 * setting exists and whether the database answers, and never shows a value.
 */
export async function GET() {
  const settings = {
    DATABASE_URL: Boolean(readEnv("DATABASE_URL")),
    ADMIN_PASSWORD: Boolean(readEnv("ADMIN_PASSWORD")),
    SESSION_SECRET: (readEnv("SESSION_SECRET")?.length ?? 0) >= 16,
  };
  const missing = Object.entries(settings)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  let database: { ok: boolean; problem?: string; code?: string } = { ok: false, problem: "DATABASE_URL is not set." };
  if (settings.DATABASE_URL) {
    try {
      const db = await getReadyDb();
      await db.query("select 1");
      database = { ok: true };
    } catch (err) {
      console.error(err);
      database = {
        ok: false,
        problem: databaseHint(err) ?? "Couldn't connect to the database. See the deployment logs for the error.",
        code: typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : undefined,
      };
    }
  }

  const ok = missing.length === 0 && database.ok;
  return json(
    {
      ok,
      settings,
      ...(missing.length > 0 && {
        missing: missing.map((n) => (n === "SESSION_SECRET" ? "SESSION_SECRET (needs 16+ characters)" : n)),
      }),
      database,
    },
    ok ? 200 : 503,
  );
}
