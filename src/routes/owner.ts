// Authenticated routes. A caller (Accounts access token) manages gateways under their own
// callsign and under every club callsign they belong to (lib/access.ts).
import { Hono } from "hono";
import type { PoolClient } from "pg";
import { z } from "zod";
import { q, tx } from "../db/pool.js";
import { invalidateDirectory, loadDirectory } from "../data.js";
import { splitGatewayCallsign } from "../lib/callsign.js";
import { canManageGateway, managedCallsigns, type ManagedCallsign } from "../lib/access.js";
import { optionalViewer, requireKey, requireSignedIn, requireViewer, type Viewer, type ViewerVars } from "../lib/identity.js";
import { accountsKeys, keysConfigured, keysManageUrl, type KeyScope } from "../lib/apikeys.js";
import { can, permissionsOf, roleOf } from "../rbac.js";
import { claimDetailsInput, gatewayInput, heartbeatInput, type GatewayInput } from "./validation.js";

export const ownerRoutes = new Hono<ViewerVars>();

// Staff whose role grants gateway:edit-any may manage any listing (src/rbac.ts).
const isStaffEditor = (v: Viewer) => can(v.role, { gateway: ["edit-any"] });

/**
 * Which API-key scopes may call a /me route (identity.md §5.2). Everything not listed takes
 * sign-in only: claims, releases, watchers, the key list.
 */
export function meKeyScopes(method: string, path: string): KeyScope[] {
  const p = path.replace(/^.*?\/me(?=\/|$)/, "/me");
  if (p === "/me/gateways") return method === "GET" ? ["gateways:read"] : method === "POST" ? ["gateways:write"] : [];
  if (/^\/me\/gateways\/[^/]+$/.test(p)) return method === "PUT" || method === "DELETE" ? ["gateways:write"] : [];
  if (/^\/me\/gateways\/[^/]+\/details$/.test(p)) return method === "PUT" ? ["gateways:write"] : [];
  if (/^\/me\/gateways\/[^/]+\/confirm$/.test(p)) return method === "POST" ? ["heartbeat", "gateways:write"] : [];
  return [];
}

ownerRoutes.use("/me/*", (c, next) => requireViewer({ keyScopes: meKeyScopes(c.req.method, c.req.path) })(c, next));

ownerRoutes.get("/me", async (c) => {
  const v = await optionalViewer(c);
  if (!v) return c.json({ user: null, callsigns: [], permissions: {} });
  return c.json({
    user: { id: v.sub, name: v.name, callsign: v.callsign, callsignVerified: v.callsignVerified, role: roleOf(v.role) },
    permissions: permissionsOf(v.role),
    callsigns: await managedCallsigns(v),
  });
});

/** Resolve the callsign a gateway is listed under to its owner (the caller, or a club). */
async function resolveOwner(v: Viewer, input: GatewayInput) {
  const parts = splitGatewayCallsign(input.callsign);
  if (!parts) return { error: "invalid gateway callsign (expected e.g. W1AW or W1AW-10)", status: 400 } as const;
  const managed = await managedCallsigns(v);
  const m = managed.find((x) => x.callsign === parts.base);
  if (m) return { parts, clubId: m.clubId } as const;
  if (isStaffEditor(v)) {
    const { rows } = await q<{ id: string }>(`SELECT id FROM account_club WHERE callsign = $1`, [parts.base]);
    return { parts, clubId: rows[0]?.id ?? null } as const;
  }
  const yours = managed.map((x) => x.callsign).join(", ");
  return { error: `you can list gateways under ${yours}, not ${parts.base}. Club callsigns are managed in your openRMS account.`, status: 403 } as const;
}

