// Watchers: community openRMS-Watch receivers reporting what they hear on the air.
// Spec: openRMS-Spec/watch/feed.md. Identity comes from openRMS-Accounts tokens; upload keys
// (ormsw_) are the Directory's own (identity.md §5).
import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import { z } from "zod";
import { q } from "../db/pool.js";
import { publicDirectory } from "../data.js";
import { bandOf, MODEM_IDS } from "../modes.js";
import { isValidGrid } from "../lib/callsign.js";
import { crcHex } from "../lib/crc.js";
import { optionalViewer, requireViewer, type ViewerVars } from "../lib/identity.js";
import { createKey, revokeKey, verifyKey } from "../lib/keys.js";
import { invalidateSightings, loadSightings, SIGHTING_DAYS } from "../watch/sightings.js";
import { contributors } from "../watch/contributors.js";
import { EVENT_SELECT, projector, type EventRow } from "../watch/project.js";
import { notifyNewEvents, onNewEvents } from "../watch/bus.js";
import { streamSSE } from "hono/streaming";
import { can } from "../rbac.js";

// ── Owner routes: /api/v1/me/watchers ───────────────────────────────────────────────────
export const watcherRoutes = new Hono<ViewerVars>();
watcherRoutes.use("*", requireViewer);

const watcherInput = z.object({
  name: z.string().trim().min(1).max(60),
  gridsquare: z.string().trim().refine(isValidGrid, "invalid Maidenhead locator").nullish(),
  locationPrecision: z.enum(["grid4", "grid6", "hidden"]).default("grid4"),
  public: z.boolean().default(true),
});

const watcherCols = `id, name, gridsquare, location_precision AS "locationPrecision", public, disabled,
  disabled_reason AS "disabledReason", api_key_id IS NOT NULL AS "hasKey", last_seen_at AS "lastSeenAt",
  last_status AS "lastStatus", created_at AS "createdAt"`;

watcherRoutes.get("/", async (c) => {
  const { rows } = await q(`SELECT ${watcherCols} FROM watcher WHERE owner_sub = $1 ORDER BY created_at`, [c.get("viewer").sub]);
  return c.json({ watchers: rows });
});

async function createWatcher(ownerSub: string, d: z.infer<typeof watcherInput>) {
  const { rows } = await q(
    `INSERT INTO watcher (owner_sub, name, gridsquare, location_precision, public) VALUES ($1,$2,$3,$4,$5) RETURNING ${watcherCols}`,
    [ownerSub, d.name, d.gridsquare ?? null, d.locationPrecision, d.public],
  );
  return rows[0];
}

watcherRoutes.post("/", async (c) => {
  const p = watcherInput.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "invalid watcher", issues: p.error.issues }, 400);
  return c.json(await createWatcher(c.get("viewer").sub, p.data), 201);
});

watcherRoutes.patch("/:id", async (c) => {
  const p = watcherInput.partial().safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "invalid watcher", issues: p.error.issues }, 400);
  const d = p.data;
  const { rows } = await q(
    `UPDATE watcher SET name = COALESCE($3, name), gridsquare = CASE WHEN $4::boolean THEN $5 ELSE gridsquare END,
            location_precision = COALESCE($6, location_precision), public = COALESCE($7, public)
      WHERE id = $1 AND owner_sub = $2 RETURNING ${watcherCols}`,
    [c.req.param("id"), c.get("viewer").sub, d.name ?? null, d.gridsquare !== undefined, d.gridsquare ?? null,
     d.locationPrecision ?? null, d.public ?? null],
  );
  return rows[0] ? c.json(rows[0]) : c.json({ error: "not found" }, 404);
});

async function ownWatcher(id: string, ownerSub: string) {
  const { rows } = await q(`SELECT * FROM watcher WHERE id = $1 AND owner_sub = $2`, [id, ownerSub]);
  return rows[0] ?? null;
}

/** Mint (or rotate) a watcher's upload key; the previous key stops working at once. */
async function mintWatcherKey(w: { id: string; name: string; owner_sub: string; api_key_id: string | null }) {
  const k = await createKey({ kind: "watcher", ownerSub: w.owner_sub, name: `watcher ${w.name}`, watcherId: w.id });
  if (w.api_key_id) await revokeKey(w.api_key_id);
  await q(`UPDATE watcher SET api_key_id = $2 WHERE id = $1`, [w.id, k.id]);
  return k.key;
}

