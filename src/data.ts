// Loads the directory into a normalized view: gateways with channels,
// computed status, and de-duplication between sources.
import { q } from "./db/pool.js";
import { env } from "./env.js";
import { bandOf, getModem, type ModemId } from "./modes.js";
import { gridToLatLon } from "./lib/callsign.js";
import { feedServiceCodes } from "./compat/winlink-status.js";

export type Source = "openrms" | "winlink";
export type Status = "online" | "listed" | "stale" | "offline";

export interface ChannelView {
  id: string;
  frequencyHz: number;
  band: string | null;
  modem: ModemId;
  modemLabel: string;
  variant: string | null;
  modemVersion: string | null;
  /** Stored main code. Public output replaces it with serviceCodes[0] (see publicDirectory). */
  serviceCode: string;
  /** Stored extra codes. Never in public output. */
  extraServiceCodes: string[];
  /** Set by publicDirectory: the codes this channel is published under that the request may see. */
  serviceCodes?: string[];
  operatingHours: string;
  antenna: string;
  radioRange: string;
  gridsquare: string | null;
  baud: string;
  notes: string;
  winlinkSupportedModes: string | null;
  winlinkMode: number | null;
  compatSupportedModes: string | null;
}

export interface GatewayView {
  id: string;
  source: Source;
  callsign: string;
  baseCallsign: string;
  ownerUserId: string | null;
  /** For a club gateway: the club's verification; otherwise the owner account's. */
  ownerVerified: boolean;
  /** Set when the gateway is listed or claimed under a club callsign. */
  club: { callsign: string; name: string; verified: boolean } | null;
  latitude: number | null;
  longitude: number | null;
  gridsquare: string | null;
  locationPrecision: "exact" | "grid6" | "grid4";
  /** Winlink-sourced: the comment from the Winlink list. openrms: the sysop's comment. */
  comments: string;
  /** Added by the sysop who claimed a Winlink listing (empty otherwise). */
  ownerComments: string;
  /** A Winlink listing claimed by the account holding its callsign. */
  claimed: boolean;
  claimedAt: string | null;
  software: string | null;
  winlinkListed: boolean;
  /** Another source lists the same callsign. */
  alsoListedBy: Source[];
  /**
   * An unverified owner listing whose callsign is also on the Winlink list. Both are shown;
   * the Winlink row stays authoritative in the compat feed until the owner is verified.
   */
  unverifiedConflict: boolean;
  emcomm: Record<string, unknown>;
  live: Record<string, unknown>;
  hidden: boolean;
  lastHeartbeatAt: string | null;
  confirmedAt: string | null;
  lastSeenAt: string | null;
  status: Status;
  createdAt: string;
  updatedAt: string;
  channels: ChannelView[];
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

export function computeStatus(
  g: { source: Source; last_heartbeat_at: Date | null; confirmed_at: Date | null; winlink_last_status: Date | null },
  now = Date.now(),
): { status: Status; lastSeen: Date | null } {
  const hours = (d: Date | null) => (d ? (now - d.getTime()) / 3.6e6 : Infinity);
  if (g.source === "winlink") {
    const h = hours(g.winlink_last_status);
    return { status: h <= env.STALE_AFTER_HOURS ? "online" : h <= 48 ? "stale" : "offline", lastSeen: g.winlink_last_status };
  }
  const hb = hours(g.last_heartbeat_at);
  if (hb <= env.STALE_AFTER_HOURS) return { status: "online", lastSeen: g.last_heartbeat_at };
  const conf = hours(g.confirmed_at);
  const lastSeen = [g.last_heartbeat_at, g.confirmed_at].filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0] ?? null;
  if (conf <= env.CONFIRMED_LISTING_DAYS * 24) return { status: g.last_heartbeat_at ? "stale" : "listed", lastSeen };
  if (hb <= 48) return { status: "stale", lastSeen };
  return { status: "offline", lastSeen };
}

/** Coarsen location to what the owner chose to publish. */
function publicLocation(r: any): { lat: number | null; lon: number | null; grid: string | null } {
  const grid: string | null = r.gridsquare;
  if (r.location_precision === "exact" || r.source === "winlink") return { lat: r.latitude, lon: r.longitude, grid };
  const len = r.location_precision === "grid4" ? 4 : 6;
  const g = grid ? grid.slice(0, len) : null;
  const c = g ? gridToLatLon(g) : null;
  return { lat: c?.lat ?? null, lon: c?.lon ?? null, grid: g };
}

let cache: { at: number; all: GatewayView[] } | null = null;
let codeCache: { at: number; codes: Map<string, { visibility: string; description: string }> } | null = null;
const CACHE_MS = 30_000;

export function invalidateDirectory() {
  cache = null;
  codeCache = null;
}