/** Winlink listings under any callsign the caller manages (any SSID), claimed or not. */
ownerRoutes.get("/me/claimable", async (c) => {
  const v = c.get("viewer");
  const managed = await managedCallsigns(v);
  const myClubs = new Set(managed.map((m) => m.clubId).filter(Boolean));
  const { rows } = await q<{ id: string; owner_sub: string | null; owner_club_id: string | null }>(
    `SELECT id, owner_sub, owner_club_id FROM gateway
      WHERE source = 'winlink' AND removed_at IS NULL AND base_callsign = ANY($1) ORDER BY callsign`,
    [managed.map((m) => m.callsign)],
  );
  const all = new Map((await loadDirectory()).map((g) => [g.id, g]));
  return c.json({
    gateways: rows
      .map((r) => {
        const mine = r.owner_club_id ? myClubs.has(r.owner_club_id) : r.owner_sub === v.sub;
        const owned = r.owner_club_id != null || r.owner_sub != null;
        return { ...all.get(r.id), claimedByMe: owned && mine, claimedByOther: owned && !mine };
      })
      .filter((g) => g.id),
  });
});

async function winlinkRow(id: string) {
  const { rows } = await q(`SELECT * FROM gateway WHERE id = $1 AND source = 'winlink' AND removed_at IS NULL`, [id]);
  return rows[0] ?? null;
}

ownerRoutes.post("/me/gateways/:id/claim", async (c) => {
  const v = c.get("viewer");
  const g = await winlinkRow(c.req.param("id"));
  if (!g) return c.json({ error: "not found" }, 404);
  const m: ManagedCallsign | undefined = (await managedCallsigns(v)).find((x) => x.callsign === g.base_callsign);
  if (!m && !isStaffEditor(v)) {
    return c.json({ error: `${g.callsign} belongs to ${g.base_callsign}, which is not one of your callsigns or clubs` }, 403);
  }
  const clubId = m?.clubId ?? null;
  // Never take a claim held by someone else. A club claim is "ours" for every member.
  const { rowCount } = await q(
    `UPDATE gateway SET owner_sub = $2, owner_club_id = $3, claimed_at = COALESCE(claimed_at, now())
      WHERE id = $1 AND (
        (owner_sub IS NULL AND owner_club_id IS NULL)
        OR ($3::text IS NULL AND owner_club_id IS NULL AND owner_sub = $2)
        OR ($3::text IS NOT NULL AND owner_club_id = $3))`,
    [g.id, v.sub, clubId],
  );
  if (!rowCount) return c.json({ error: "already claimed by another account; ask a moderator" }, 409);
  invalidateDirectory();
  return c.json({ ok: true });
});

const claimedByCaller = async (v: Viewer, g: { owner_sub: string | null; owner_club_id: string | null } | null) =>
  !!g && (g.owner_sub != null || g.owner_club_id != null) && ((await canManageGateway(v, g)) || isStaffEditor(v));

ownerRoutes.put("/me/gateways/:id/details", async (c) => {
  const v = c.get("viewer");
  const g = await winlinkRow(c.req.param("id"));
  if (!(await claimedByCaller(v, g))) return c.json({ error: "not found" }, 404);
  const parsed = claimDetailsInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid details", issues: parsed.error.issues }, 400);
  const d = parsed.data;
  await q(`UPDATE gateway SET owner_comments = $2, software = $3, emcomm = $4, updated_at = now() WHERE id = $1`, [
    g.id, d.comments, d.software ?? null, JSON.stringify(d.emcomm),
  ]);
  invalidateDirectory();
  return c.json({ ok: true });
});

/** Give up a claim. The added details are removed with it; the Winlink listing stays. */
ownerRoutes.post("/me/gateways/:id/release", async (c) => {
  const v = c.get("viewer");
  const g = await winlinkRow(c.req.param("id"));
  if (!(await claimedByCaller(v, g))) return c.json({ error: "not found" }, 404);
  await q(
    `UPDATE gateway SET owner_sub = NULL, owner_club_id = NULL, claimed_at = NULL, owner_comments = '', software = NULL, emcomm = '{}'::jsonb
      WHERE id = $1`,
    [g.id],
  );
  invalidateDirectory();
  return c.json({ ok: true });
});

/** The caller's own listings and their clubs' listings. */
ownerRoutes.get("/me/gateways", async (c) => {
  const v = c.get("viewer");
  const clubIds = (await managedCallsigns(v)).map((m) => m.clubId).filter((x): x is string => !!x);
  const { rows } = await q<{ id: string }>(
    `SELECT id FROM gateway WHERE source = 'openrms'
        AND ((owner_club_id IS NULL AND owner_sub = $1) OR owner_club_id = ANY($2))`,
    [v.sub, clubIds],
  );
  const ids = new Set(rows.map((r) => r.id));
  return c.json({ gateways: (await loadDirectory()).filter((g) => ids.has(g.id)) });
});