watcherRoutes.delete("/:id", async (c) => {
  const w = await ownWatcher(c.req.param("id"), c.get("viewer").sub);
  if (!w) return c.json({ error: "not found" }, 404);
  if (w.api_key_id) await revokeKey(w.api_key_id);
  await q(`DELETE FROM watcher WHERE id = $1`, [w.id]);
  return c.body(null, 204);
});

watcherRoutes.post("/:id/key", async (c) => {
  const w = await ownWatcher(c.req.param("id"), c.get("viewer").sub);
  if (!w) return c.json({ error: "not found" }, 404);
  return c.json({ key: await mintWatcherKey(w), watcherId: w.id }, 201);
});

watcherRoutes.delete("/:id/key", async (c) => {
  const w = await ownWatcher(c.req.param("id"), c.get("viewer").sub);
  if (!w) return c.json({ error: "not found" }, 404);
  if (w.api_key_id) await revokeKey(w.api_key_id);
  await q(`UPDATE watcher SET api_key_id = NULL WHERE id = $1`, [w.id]);
  return c.body(null, 204);
});

// ── Public watch routes: /api/v1/watch ──────────────────────────────────────────────────
export const watchRoutes = new Hono();

const MAX_LINES = 1000;
const MAX_BYTES = 1_000_000;
const crc = z.string().regex(/^[0-9A-Fa-f]{4}$/).transform((s) => s.toUpperCase());
const call = z.string().trim().max(16).regex(/^[A-Za-z0-9/-]+$/).transform((s) => s.toUpperCase());
const ulid = z.string().min(10).max(40).regex(/^[0-9A-Za-z_-]+$/);
const hint = z
  .object({
    callsign: call.nullish(),
    match: z.enum(["heard", "inferred", "ambiguous", "unknown"]),
    candidates: z.array(call).max(20).default([]),
  })
  .nullish();
const dialHz = z.number().int().positive().max(1_300_000_000);
const modem = z.enum(MODEM_IDS);

const frameEv = z.object({
  type: z.literal("frame"), id: ulid, ts: z.iso.datetime(), modem, modemVersion: z.string().max(40).nullish(),
  dialHz, freqSource: z.enum(["scan", "channel"]).nullish(), freqAccuracyHz: z.number().nonnegative().nullish(),
  mode: z.string().max(20).nullish(),
  kind: z.enum(["CALL", "ACCEPT", "CQ", "DISCONNECT", "STATION", "BCAST_CTRL", "BCAST_DATA"]),
  from: call.nullish(), toCrc: crc.nullish(), callerCrc: crc.nullish(), calledCrc: crc.nullish(),
  sid: z.number().int().nullish(), bw: z.number().int().nullish(), snrDb: z.number().min(-50).max(80).nullish(),
  raw: z.string().max(500).nullish(), hint,
});
const attemptEv = z.object({
  type: z.literal("attempt"), id: ulid, start: z.iso.datetime(), end: z.iso.datetime().nullish(), modem, dialHz,
  from: call.nullish(), calledCrc: crc.nullish(), callerCrc: crc.nullish(), accepted: z.boolean().default(false),
  calls: z.number().int().min(0).max(1000).nullish(), bestSnrDb: z.number().min(-50).max(80).nullish(),
  frames: z.array(ulid).max(200).default([]), hint,
});
const coverageEv = z.object({
  type: z.literal("coverage"), id: ulid, start: z.iso.datetime(), end: z.iso.datetime(),
  ranges: z.array(z.tuple([dialHz, dialHz])).min(1).max(64), receiver: z.string().max(60).nullish(),
});
const statusEv = z.object({
  type: z.literal("status"), id: ulid, ts: z.iso.datetime(), software: z.string().max(60).nullish(),
  os: z.string().max(40).nullish(), sdr: z.string().max(60).nullish(), decoders: z.number().int().nullish(),
  cpuPct: z.number().nullish(), calibrated: z.boolean().nullish(), ppm: z.number().nullish(), uptimeS: z.number().nullish(),
});
const event = z.discriminatedUnion("type", [frameEv, attemptEv, coverageEv, statusEv]);
type Ev = z.infer<typeof event>;

