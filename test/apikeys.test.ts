import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { flushKeyUse, KEY_SCOPES, noteKeyUse, rateLimit, resetKeyState } from "../src/lib/apikeys.js";
import { meKeyScopes } from "../src/routes/owner.js";

describe("which key scopes may call a /me route", () => {
  const cases: [string, string, string[]][] = [
    ["GET", "/api/v1/me/gateways", ["gateways:read"]],
    ["POST", "/api/v1/me/gateways", ["gateways:write"]],
    ["PUT", "/api/v1/me/gateways/abc", ["gateways:write"]],
    ["DELETE", "/api/v1/me/gateways/abc", ["gateways:write"]],
    ["PUT", "/api/v1/me/gateways/abc/details", ["gateways:write"]],
    ["POST", "/api/v1/me/gateways/abc/confirm", ["heartbeat", "gateways:write"]],
    // sign-in only
    ["POST", "/api/v1/me/gateways/abc/claim", []],
    ["POST", "/api/v1/me/gateways/abc/release", []],
    ["GET", "/api/v1/me/claimable", []],
    ["GET", "/api/v1/me/watchers", []],
    ["GET", "/api/v1/me/keys", []],
    ["GET", "/api/v1/me", []],
    ["GET", "/api/v1/me/gateways/abc", []],
  ];
  for (const [m, p, want] of cases) it(`${m} ${p}`, () => expect(meKeyScopes(m, p)).toEqual(want));

  it("only offers registered scopes, never staff powers", () => {
    const offered = new Set(KEY_SCOPES.map((s) => s.scope));
    for (const [m, p] of cases) for (const s of meKeyScopes(m, p)) expect(offered.has(s as never)).toBe(true);
    for (const s of offered) expect(s).not.toMatch(/admin|staff|moder|audit/);
  });
});

describe("per-key rate limit", () => {
  beforeEach(() => resetKeyState());
  it("allows 120 heartbeats an hour per key, then asks to wait", () => {
    const t = 1_000_000;
    for (let i = 0; i < 120; i++) expect(rateLimit("k1", "heartbeat", t)).toBe(0);
    expect(rateLimit("k1", "heartbeat", t)).toBeGreaterThan(3500);
    expect(rateLimit("k2", "heartbeat", t)).toBe(0); // keys are separate
    expect(rateLimit("k1", "heartbeat", t + 3_600_000)).toBe(0); // next window
  });
});

describe("batched last-use report", () => {
  beforeEach(() => resetKeyState());
  afterEach(() => vi.unstubAllGlobals());
  it("keeps the batch when Accounts can't be reached, and sends the latest use per key", async () => {
    noteKeyUse("j1", Date.parse("2026-11-26T10:00:00Z"));
    noteKeyUse("j1", Date.parse("2026-11-26T10:05:00Z"));
    noteKeyUse("j1", Date.parse("2026-11-26T10:01:00Z")); // older: ignored
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    await expect(flushKeyUse()).rejects.toThrow();
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "t", expires_in: 600 });
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }));
    expect(await flushKeyUse()).toBe(1);
    expect(sent).toEqual([[{ jti: "j1", at: "2026-11-26T10:05:00.000Z" }]]);
    expect(await flushKeyUse()).toBe(0);
  });
});