async function writeChannels(cl: PoolClient, gatewayId: string, input: GatewayInput) {
  await cl.query(`DELETE FROM channel WHERE gateway_id = $1`, [gatewayId]);
  for (const ch of input.channels) {
    await cl.query(
      `INSERT INTO channel (gateway_id, frequency_hz, modem, variant, modem_version, service_code, extra_service_codes, operating_hours,
                            antenna, radio_range, gridsquare, baud, notes, compat_supported_modes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [gatewayId, ch.frequencyHz, ch.modem, ch.variant ?? null, ch.modemVersion ?? null, ch.serviceCode, ch.extraServiceCodes,
       ch.operatingHours, ch.antenna, ch.radioRange, ch.gridsquare ?? input.gridsquare, ch.baud, ch.notes, ch.compatSupportedModes ?? null],
    );
  }
  // A code nobody has used yet is registered as unlisted: it works at once, but is never
  // enumerated until staff make it public.
  const codes = [...new Set(input.channels.flatMap((ch) => [ch.serviceCode, ...ch.extraServiceCodes]))];
  await cl.query(`INSERT INTO service_code (code) SELECT unnest($1::text[]) ON CONFLICT (code) DO NOTHING`, [codes]);
}

ownerRoutes.post("/me/gateways", async (c) => {
  const v = c.get("viewer");
  const parsed = gatewayInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid gateway", issues: parsed.error.issues }, 400);
  const input = parsed.data;
  const own = await resolveOwner(v, input);
  if ("error" in own) return c.json({ error: own.error }, own.status);
  const exists = await q(`SELECT 1 FROM gateway WHERE source = 'openrms' AND callsign = $1`, [own.parts.callsign]);
  if (exists.rowCount) return c.json({ error: `${own.parts.callsign} is already listed` }, 409);
  const id = await tx(async (cl) => {
    const { rows } = await cl.query<{ id: string }>(
      `INSERT INTO gateway (source, callsign, base_callsign, owner_sub, owner_club_id, latitude, longitude, gridsquare,
                            location_precision, comments, software, winlink_listed, emcomm, confirmed_at)
       VALUES ('openrms',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now()) RETURNING id`,
      [own.parts.callsign, own.parts.base, v.sub, own.clubId, input.latitude ?? null, input.longitude ?? null, input.gridsquare,
       input.locationPrecision, input.comments, input.software ?? null, input.winlinkListed, JSON.stringify(input.emcomm)],
    );
    await writeChannels(cl, rows[0]!.id, input);
    return rows[0]!.id;
  });
  invalidateDirectory();
  return c.json({ id }, 201);
});

async function ownedGateway(v: Viewer, id: string) {
  const { rows } = await q(`SELECT * FROM gateway WHERE id = $1 AND source = 'openrms'`, [id]);
  const g = rows[0];
  if (!g) return null;
  if (!isStaffEditor(v) && !(await canManageGateway(v, g))) return null;
  return g;
}

ownerRoutes.put("/me/gateways/:id", async (c) => {
  const v = c.get("viewer");
  const g = await ownedGateway(v, c.req.param("id"));
  if (!g) return c.json({ error: "not found" }, 404);
  const parsed = gatewayInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid gateway", issues: parsed.error.issues }, 400);
  const input = parsed.data;
  const own = await resolveOwner(v, input);
  if ("error" in own) return c.json({ error: own.error }, own.status);
  try {
    await tx(async (cl) => {
      await cl.query(
        `UPDATE gateway SET callsign=$2, base_callsign=$3, owner_club_id=$4, latitude=$5, longitude=$6, gridsquare=$7, location_precision=$8,
                comments=$9, software=$10, winlink_listed=$11, emcomm=$12,
                hidden = CASE WHEN hidden_reason = 'owner callsign changed' THEN false ELSE hidden END,
                hidden_reason = CASE WHEN hidden_reason = 'owner callsign changed' THEN NULL ELSE hidden_reason END,
                confirmed_at=now(), updated_at=now() WHERE id=$1`,
        [g.id, own.parts.callsign, own.parts.base, own.clubId, input.latitude ?? null, input.longitude ?? null, input.gridsquare,
         input.locationPrecision, input.comments, input.software ?? null, input.winlinkListed, JSON.stringify(input.emcomm)],
      );
      await writeChannels(cl, g.id, input);
    });
  } catch (e: any) {
    if (e?.code === "23505") return c.json({ error: `${own.parts.callsign} is already listed` }, 409);
    throw e;
  }
  invalidateDirectory();
  return c.json({ id: g.id });
});

/** "Still on the air": keeps a hand-maintained listing current without a heartbeat client. */
ownerRoutes.post("/me/gateways/:id/confirm", async (c) => {
  const g = await ownedGateway(c.get("viewer"), c.req.param("id"));
  if (!g) return c.json({ error: "not found" }, 404);
  await q(`UPDATE gateway SET confirmed_at = now() WHERE id = $1`, [g.id]);
  invalidateDirectory();
  return c.json({ ok: true });
});

ownerRoutes.delete("/me/gateways/:id", async (c) => {
  const g = await ownedGateway(c.get("viewer"), c.req.param("id"));
  if (!g) return c.json({ error: "not found" }, 404);
  await q(`DELETE FROM gateway WHERE id = $1`, [g.id]);
  invalidateDirectory();
  return c.body(null, 204);
});

// ── API keys: minted and managed at Accounts (identity.md §5.3) ────────────────

/** The caller's Atlas keys, listed by Accounts, with the page that manages them. */
ownerRoutes.get("/me/keys", async (c) => {
  if (!keysConfigured()) return c.json({ keys: [], manage: keysManageUrl(), error: "key list unavailable (Atlas has no Accounts client)" });
  try {
    return c.json(await accountsKeys(c.get("viewer").sub));
  } catch (e) {
    console.error(`[keys] list failed: ${e}`);
    return c.json({ keys: [], manage: keysManageUrl(), error: "Accounts didn't answer; try again shortly" }, 502);
  }
});

const minted = (c: import("hono").Context) =>
  c.json({ error: `API keys are made at openRMS Accounts now: ${keysManageUrl()} (pick Atlas and the scopes you need)`, manage: keysManageUrl() }, 410);
ownerRoutes.post("/me/keys", minted);
ownerRoutes.delete("/me/keys/:id", minted);

ownerRoutes.post("/gateways/:id/report", requireSignedIn, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  const reason = String(body.reason ?? "").trim().slice(0, 1000);
  if (!reason) return c.json({ error: "reason is required" }, 400);
  const { rowCount } = await q(
    `INSERT INTO abuse_report (gateway_id, reporter_sub, reason) SELECT id, $2, $3 FROM gateway WHERE id = $1`,
    [c.req.param("id"), c.get("viewer").sub, reason],
  );
  if (!rowCount) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true }, 201);
});

/**
 * Heartbeat from gateway software, with an Accounts API key holding `heartbeat`
 * (Authorization: Bearer ormk_…, or x-api-key). The key's owner must be able to manage the
 * gateway (own listing, or a member of its club).
 */
ownerRoutes.post("/gateways/:id/heartbeat", requireKey("heartbeat"), async (c) => {
  const { rows } = await q(`SELECT id, owner_sub, owner_club_id FROM gateway WHERE id = $1 AND source = 'openrms'`, [c.req.param("id")]);
  const g = rows[0];
  if (!g || !(await canManageGateway({ sub: c.get("viewer").sub }, g))) return c.json({ error: "not found" }, 404);
  const parsed = heartbeatInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid heartbeat", issues: parsed.error.issues }, 400);
  const hb = parsed.data;
  await q(
    `UPDATE gateway SET last_heartbeat_at = now(), live = $2, software = COALESCE($3, software) WHERE id = $1`,
    [g.id, JSON.stringify({ currentFrequencyHz: hb.currentFrequencyHz ?? null, currentModem: hb.currentModem ?? null, busy: hb.busy ?? null }), hb.software ?? null],
  );
  invalidateDirectory();
  return c.json({ ok: true, at: new Date().toISOString() });
});