/** Server-side sanity checks; the client's own judgment is never trusted. */
function sanity(e: Ev, now: number): string | null {
  const t = Date.parse("ts" in e ? e.ts : e.start);
  if (t > now + 5 * 60_000) return "timestamp in the future";
  if (t < now - 30 * 86400_000) return "timestamp older than 30 days";
  if (e.type === "frame" || e.type === "attempt") {
    // dialHz is the dial; the signal sits ~1.5 kHz above it on HF.
    if (!bandOf(e.dialHz) && !bandOf(e.dialHz + 1500)) return "frequency outside amateur allocations";
  }
  if (e.type === "coverage" && Date.parse(e.end) < Date.parse(e.start)) return "coverage ends before it starts";
  return null;
}


/** POST /api/v1/watch/ingest: NDJSON batch from a watcher, idempotent per event id. */
watchRoutes.post("/ingest", async (c) => {
  const key = c.req.header("x-api-key") ?? c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!key) return c.json({ error: "x-api-key header required" }, 401);
  const v = await verifyKey(key, "watcher");
  if (!v.ok) {
    if (v.status === 429) return c.json({ error: "slow down" }, 429, { "Retry-After": String(v.retryAfter ?? 60) });
    return c.json({ error: v.status === 403 ? v.error : "token rejected" }, v.status);
  }
  const { rows: ws } = await q(`SELECT id, disabled FROM watcher WHERE api_key_id = $1 AND owner_sub = $2`, [v.key.id, v.key.owner_sub]);
  const w = ws[0];
  if (!w) return c.json({ error: "token rejected" }, 401);
  if (w.disabled) return c.json({ error: "this watcher was disabled by a moderator" }, 403);

  const len = Number(c.req.header("content-length") ?? 0);
  if (len > MAX_BYTES) return c.json({ error: `body over ${MAX_BYTES} bytes` }, 413);
  const text = await c.req.text();
  if (Buffer.byteLength(text) > MAX_BYTES) return c.json({ error: `body over ${MAX_BYTES} bytes` }, 413);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > MAX_LINES) return c.json({ error: `more than ${MAX_LINES} lines` }, 413);

  const now = Date.now();
  const rejected: { id: string | null; error: string }[] = [];
  let accepted = 0, duplicate = 0;
  let lastStatus: z.infer<typeof statusEv> | null = null;
  for (const line of lines) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      rejected.push({ id: null, error: "not JSON" });
      continue;
    }
    const p = event.safeParse(raw);
    const id = (raw as { id?: unknown })?.id;
    if (!p.success) {
      rejected.push({ id: typeof id === "string" ? id : null, error: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      continue;
    }
    const e = p.data;
    const bad = sanity(e, now);
    if (bad) {
      rejected.push({ id: e.id, error: bad });
      continue;
    }
    const f = e.type === "frame" ? e : null;
    const a = e.type === "attempt" ? e : null;
    const r = await q(
      `INSERT INTO watch_event (watcher_id, event_id, type, ts, ts_end, modem, dial_hz, kind, from_call, to_crc, caller_crc,
                                called_crc, snr_db, accepted, hint, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (watcher_id, event_id) DO NOTHING`,
      [w.id, e.id, e.type, "ts" in e ? e.ts : e.start, e.type === "coverage" ? e.end : a?.end ?? null,
       f?.modem ?? a?.modem ?? null, f?.dialHz ?? a?.dialHz ?? null, f?.kind ?? null, f?.from ?? a?.from ?? null,
       f?.toCrc ?? null, f?.callerCrc ?? a?.callerCrc ?? null, f?.calledCrc ?? a?.calledCrc ?? null,
       f?.snrDb ?? a?.bestSnrDb ?? null, a ? a.accepted : null, JSON.stringify(f?.hint ?? a?.hint ?? null), JSON.stringify(e)],
    );
    if (r.rowCount) accepted++;
    else duplicate++;
    if (e.type === "status" && (!lastStatus || e.ts > lastStatus.ts)) lastStatus = e;
  }
  await q(`UPDATE watcher SET last_seen_at = now(), last_status = COALESCE($2, last_status) WHERE id = $1`, [
    w.id, lastStatus ? JSON.stringify(lastStatus) : null,
  ]);
  if (accepted) {
    invalidateSightings();
    notifyNewEvents();
  }
  return c.json({ accepted, duplicate, rejected });
});

