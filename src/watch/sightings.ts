// Phase B: derive sightings from watcher uploads (openRMS-Spec/watch/feed.md §4).
//
// A sighting is one station (identified on the air by its CRC16) on one frequency.
// It is computed from raw events on every refresh, so re-resolution against the current
// listings is automatic: list a gateway and its past sightings match it.
//
// "heard": the station itself transmitted (ACCEPT, or CQ). "called": only a CALL to it.
// "confirmed": heard by watchers of two or more different callsign-verified accounts
// within 10 minutes of each other. Watcher hints are never used for any of this.
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { loadDirectory, type GatewayView } from "../data.js";
import { bandOf } from "../modes.js";
import { crcHex } from "../lib/crc.js";

const { watchEvent, watcher } = schema;

export const SIGHTING_DAYS = 90;
const BUCKET_HZ = 80; // frames within ±80 Hz are the same channel
const MATCH_HZ = 200; // a listed Mercury channel within ±200 Hz of the dial names it
const CONFIRM_MS = 10 * 60_000;

export interface Candidate { callsign: string; gatewayId: string }

export interface Sighting {
  id: string; // stable for a (crc, dial bucket)
  crc: string;
  dialHz: number;
  band: string | null;
  heard: boolean;
  firstHeard: string;
  lastHeard: string;
  frames: number;
  watchers: number;
  verifiedWatchers: number;
  confidence: "single" | "confirmed" | "called";
  bestSnrDb: number | null;
  clients: number; // distinct clients seen calling it; never named here
  resolution: "unique" | "ambiguous" | "unknown";
  gatewayId: string | null;
  callsign: string | null;
  candidates: Candidate[];
}

export interface Obs {
  crc: string; dial: number; ts: number; heard: boolean; watcherId: string; userId: string; verified: boolean;
  snr: number | null; client: string | null; heardCall: string | null;
}

/** Turn raw events into per-station observations. */
function observations(rows: {
  type: string; kind: string | null; dialHz: number | null; ts: Date; fromCall: string | null; toCrc: string | null;
  callerCrc: string | null; calledCrc: string | null; snrDb: number | null; accepted: boolean | null; watcherId: string;
  userId: string; verified: boolean;
}[]): Obs[] {
  const out: Obs[] = [];
  for (const r of rows) {
    if (r.dialHz == null) continue;
    const base = { dial: r.dialHz, ts: r.ts.getTime(), watcherId: r.watcherId, userId: r.userId, verified: r.verified, snr: r.snrDb };
    if (r.type === "frame") {
      if (r.kind === "ACCEPT" && r.calledCrc) out.push({ ...base, crc: r.calledCrc, heard: true, client: r.callerCrc, heardCall: null });
      else if (r.kind === "CQ" && r.fromCall) out.push({ ...base, crc: crcHex(r.fromCall), heard: true, client: null, heardCall: r.fromCall });
      else if (r.kind === "CALL" && r.toCrc) out.push({ ...base, crc: r.toCrc, heard: false, client: r.fromCall ? crcHex(r.fromCall) : null, heardCall: null });
    } else if (r.type === "attempt" && r.calledCrc) {
      out.push({ ...base, crc: r.calledCrc, heard: !!r.accepted, client: r.callerCrc ?? (r.fromCall ? crcHex(r.fromCall) : null), heardCall: null });
    }
  }
  return out;
}

/** CRC → listed callsigns, with each gateway's Mercury dial frequencies. */
export function crcIndex(gws: GatewayView[]) {
  const idx = new Map<string, { g: GatewayView; dials: number[] }[]>();
  for (const g of gws) {
    const k = crcHex(g.callsign);
    const list = idx.get(k) ?? [];
    list.push({ g, dials: g.channels.filter((c) => c.modem === "mercury").map((c) => c.frequencyHz - 1500) });
    idx.set(k, list);
  }
  return idx;
}

/** Resolve a CRC heard on a dial frequency to listed gateways (feed.md §3 rules). */
export function resolve(
  crc: string, dial: number, heardCalls: Set<string>, idx: ReturnType<typeof crcIndex>,
): Pick<Sighting, "resolution" | "gatewayId" | "callsign" | "candidates"> {
  let cands = idx.get(crc) ?? [];
  // A callsign heard in clear (CQ) with this CRC wins outright.
  const clear = cands.filter((c) => heardCalls.has(c.g.callsign));
  if (clear.length) cands = clear;
  else {
    const near = cands.filter((c) => c.dials.some((d) => Math.abs(d - dial) <= MATCH_HZ));
    if (near.length) cands = near;
    else {
      const merc = cands.filter((c) => c.dials.length > 0);
      if (merc.length) cands = merc;
    }
  }
  const candidates = cands.map((c) => ({ callsign: c.g.callsign, gatewayId: c.g.id }));
  if (candidates.length === 1) return { resolution: "unique", gatewayId: candidates[0]!.gatewayId, callsign: candidates[0]!.callsign, candidates };
  if (candidates.length === 0) {
    const heard = [...heardCalls].find((c) => crcHex(c) === crc) ?? null; // unlisted, but its callsign was heard in clear
    return { resolution: "unknown", gatewayId: null, callsign: heard, candidates };
  }
  return { resolution: "ambiguous", gatewayId: null, callsign: null, candidates };
}

