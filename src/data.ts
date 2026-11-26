// Loads the directory into a normalized view: gateways with channels,
// computed status, and de-duplication between sources.
import { q } from "./db/pool.js";
import { env } from "./env.js";
import { bandOf, getModem, type ModemId } from "./modes.js";
import { gridToLatLon } from "./lib/callsign.js";

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
  serviceCode: string;
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
const CACHE_MS = 30_000;

export function invalidateDirectory() {
  cache = null;
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

export async function publicDirectory(): Promise<GatewayView[]> {
  return (await loadDirectory()).filter((g) => !g.hidden);
}
