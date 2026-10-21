import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_HOURS,
  checkPassword,
  clearFailures,
  clientIp,
  createSessionToken,
  lockoutMinutes,
  recordFailure,
} from "@/lib/auth";
import { getReadyDb } from "@/lib/db";
import { handle, json, readJson } from "@/lib/http";
import { HttpError } from "@/lib/students";

export const POST = handle(async (request) => {
  const body = (await readJson(request)) as { password?: unknown };
  if (typeof body?.password !== "string" || body.password.length === 0 || body.password.length > 200) {
    throw new HttpError(400, "Enter the admin password.");
  }

  const db = await getReadyDb();
  const ip = clientIp(request);

  const locked = await lockoutMinutes(db, ip);
  if (locked > 0) {
    throw new HttpError(429, `Too many wrong passwords. Try again in ${locked} minute${locked === 1 ? "" : "s"}.`);
  }

  if (!(await checkPassword(body.password))) {
    await recordFailure(db, ip);
    throw new HttpError(401, "That password isn't right.");
  }

  await clearFailures(db, ip);
  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(SESSION_COOKIE, await createSessionToken(), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
  return response;
});