/** All gateways (including hidden ones), de-duplicated. Callers filter for public use. */
export async function loadDirectory(): Promise<GatewayView[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.all;
  const [gws, chs] = await Promise.all([
    q(`SELECT g.*,
              CASE WHEN g.owner_club_id IS NOT NULL THEN COALESCE(o.verified, false)
                   ELSE COALESCE(u.callsign_verified, false) END AS owner_verified,
              o.callsign AS club_callsign, o.name AS club_name
         FROM gateway g
         LEFT JOIN account_cache u ON u.sub = g.owner_sub
         LEFT JOIN account_club o ON o.id = g.owner_club_id
        WHERE g.removed_at IS NULL ${env.WINLINK_PUBLISH ? "" : "AND g.source = 'openrms'"}`),
    q(`SELECT c.* FROM channel c JOIN gateway g ON g.id = c.gateway_id WHERE g.removed_at IS NULL ORDER BY c.frequency_hz`),
  ]);
  const byGw = new Map<string, ChannelView[]>();
  for (const c of chs.rows) {
    const list = byGw.get(c.gateway_id) ?? [];
    list.push({
      id: c.id,
      frequencyHz: c.frequency_hz,
      band: bandOf(c.frequency_hz),
      modem: c.modem,
      modemLabel: getModem(c.modem)?.label ?? c.modem,
      variant: c.variant,
      modemVersion: c.modem_version,
      serviceCode: c.service_code,
      extraServiceCodes: c.extra_service_codes ?? [],
      operatingHours: c.operating_hours,
      antenna: c.antenna,
      radioRange: c.radio_range,
      gridsquare: c.gridsquare,
      baud: c.baud,
      notes: c.notes,
      winlinkSupportedModes: c.winlink_supported_modes,
      winlinkMode: c.winlink_mode,
      compatSupportedModes: c.compat_supported_modes,
    });
    byGw.set(c.gateway_id, list);
  }
  const now = Date.now();
  const views: GatewayView[] = gws.rows.map((r) => {
    const { status, lastSeen } = computeStatus(r, now);
    const loc = publicLocation(r);
    // Details on a Winlink row only count while someone holds the claim.
    const claimed = r.source === "winlink" && (r.owner_sub != null || r.owner_club_id != null);
    const ownerData = r.source === "openrms" || claimed;
    return {
      id: r.id,
      source: r.source,
      callsign: r.callsign,
      baseCallsign: r.base_callsign,
      ownerUserId: r.owner_sub,
      ownerVerified: r.owner_verified,
      club: r.club_callsign ? { callsign: r.club_callsign, name: r.club_name, verified: r.owner_verified } : null,
      latitude: loc.lat,
      longitude: loc.lon,
      gridsquare: loc.grid,
      locationPrecision: r.location_precision,
      comments: r.comments,
      ownerComments: claimed ? r.owner_comments : "",
      claimed,
      claimedAt: claimed ? iso(r.claimed_at) : null,
      software: ownerData ? r.software : null,
      winlinkListed: r.winlink_listed,
      alsoListedBy: [],
      unverifiedConflict: false,
      emcomm: ownerData ? r.emcomm : {},
      live: r.live,
      hidden: r.hidden,
      lastHeartbeatAt: iso(r.last_heartbeat_at),
      confirmedAt: iso(r.confirmed_at),
      lastSeenAt: iso(lastSeen),
      status,
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
      channels: byGw.get(r.id) ?? [],
    };
  });

  // De-duplicate. A listing by a *verified* owner replaces the Winlink copy of the
  // same callsign. An unverified one never does: anyone can sign up with an unclaimed
  // callsign, so it is shown alongside the Winlink row and kept out of the compat feed.
  const openrmsCalls = new Map(views.filter((v) => v.source === "openrms" && !v.hidden).map((v) => [v.callsign, v]));
  const all: GatewayView[] = [];
  for (const v of views) {
    const own = v.source === "winlink" ? openrmsCalls.get(v.callsign) : undefined;
    if (own) {
      own.alsoListedBy.push("winlink");
      if (own.ownerVerified) {
        own.winlinkListed = true;
        continue;
      }
      own.unverifiedConflict = true;
      v.alsoListedBy.push("openrms");
    }
    all.push(v);
  }
  all.sort((a, b) => a.callsign.localeCompare(b.callsign));
  cache = { at: Date.now(), all };
  return all;
}

/** Every known service code with its visibility. Staff and internal use only. */
export async function serviceCodeTable(): Promise<Map<string, { visibility: string; description: string }>> {
  if (codeCache && Date.now() - codeCache.at < CACHE_MS) return codeCache.codes;
  const { rows } = await q<{ code: string; visibility: string; description: string }>(`SELECT code, visibility, description FROM service_code`);
  const codes = new Map(rows.map((r) => [r.code, { visibility: r.visibility, description: r.description }]));
  codeCache = { at: Date.now(), codes };
  return codes;
}

export async function publicServiceCodes(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const [code, v] of await serviceCodeTable()) if (v.visibility === "public") out.add(code);
  return out;
}

/** Normalise a ?serviceCode= value (comma or space separated) to a set of uppercase codes. */
export function parseCodes(v: string | string[] | undefined): Set<string> {
  return new Set([v ?? []].flat().flatMap((s) => s.split(/[,\s]+/)).map((s) => s.trim().toUpperCase()).filter(Boolean));
}

/**
 * Gateways as the public may see them. A channel shows only the codes that are public or that
 * this request named exactly (`requested`); a channel with none left is dropped, and so is a
 * gateway left with no channels. Unlisted codes are therefore never enumerated: they only
 * match an exact request. Each channel carries `serviceCodes` (its visible codes).
 */
export async function publicDirectory(requested: Set<string> = new Set()): Promise<GatewayView[]> {
  const [all, pub] = await Promise.all([loadDirectory(), publicServiceCodes()]);
  return projectPublic(all, pub, requested);
}

/** The visibility rule behind publicDirectory, without the database. */
export function projectPublic(all: GatewayView[], pub: Set<string>, requested: Set<string> = new Set()): GatewayView[] {
  const out: GatewayView[] = [];
  for (const g of all) {
    if (g.hidden) continue;
    const channels: ChannelView[] = [];
    for (const ch of g.channels) {
      const visible = feedServiceCodes(g, ch).filter((c) => pub.has(c) || requested.has(c));
      if (visible.length) channels.push({ ...ch, serviceCodes: visible });
    }
    if (channels.length === 0 && g.channels.length > 0) continue;
    out.push({ ...g, channels });
  }
  return out;
}
