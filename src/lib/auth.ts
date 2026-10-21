import type { Db } from "./db";

/**
 * Admin sign-in.
 *
 * One shared admin password (ADMIN_PASSWORD) is exchanged for a signed,
 * HttpOnly session cookie. The cookie holds only an expiry time and an
 * HMAC signature made with SESSION_SECRET, so nothing is stored server-side.
 */

export const SESSION_COOKIE = "neo_admin";
export const SESSION_HOURS = 8;

const encoder = new TextEncoder();

function requireEnv(name: "ADMIN_PASSWORD" | "SESSION_SECRET"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Add it to the environment.`);
  if (name === "SESSION_SECRET" && value.length < 16) {
    throw new Error("SESSION_SECRET must be at least 16 characters.");
  }
  return value;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares two strings without leaking where they first differ. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when `input` is the admin password. Both sides are hashed first so lengths never leak. */
export async function checkPassword(input: string): Promise<boolean> {
  const secret = requireEnv("SESSION_SECRET");
  const [a, b] = await Promise.all([hmacHex(secret, `pw:${input}`), hmacHex(secret, `pw:${requireEnv("ADMIN_PASSWORD")}`)]);
  return safeEqual(a, b);
}

export async function createSessionToken(now = Date.now()): Promise<string> {
  const expires = now + SESSION_HOURS * 3600_000;
  const sig = await hmacHex(requireEnv("SESSION_SECRET"), `session:${expires}`);
  return `${expires}.${sig}`;
}

export async function verifySessionToken(token: string | undefined, now = Date.now()): Promise<boolean> {
  if (!token) return false;
  const [expiresText, sig] = token.split(".");
  const expires = Number(expiresText);
  if (!sig || !Number.isFinite(expires) || expires < now) return false;
  const expected = await hmacHex(requireEnv("SESSION_SECRET"), `session:${expires}`);
  return safeEqual(sig, expected);
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export async function isAdmin(request: Request): Promise<boolean> {
  return verifySessionToken(readCookie(request, SESSION_COOKIE));
}

/* ---------------- login throttling ---------------- */

export const MAX_FAILS = 5;
export const WINDOW_MINUTES = 15;

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return (forwarded?.split(",")[0] ?? request.headers.get("x-real-ip") ?? "unknown").trim().slice(0, 64);
}

/** Minutes left on the lockout for this IP, or 0 if it may try. */
export async function lockoutMinutes(db: Db, ip: string): Promise<number> {
  const { rows } = await db.query<{ minutes: number }>(
    `select ceil(extract(epoch from (window_start + make_interval(mins => $2) - now())) / 60)::int as minutes
     from login_throttle
     where ip = $1 and fails >= $3 and window_start + make_interval(mins => $2) > now()`,
    [ip, WINDOW_MINUTES, MAX_FAILS],
  );
  return rows[0]?.minutes ?? 0;
}

export async function recordFailure(db: Db, ip: string): Promise<void> {
  await db.query(
    `insert into login_throttle (ip, fails, window_start) values ($1, 1, now())
     on conflict (ip) do update set
       fails = case when login_throttle.window_start + make_interval(mins => $2) < now()
                    then 1 else login_throttle.fails + 1 end,
       window_start = case when login_throttle.window_start + make_interval(mins => $2) < now()
                           then now() else login_throttle.window_start end`,
    [ip, WINDOW_MINUTES],
  );
}

export async function clearFailures(db: Db, ip: string): Promise<void> {
  await db.query("delete from login_throttle where ip = $1", [ip]);
}
