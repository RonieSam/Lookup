import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { GET as health } from "../src/app/api/health/route";
import { readEnv } from "../src/lib/env";
import { databaseHint } from "../src/lib/http";

const CF = Symbol.for("__cloudflare-context__");
const g = globalThis as Record<symbol, unknown>;
const SAVED = { ...process.env };

afterEach(() => {
  delete g[CF];
  for (const k of ["DATABASE_URL", "ADMIN_PASSWORD", "SESSION_SECRET"]) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe("Reading settings", () => {
  it("prefers process.env", () => {
    process.env.ADMIN_PASSWORD = "from-process";
    g[CF] = { env: { ADMIN_PASSWORD: "from-cloudflare" } };
    assert.equal(readEnv("ADMIN_PASSWORD"), "from-process");
  });

  it("falls back to Cloudflare bindings when process.env doesn't have it", () => {
    delete process.env.ADMIN_PASSWORD;
    g[CF] = { env: { ADMIN_PASSWORD: "from-cloudflare", NOT_A_STRING: 5, EMPTY: "" } };
    assert.equal(readEnv("ADMIN_PASSWORD"), "from-cloudflare");
    assert.equal(readEnv("NOT_A_STRING"), undefined);
    assert.equal(readEnv("EMPTY"), undefined);
    assert.equal(readEnv("MISSING"), undefined);
  });

  it("returns undefined with no Cloudflare context at all", () => {
    delete process.env.ADMIN_PASSWORD;
    assert.equal(readEnv("ADMIN_PASSWORD"), undefined);
  });
});

describe("Health check", () => {
  it("names the missing settings and never prints a value", async () => {
    delete process.env.DATABASE_URL;
    process.env.ADMIN_PASSWORD = "super-secret-admin-password";
    process.env.SESSION_SECRET = "short";
    const res = await health();
    const text = await res.text();
    const body = JSON.parse(text);
    assert.equal(res.status, 503);
    assert.equal(body.ok, false);
    assert.deepEqual(body.settings, { DATABASE_URL: false, ADMIN_PASSWORD: true, SESSION_SECRET: false });
    assert.deepEqual(body.missing, ["DATABASE_URL", "SESSION_SECRET (needs 16+ characters)"]);
    assert.ok(!text.includes("super-secret-admin-password"));
    assert.ok(!text.includes("short"));
  });
});

describe("Database error hints", () => {
  it("explains common failures without echoing the driver's message", () => {
    assert.match(databaseHint({ code: "28P01", message: "password authentication failed for user 'neondb_owner'" })!, /rejected the password/);
    assert.ok(!databaseHint({ code: "28P01", message: "neondb_owner" })!.includes("neondb_owner"));
    assert.match(databaseHint({ code: "3D000" })!, /database name/);
    assert.match(databaseHint({ code: "ENOTFOUND" })!, /reach the database/);
    assert.equal(databaseHint(new Error("anything else")), null);
    assert.equal(databaseHint(null), null);
  });
});
