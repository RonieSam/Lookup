import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { SESSION_COOKIE, checkPassword, createSessionToken, isAdmin, verifySessionToken } from "../src/lib/auth";
import { freshDb } from "./helpers";

process.env.ADMIN_PASSWORD = "correct horse battery";
process.env.SESSION_SECRET = "test-secret-test-secret-123456";
(process.env as Record<string, string>).NODE_ENV = "test";

const jsonReq = (url: string, body: unknown, cookie?: string, ip = "1.2.3.4") =>
  new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

describe("Session tokens", () => {
  it("accepts a fresh token, rejects tampering, expiry and junk", async () => {
    const t = await createSessionToken();
    assert.ok(await verifySessionToken(t));
    const [exp, sig] = t.split(".");
    assert.ok(!(await verifySessionToken(`${Number(exp) + 1000}.${sig}`)));
    assert.ok(!(await verifySessionToken(`${exp}.${sig.replace(/.$/, sig.endsWith("0") ? "1" : "0")}`)));
    assert.ok(!(await verifySessionToken(await createSessionToken(Date.now() - 9 * 3600_000))));
    for (const junk of [undefined, "", "abc", ".", "1.", ".abc", "NaN.abc"]) assert.ok(!(await verifySessionToken(junk)));
  });

  it("checks the password", async () => {
    assert.ok(await checkPassword("correct horse battery"));
    assert.ok(!(await checkPassword("correct horse batter")));
    assert.ok(!(await checkPassword("")));
  });
});