/**
 * GET /api/v1/watch/callsigns: every listed gateway callsign with its Mercury CRC16 and the
 * dial frequency of every listed Mercury channel, for naming on the watcher (feed.md §3).
 * CRCs collide; the client narrows by frequency.
 */
watchRoutes.get("/callsigns", async (c) => {
  const list = (await publicDirectory()).map((g) => ({
    callsign: g.callsign,
    crc: crcHex(g.callsign),
    gatewayId: g.id,
    source: g.source,
    modems: [...new Set(g.channels.map((ch) => ch.modem))],
    dialHz: g.channels.filter((ch) => ch.modem === "mercury").map((ch) => ch.frequencyHz - 1500),
  }));
  const body = JSON.stringify(list);
  const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
  const headers = { ETag: etag, "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(body, { status: 200, headers });
});

/**
 * GET /api/v1/watch/sightings: derived per-station sightings (feed.md §4). No client
 * callsigns here, only a count. Filters: days (max 90), gateway, band, confidence,
 * resolution (unique|ambiguous|unknown), heard=true.
 */
watchRoutes.get("/sightings", async (c) => {
  const p = c.req.query();
  const days = Math.min(Math.max(Number(p.days ?? 30) || 30, 1), SIGHTING_DAYS);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  let list = (await loadSightings()).filter((s) => s.lastHeard >= since);
  if (p.gateway) list = list.filter((s) => s.gatewayId === p.gateway || s.candidates.some((x) => x.gatewayId === p.gateway));
  if (p.band) list = list.filter((s) => s.band === p.band);
  if (p.confidence) list = list.filter((s) => s.confidence === p.confidence);
  if (p.resolution) list = list.filter((s) => s.resolution === p.resolution);
  if (p.heard === "true") list = list.filter((s) => s.heard);
  return c.json({ days, total: list.length, sightings: list.slice(0, 2000) }, 200, { "Access-Control-Allow-Origin": "*" });
});

/** GET /api/v1/watch/contributors?days=7 (feed.md §7). */
watchRoutes.get("/contributors", async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 7) || 7, 1), 90);
  return c.json(await contributors(days), 200, { "Access-Control-Allow-Origin": "*" });
});

// ── Phase C: events API and live stream ─────────────────────────────────────────────────

async function viewerCanSeeClients(c: Context): Promise<boolean> {
  const v = await optionalViewer(c);
  return !!v && can(v.role, { watcher: ["view-clients"] });
}

interface Filters { band?: string; modem?: string; gateway?: string }
const filtersOf = (p: Record<string, string | undefined>): Filters => ({ band: p.band, modem: p.modem, gateway: p.gateway });
type Projected = Awaited<ReturnType<typeof projector>> extends (r: EventRow) => infer R ? R : never;
const keep = (e: Projected, f: Filters) =>
  (!f.band || e.band === f.band) && (!f.modem || e.modem === f.modem) &&
  (!f.gateway || e.station?.gatewayId === f.gateway || !!e.station?.candidates.some((x) => x.gatewayId === f.gateway));