function confirmed(obs: Obs[]): boolean {
  const v = obs.filter((o) => o.heard && o.verified).sort((a, b) => a.ts - b.ts);
  for (let i = 0; i < v.length; i++)
    for (let j = i + 1; j < v.length && v[j]!.ts - v[i]!.ts <= CONFIRM_MS; j++) if (v[j]!.userId !== v[i]!.userId) return true;
  return false;
}

/** Group observations into sightings: by CRC, then into ±80 Hz frequency clusters. */
export function buildSightings(obs: Obs[], gws: GatewayView[]): Sighting[] {
  const idx = crcIndex(gws);
  const byCrc = new Map<string, Obs[]>();
  for (const o of obs) (byCrc.get(o.crc) ?? byCrc.set(o.crc, []).get(o.crc)!).push(o);
  const out: Sighting[] = [];
  for (const [crc, list] of byCrc) {
    list.sort((a, b) => a.dial - b.dial);
    const clusters: Obs[][] = [];
    for (const o of list) {
      const last = clusters.at(-1);
      const centre = last ? last.reduce((s, x) => s + x.dial, 0) / last.length : 0;
      if (last && Math.abs(o.dial - centre) <= BUCKET_HZ) last.push(o);
      else clusters.push([o]);
    }
    for (const c of clusters) {
      const dial = Math.round(c.reduce((s, x) => s + x.dial, 0) / c.length / 10) * 10;
      const heard = c.some((o) => o.heard);
      const heardCalls = new Set(c.map((o) => o.heardCall).filter((x): x is string => !!x));
      const ts = c.map((o) => o.ts);
      const snrs = c.map((o) => o.snr).filter((x): x is number => x != null);
      const watchers = new Set(c.map((o) => o.watcherId));
      const verifiedWatchers = new Set(c.filter((o) => o.verified).map((o) => o.watcherId));
      out.push({
        id: `${crc}-${dial}`,
        crc,
        dialHz: dial,
        band: bandOf(dial + 1500),
        heard,
        firstHeard: new Date(Math.min(...ts)).toISOString(),
        lastHeard: new Date(Math.max(...ts)).toISOString(),
        frames: c.length,
        watchers: watchers.size,
        verifiedWatchers: verifiedWatchers.size,
        confidence: !heard ? "called" : confirmed(c) ? "confirmed" : "single",
        bestSnrDb: snrs.length ? Math.max(...snrs) : null,
        clients: new Set(c.map((o) => o.client).filter(Boolean)).size,
        ...resolve(crc, dial, heardCalls, idx),
      });
    }
  }
  return out.sort((a, b) => b.lastHeard.localeCompare(a.lastHeard));
}

let cache: { at: number; dir: unknown; sightings: Sighting[] } | null = null;
const CACHE_MS = 60_000;

export function invalidateSightings() {
  cache = null;
}

export async function loadSightings(): Promise<Sighting[]> {
  const dir = await loadDirectory();
  // Recompute after new uploads (invalidateSightings), a listing change (new directory
  // snapshot), or at most once a minute.
  if (cache && cache.dir === dir && Date.now() - cache.at < CACHE_MS) return cache.sightings;
  const since = new Date(Date.now() - SIGHTING_DAYS * 86400_000);
  const rows = await db
    .select({
      type: watchEvent.type, kind: watchEvent.kind, dialHz: watchEvent.dialHz, ts: watchEvent.ts, fromCall: watchEvent.fromCall,
      toCrc: watchEvent.toCrc, callerCrc: watchEvent.callerCrc, calledCrc: watchEvent.calledCrc, snrDb: watchEvent.snrDb,
      accepted: watchEvent.accepted, watcherId: watchEvent.watcherId, userId: sql<string>`${watcher.ownerSub}`,
      verified: sql<boolean>`COALESCE((SELECT a.callsign_verified FROM account_cache a WHERE a.sub = ${watcher.ownerSub}), false)`,
    })
    .from(watchEvent)
    .innerJoin(watcher, eq(watcher.id, watchEvent.watcherId))
    .where(and(inArray(watchEvent.type, ["frame", "attempt"]), gte(watchEvent.ts, since), eq(watcher.disabled, false)));
  const sightings = buildSightings(observations(rows), dir.filter((g) => !g.hidden));
  cache = { at: Date.now(), dir, sightings };
  return sightings;
}

export interface HeardOnAir {
  lastHeard: string; dialHz: number; watchers: number; confidence: "single" | "confirmed"; sightings: number;
}

/** Per gateway: the strongest evidence it was heard (feed.md §4). Never edits a listing. */
export async function heardOnAirByGateway(): Promise<Map<string, HeardOnAir>> {
  const out = new Map<string, HeardOnAir>();
  for (const s of await loadSightings()) {
    if (!s.heard || !s.gatewayId) continue;
    const prev = out.get(s.gatewayId);
    const conf = s.confidence === "confirmed" ? "confirmed" : "single";
    if (!prev) {
      out.set(s.gatewayId, { lastHeard: s.lastHeard, dialHz: s.dialHz, watchers: s.watchers, confidence: conf, sightings: 1 });
    } else {
      prev.sightings++;
      if (s.lastHeard > prev.lastHeard) Object.assign(prev, { lastHeard: s.lastHeard, dialHz: s.dialHz });
      prev.watchers = Math.max(prev.watchers, s.watchers);
      if (conf === "confirmed") prev.confidence = "confirmed";
    }
  }
  return out;
}
