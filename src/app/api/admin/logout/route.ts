import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { handle } from "@/lib/http";

export const POST = handle(async () => {
  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/", maxAge: 0 });
  return response;
});