/** GET /api/v1/watch/events?since=<iso>|after=<id>&limit=: public projection, newest first unless `after`. */
watchRoutes.get("/events", async (c) => {
  const p = c.req.query();
  const limit = Math.min(Math.max(Number(p.limit ?? 100) || 100, 1), 1000);
  const params: unknown[] = [];
  let where = "";
  if (p.after) { params.push(Number(p.after)); where += ` AND e.id > $${params.length}`; }
  if (p.since) { params.push(new Date(p.since)); where += ` AND e.ts >= $${params.length}`; }
  if (p.before) { params.push(Number(p.before)); where += ` AND e.id < $${params.length}`; }
  const order = p.after ? "ASC" : "DESC";
  const { rows } = await q<EventRow>(`${EVENT_SELECT}${where} ORDER BY e.id ${order} LIMIT ${limit * 3}`, params);
  const project = await projector(await viewerCanSeeClients(c));
  const f = filtersOf(p);
  const events = rows.map(project).filter((e) => keep(e, f)).slice(0, limit);
  return c.json({ events, next: events.length ? events[events.length - 1]!.id : null }, 200, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
});

/**
 * GET /api/v1/watch/stream: Server-Sent Events, `event: frame` per projected event.
 * Resumes from Last-Event-ID (or ?lastEventId=) within the last 15 minutes. Filters as /events.
 */
watchRoutes.get("/stream", async (c) => {
  const f = filtersOf(c.req.query());
  const canSee = await viewerCanSeeClients(c);
  const resumeRaw = c.req.header("last-event-id") ?? c.req.query("lastEventId");
  c.header("Access-Control-Allow-Origin", "*");
  c.header("X-Accel-Buffering", "no"); // tell nginx-style proxies not to buffer
  return streamSSE(c, async (stream) => {
    let lastId = 0;
    if (resumeRaw && /^\d+$/.test(resumeRaw)) {
      lastId = Number(resumeRaw);
    } else {
      const { rows } = await q<{ max: number | null }>(`SELECT max(id)::bigint AS max FROM watch_event`);
      lastId = Number(rows[0]?.max ?? 0);
    }
    const fifteen = new Date(Date.now() - 15 * 60_000);
    let busy = false, pending = false;
    const flush = async () => {
      if (busy) { pending = true; return; }
      busy = true;
      try {
        do {
          pending = false;
          const { rows } = await q<EventRow>(`${EVENT_SELECT} AND e.id > $1 AND e.received_at >= $2 ORDER BY e.id ASC LIMIT 500`, [lastId, fifteen]);
          if (!rows.length) break;
          const project = await projector(canSee);
          for (const r of rows) {
            lastId = r.id;
            const e = project(r);
            if (keep(e, f)) await stream.writeSSE({ event: "frame", id: String(r.id), data: JSON.stringify(e) });
          }
          if (rows.length === 500) pending = true;
        } while (pending);
      } finally {
        busy = false;
      }
    };
    await stream.writeSSE({ event: "hello", data: JSON.stringify({ resumeFrom: lastId, clientsVisible: canSee }) });
    await flush();
    const off = onNewEvents(() => void flush());
    const ping = setInterval(() => void stream.write(": ping\n\n"), 25_000);
    stream.onAbort(() => { off(); clearInterval(ping); });
    while (!stream.aborted) await stream.sleep(60_000);
    off();
    clearInterval(ping);
  });
});

/**
 * POST /api/v1/watch/link (identity.md §5): the watcher, holding a device-flow access token
 * for this Directory (aud = DIRECTORY_AUDIENCE), picks one of the account's watchers or names a
 * new one, and receives that watcher's ormsw_ key. The watcher then discards the token.
 * Body: { watcherId } | { name, gridsquare?, locationPrecision? }. List choices with GET /api/v1/me/watchers.
 */
const linkInput = z.union([
  z.object({ watcherId: z.uuid() }),
  z.object({
    name: z.string().trim().min(1).max(60),
    gridsquare: z.string().trim().refine(isValidGrid, "invalid Maidenhead locator").nullish(),
    locationPrecision: z.enum(["grid4", "grid6", "hidden"]).default("grid4"),
  }),
]);

watchRoutes.post("/link", requireViewer, async (c) => {
  const sub = c.get("viewer").sub;
  const p = linkInput.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "send { watcherId } or { name, gridsquare? }", issues: p.error.issues }, 400);
  let w;
  if ("watcherId" in p.data) {
    w = await ownWatcher(p.data.watcherId, sub);
    if (!w) return c.json({ error: "watcher not found" }, 404);
  } else {
    const created = await createWatcher(sub, { ...p.data, public: true });
    w = await ownWatcher(created.id, sub);
  }
  if (w.disabled) return c.json({ error: "this watcher was disabled by a moderator" }, 403);
  return c.json({ key: await mintWatcherKey(w), watcherId: w.id, name: w.name });
});
