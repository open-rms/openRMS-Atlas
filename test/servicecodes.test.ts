import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { limitUnlisted, nonPublic, resetCodeLimits } from "../src/lib/codelimit.js";
import { env } from "../src/env.js";
import { can } from "../src/rbac.js";
import { serviceCodeSchema } from "../src/routes/validation.js";

describe("unlisted service code rate limit", () => {
  beforeEach(() => resetCodeLimits());
  const app = new Hono().get("/", (c) => limitUnlisted(c, (c.req.query("c") ?? "").split(",").filter(Boolean)) ?? c.json({ ok: true }));

  it("only counts codes that are not public", () => {
    expect(nonPublic(new Set(["PUBLIC", "MYGRP"]), new Set(["PUBLIC"]))).toEqual(["MYGRP"]);
    expect(nonPublic(new Set(["PUBLIC"]), new Set(["PUBLIC"]))).toEqual([]);
  });

  it("charges each distinct code once, then answers 429 with Retry-After", async () => {
    for (let i = 0; i < env.UNLISTED_CODES_PER_HOUR; i++) expect((await app.request(`/?c=G${i}`)).status).toBe(200);
    expect((await app.request("/?c=G0,G1")).status).toBe(200); // already looked up: free
    const r = await app.request("/?c=G0,NEW");
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a request that names too many non-public codes at once", async () => {
    expect((await app.request("/?c=A1,A2,A3,A4,A5")).status).toBe(200);
    expect((await app.request("/?c=B1,B2,B3,B4,B5,B6")).status).toBe(400);
  });
});

describe("service code rules", () => {
  it("accepts 1-16 letters or digits, uppercased", () => {
    expect(serviceCodeSchema.parse(" mygrp1 ")).toBe("MYGRP1");
    for (const bad of ["", "MY-GRP", "MY_GRP", "A".repeat(17), "ÄRES"]) expect(serviceCodeSchema.safeParse(bad).success).toBe(false);
  });
  it("only admins and superadmins see and change codes", () => {
    expect(can("moderator", { servicecode: ["view"] })).toBe(false);
    expect(can("superadmin", { servicecode: ["view", "edit"] })).toBe(true);
    expect(can("moderator", { servicecode: ["edit"] })).toBe(false);
    expect(can("admin", { servicecode: ["edit"] })).toBe(true);
    expect(can("user", { servicecode: ["view"] })).toBe(false);
  });
});

describe("request log", () => {
  it("never writes query strings, so service codes stay out of the journal", async () => {
    const { requestLogger } = await import("../src/lib/reqlog.js");
    const lines: string[] = [];
    const app = new Hono().use("*", requestLogger((l) => lines.push(l))).get("/api/v1/gateways", (c) => c.json({}));
    await app.request("/api/v1/gateways?serviceCode=ZZSECRET&q=x");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^GET \/api\/v1\/gateways 200 \d+ms$/);
    expect(lines[0]).not.toContain("ZZSECRET");
  });
});
