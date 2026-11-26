// Public projection of watcher events (feed.md §5–6), used by the events API and the live stream.
//
// Client callsigns (stations connecting to a gateway) are stored but shown publicly only when
// the site setting publish_client_callsigns is on, and never for callsigns on the opt-out list.
// Staff whose role has watcher:view-clients always see them. Gateway (station) names come from
// public listings and are always shown.
import { q } from "../db/pool.js";
import { loadDirectory } from "../data.js";
import { bandOf } from "../modes.js";
import { crcHex } from "../lib/crc.js";
import { crcIndex, resolve } from "./sightings.js";

export interface EventRow {
  id: number; type: string; kind: string | null; ts: Date; ts_end: Date | null; modem: string | null; dial_hz: number | null;
  from_call: string | null; to_crc: string | null; caller_crc: string | null; called_crc: string | null; snr_db: number | null;
  accepted: boolean | null; watcher_id: string; watcher_name: string; watcher_grid: string | null; watcher_precision: string;
  watcher_public: boolean;
}

export const EVENT_SELECT = `
  SELECT e.id, e.type, e.kind, e.ts, e.ts_end, e.modem, e.dial_hz, e.from_call, e.to_crc, e.caller_crc, e.called_crc, e.snr_db,
         e.accepted, e.watcher_id, w.name AS watcher_name, w.gridsquare AS watcher_grid, w.location_precision AS watcher_precision,
         w.public AS watcher_public
    FROM watch_event e JOIN watcher w ON w.id = e.watcher_id
   WHERE e.type IN ('frame', 'attempt') AND NOT w.disabled`;

interface Policy { publish: boolean; optouts: Set<string> }
let policyCache: { at: number; p: Policy } | null = null;
let idxCache: { dir: unknown; idx: ReturnType<typeof crcIndex> } | null = null;

export function invalidatePolicy() {
  policyCache = null;
}

async function policy(): Promise<Policy> {
  if (policyCache && Date.now() - policyCache.at < 30_000) return policyCache.p;
  const [s, o] = await Promise.all([
    q<{ value: unknown }>(`SELECT value FROM site_setting WHERE key = 'publish_client_callsigns'`),
    q<{ callsign: string }>(`SELECT callsign FROM callsign_optout`),
  ]);
  const p = { publish: s.rows[0]?.value === true, optouts: new Set(o.rows.map((r) => r.callsign)) };
  policyCache = { at: Date.now(), p };
  return p;
}

/** Rebuilt whenever the directory cache is (any listing change invalidates it). */
async function index() {
  const dir = await loadDirectory();
  if (idxCache?.dir === dir) return idxCache.idx;
  const idx = crcIndex(dir.filter((g) => !g.hidden));
  idxCache = { dir, idx };
  return idx;
}

/** Strip an SSID or portable suffix so an opt-out of W1ABC also covers W1ABC-7 and W1ABC/P. */
const baseOf = (c: string) => c.split(/[-/]/)[0]!;

export async function projector(viewerCanSeeClients: boolean) {
  const [p, idx] = await Promise.all([policy(), index()]);
  const showClients = viewerCanSeeClients || p.publish;
  const optedOut = (c: string) => p.optouts.has(c) || p.optouts.has(baseOf(c));
  return (r: EventRow) => {
    const isCq = r.kind === "CQ";
    const stationCrc = r.type === "attempt" ? r.called_crc : r.kind === "ACCEPT" ? r.called_crc : r.kind === "CALL" ? r.to_crc
      : isCq && r.from_call ? crcHex(r.from_call) : null;
    const dial = r.dial_hz ?? 0;
    const station = stationCrc
      ? { crc: stationCrc, ...resolve(stationCrc, dial, new Set(isCq && r.from_call ? [r.from_call] : []), idx) }
      : null;
    // A CQ's callsign is the station's own; anything else in `from` is a client.
    let client: string | null = null;
    if (!isCq && r.from_call) {
      client = viewerCanSeeClients ? r.from_call : showClients && !optedOut(r.from_call) ? r.from_call : "a client";
    } else if (!isCq && (r.caller_crc || r.kind === "ACCEPT")) client = viewerCanSeeClients && r.caller_crc ? `CRC ${r.caller_crc}` : "a client";
    if (station && !viewerCanSeeClients && station.callsign && station.resolution === "unknown" && optedOut(station.callsign)) {
      station.callsign = null; // an unlisted station heard in clear that opted out
    }
    const grid = r.watcher_precision === "hidden" || !r.watcher_grid ? null : r.watcher_grid.slice(0, r.watcher_precision === "grid6" ? 6 : 4);
    return {
      id: r.id,
      type: r.type,
      kind: r.kind ?? (r.type === "attempt" ? (r.accepted ? "ATTEMPT_ACCEPTED" : "ATTEMPT") : null),
      ts: r.ts.toISOString(),
      end: r.ts_end?.toISOString() ?? null,
      modem: r.modem,
      dialHz: r.dial_hz,
      band: r.dial_hz ? bandOf(r.dial_hz + 1500) : null,
      snrDb: r.snr_db,
      station,
      client,
      watcher: r.watcher_public ? { name: r.watcher_name, gridsquare: grid } : { name: "anonymous", gridsquare: null },
    };
  };
}

export type ProjectedEvent = ReturnType<Awaited<ReturnType<typeof projector>>>;