describe("Admin routes", () => {
  let login: typeof import("../src/app/api/admin/login/route");
  let upload: typeof import("../src/app/api/admin/upload/route");
  let status: typeof import("../src/app/api/admin/status/route");
  let lookup: typeof import("../src/app/api/lookup/route");
  let placements: typeof import("../src/app/api/admin/placements/route");

  before(async () => {
    await freshDb();
    login = await import("../src/app/api/admin/login/route");
    upload = await import("../src/app/api/admin/upload/route");
    status = await import("../src/app/api/admin/status/route");
    lookup = await import("../src/app/api/lookup/route");
    placements = await import("../src/app/api/admin/placements/route");
  });

  const payload = { rows: [{ neoId: "A1B2C3D4", values: { full_name: "Asha" } }], columns: [{ key: "full_name", label: "Name" }], overwrite: false, dryRun: false };

  it("blocks upload and status without signing in", async () => {
    assert.equal((await upload.POST(jsonReq("/api/admin/upload", payload))).status, 401);
    assert.equal((await status.GET(new Request("http://localhost/api/admin/status"))).status, 401);
    assert.equal((await upload.POST(jsonReq("/api/admin/upload", payload, `${SESSION_COOKIE}=1.deadbeef`))).status, 401);
  });

  it("rejects a wrong password, accepts the right one, and sets a hardened cookie", async () => {
    assert.equal((await login.POST(jsonReq("/api/admin/login", { password: "nope" }))).status, 401);
    const ok = await login.POST(jsonReq("/api/admin/login", { password: "correct horse battery" }));
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=strict/i);
    assert.match(cookie, /Max-Age=28800/i);
  });

  it("lets a signed-in admin upload, and the public look up", async () => {
    const ok = await login.POST(jsonReq("/api/admin/login", { password: "correct horse battery" }));
    const cookie = ok.headers.get("set-cookie")!.split(";")[0];
    assert.ok(await isAdmin(new Request("http://localhost", { headers: { cookie } })));

    const up = await upload.POST(jsonReq("/api/admin/upload", payload, cookie));
    assert.equal(up.status, 200);
    assert.equal((await up.json()).newStudents, 1);

    const st = await status.GET(new Request("http://localhost/api/admin/status", { headers: { cookie } }));
    assert.equal((await st.json()).studentCount, 1);

    const res = await lookup.POST(jsonReq("/api/lookup", { text: "a1b2c3d4 BAD" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.rows[0].data.full_name, "Asha");
    assert.equal(body.summary.ignored, 1);
    assert.equal(body.rows.length, 1);
  });

  it("placements are admin-only, and work for a signed-in admin", async () => {
    const body = { action: "add", company: "Google", text: "A1B2C3D4" };
    assert.equal((await placements.POST(jsonReq("/api/admin/placements", body))).status, 401);
    assert.equal((await placements.POST(jsonReq("/api/admin/placements", body, `${SESSION_COOKIE}=1.deadbeef`))).status, 401);

    const cookie = (await login.POST(jsonReq("/api/admin/login", { password: "correct horse battery" }, undefined, "5.5.5.5"))).headers.get("set-cookie")!.split(";")[0];
    const ok = await placements.POST(jsonReq("/api/admin/placements", body, cookie));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).added, 1);

    // visible to everyone on the public lookup
    const l = await (await lookup.POST(jsonReq("/api/lookup", { text: "A1B2C3D4" }))).json();
    assert.deepEqual(l.rows[0].companies, ["Google"]);
    assert.equal(l.hasPlacements, true);

    assert.equal((await placements.POST(jsonReq("/api/admin/placements", { ...body, action: "explode" }, cookie))).status, 400);
    assert.equal((await placements.POST(jsonReq("/api/admin/placements", { ...body, company: "  " }, cookie))).status, 400);
    assert.equal((await placements.POST(jsonReq("/api/admin/placements", { action: "remove", company: "Nope", text: "A1B2C3D4" }, cookie))).status, 404);

    const st = await status.GET(new Request("http://localhost/api/admin/status", { headers: { cookie } }));
    assert.deepEqual((await st.json()).companies, [{ name: "Google", count: 1 }]);
  });

  it("searching all students is admin-only", async () => {
    const search = await import("../src/app/api/admin/search/route");
    assert.equal((await search.POST(jsonReq("/api/admin/search", { q: "asha" }))).status, 401);
    assert.equal((await search.POST(jsonReq("/api/admin/search", { q: "asha" }, `${SESSION_COOKIE}=1.deadbeef`))).status, 401);

    const cookie = (await login.POST(jsonReq("/api/admin/login", { password: "correct horse battery" }, undefined, "4.4.4.4"))).headers.get("set-cookie")!.split(";")[0];
    const ok = await search.POST(jsonReq("/api/admin/search", { q: "asha" }, cookie));
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual(body.terms, ["asha"]);
    assert.ok(Array.isArray(body.hits) && typeof body.total === "number");

    assert.equal((await search.POST(jsonReq("/api/admin/search", { q: "   " }, cookie))).status, 400);
    assert.equal((await search.POST(jsonReq("/api/admin/search", { q: 7 }, cookie))).status, 400);
    assert.equal((await search.POST(jsonReq("/api/admin/search", {}, cookie))).status, 400);
  });

  it("refuses non-JSON bodies and malformed upload bodies", async () => {
    const cookie = (await login.POST(jsonReq("/api/admin/login", { password: "correct horse battery" }))).headers.get("set-cookie")!.split(";")[0];
    const form = new Request("http://localhost/api/admin/upload", { method: "POST", headers: { cookie, "content-type": "text/plain" }, body: "x" });
    assert.equal((await upload.POST(form)).status, 415);
    assert.equal((await upload.POST(jsonReq("/api/admin/upload", { rows: [{ neoId: "bad", values: {} }], columns: [] }, cookie))).status, 400);
  });

  it("locks an IP out after five wrong passwords, and a correct one clears the count", async () => {
    const ip = "9.9.9.9";
    for (let i = 0; i < 5; i++) assert.equal((await login.POST(jsonReq("/api/admin/login", { password: "x" }, undefined, ip))).status, 401);
    const locked = await login.POST(jsonReq("/api/admin/login", { password: "correct horse battery" }, undefined, ip));
    assert.equal(locked.status, 429);
    assert.match((await locked.json()).error, /minute/);
    // A different IP is unaffected, and success resets its own counter.
    for (let i = 0; i < 3; i++) await login.POST(jsonReq("/api/admin/login", { password: "x" }, undefined, "8.8.8.8"));
    assert.equal((await login.POST(jsonReq("/api/admin/login", { password: "correct horse battery" }, undefined, "8.8.8.8"))).status, 200);
    for (let i = 0; i < 4; i++) assert.equal((await login.POST(jsonReq("/api/admin/login", { password: "x" }, undefined, "8.8.8.8"))).status, 401);
  });

  it("lookup never needs a sign-in, even if the old setting is present", async () => {
    process.env.REQUIRE_LOGIN_FOR_LOOKUP = "true"; // retired setting: must have no effect
    try {
      const res = await lookup.POST(jsonReq("/api/lookup", { text: "A1B2C3D4" }, undefined, "6.6.6.6"));
      assert.equal(res.status, 200);
    } finally {
      delete process.env.REQUIRE_LOGIN_FOR_LOOKUP;
    }
  });
});
