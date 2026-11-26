// Public read API: no auth. Everything the Site shows comes from here.
import { Hono, type Context } from "hono";
import { parseCodes, publicDirectory, publicServiceCodes, serviceCodeTable, type GatewayView } from "../data.js";
import { MODEMS, bandOf } from "../modes.js";
import { gridToLatLon, haversineKm } from "../lib/callsign.js";
import { feedServiceCodes } from "../compat/winlink-status.js";
import { limitUnlisted, nonPublic, recordMiss } from "../lib/codelimit.js";
import { heardOnAirByGateway, type HeardOnAir } from "../watch/sightings.js";

export const publicRoutes = new Hono();

/** Strip fields that are not public. */
export function publicGateway(g: GatewayView, distanceKm?: number, heard?: Map<string, HeardOnAir>) {
  const { ownerUserId, hidden, ...rest } = g;
  return {
    ...rest,
    // Only the codes publicDirectory left visible; stored codes (which may be unlisted) never go out.
    channels: rest.channels.map(({ extraServiceCodes, serviceCodes, ...ch }) => {
      const codes = serviceCodes ?? [];
      return { ...ch, serviceCodes: codes, serviceCode: codes[0] ?? "", feedServiceCode: codes[0] ?? "" };
    }),
    // Independent on-air evidence from watchers; separate from status, never edits the listing.
    heardOnAir: heard?.get(g.id) ?? null,
    ...(distanceKm !== undefined ? { distanceKm: Math.round(distanceKm) } : {}),
  };
}

export function filterGateways(all: GatewayView[], p: Record<string, string | undefined>) {
  const modems = p.modem?.split(",").filter(Boolean);
  const bands = p.band?.split(",").filter(Boolean);
  const codes = p.serviceCode ? [...parseCodes(p.serviceCode)] : undefined;
  const statuses = p.status?.split(",").filter(Boolean);
  const claimedOnly = p.claimed === "true";
  const qstr = p.q?.trim().toUpperCase();
  let origin: { lat: number; lon: number } | null = null;
  if (p.grid) origin = gridToLatLon(p.grid);
  else if (p.lat && p.lon) origin = { lat: Number(p.lat), lon: Number(p.lon) };
  const radius = p.radiusKm ? Number(p.radiusKm) : undefined;

  const out: { g: GatewayView; d?: number }[] = [];
  for (const g of all) {
    if (p.source && g.source !== p.source) continue;
    if (claimedOnly && !(g.claimed || g.source === "openrms")) continue;
    if (statuses && !statuses.includes(g.status)) continue;
    if (qstr && !g.callsign.includes(qstr) && !`${g.comments} ${g.ownerComments}`.toUpperCase().includes(qstr)) continue;
    let channels = g.channels;
    if (modems) channels = channels.filter((c) => modems.includes(c.modem));
    if (bands) channels = channels.filter((c) => c.band && bands.includes(c.band));
    // Matches the codes Pat sees, so a Mercury channel typed as PUBLIC counts as MERCURY.
    if (codes) channels = channels.filter((c) => (c.serviceCodes ?? feedServiceCodes(g, c)).some((x) => codes.includes(x)));
    if (channels.length === 0) continue;
    let d: number | undefined;
    if (origin && g.latitude != null && g.longitude != null) {
      d = haversineKm(origin, { lat: g.latitude, lon: g.longitude });
      if (radius !== undefined && d > radius) continue;
    } else if (origin && radius !== undefined) continue;
    out.push({ g: { ...g, channels }, d });
  }
  if (origin) out.sort((a, b) => (a.d ?? Infinity) - (b.d ?? Infinity));
  return out;
}

/**
 * The public directory for a request that may name service codes. Naming a code that isn't public
 * is rate-limited per IP, and responses never reveal whether such a code exists.
 */
async function directoryFor(c: Context, raw: string | undefined) {
  const requested = parseCodes(raw);
  const hidden = nonPublic(requested, await publicServiceCodes());
  if (hidden.length) {
    const limited = limitUnlisted(c, hidden);
    if (limited) return { limited } as const;
  }
  return { dir: await publicDirectory(new Set(hidden)), hidden } as const;
}

function noteMisses(c: Context, hidden: string[], gateways: GatewayView[]) {
  if (!hidden.length) return;
  const hit = gateways.some((g) => g.channels.some((ch) => ch.serviceCodes?.some((x) => hidden.includes(x))));
  if (!hit) recordMiss(c, hidden);
  // Answers to non-public codes must not sit in shared caches, where the rate limit can't see them.
  c.header("Cache-Control", "private, no-store");
}

publicRoutes.get("/gateways", async (c) => {
  const p = c.req.query();
  const r = await directoryFor(c, p.serviceCode);
  if ("limited" in r) return r.limited;
  const rows = filterGateways(r.dir, p);
  noteMisses(c, r.hidden, rows.map((x) => x.g));
  const limit = Math.min(Number(p.limit ?? 5000) || 5000, 5000);
  const offset = Number(p.offset ?? 0) || 0;
  const heard = await heardOnAirByGateway();
  return c.json({
    total: rows.length,
    offset,
    limit,
    gateways: rows.slice(offset, offset + limit).map(({ g, d }) => publicGateway(g, d, heard)),
  });
});

publicRoutes.get("/gateways/:id", async (c) => {
  const r = await directoryFor(c, c.req.query("serviceCode"));
  if ("limited" in r) return r.limited;
  const g = r.dir.find((x) => x.id === c.req.param("id") || x.callsign === c.req.param("id").toUpperCase());
  noteMisses(c, r.hidden, g ? [g] : []);
  if (!g) return c.json({ error: "not found" }, 404);
  return c.json(publicGateway(g, undefined, await heardOnAirByGateway()));
});

/** Public service codes only, with how many gateways use each. Unlisted codes are never listed. */
publicRoutes.get("/service-codes", async (c) => {
  const [table, dir] = await Promise.all([serviceCodeTable(), publicDirectory()]);
  const counts: Record<string, number> = {};
  for (const g of dir) for (const sc of new Set(g.channels.flatMap((ch) => ch.serviceCodes ?? []))) counts[sc] = (counts[sc] ?? 0) + 1;
  const codes = [...table]
    .filter(([, v]) => v.visibility === "public")
    .map(([code, v]) => ({ code, description: v.description, gateways: counts[code] ?? 0 }))
    .sort((a, b) => (a.code === "PUBLIC" ? -1 : b.code === "PUBLIC" ? 1 : b.gateways - a.gateways || a.code.localeCompare(b.code)));
  return c.json({ serviceCodes: codes });
});

publicRoutes.get("/modems", (c) =>
  c.json(
    MODEMS.map(({ compat, ...m }) => {
      const rule = compat(m.defaultVariant ?? null);
      return { ...m, compat: rule ? { supportedModes: rule.supportedModes, mode: rule.mode, serviceCode: rule.serviceCode ?? null } : null };
    }),
  ),
);

publicRoutes.get("/stats", async (c) => {
  const all = await publicDirectory();
  const byModem: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byBand: Record<string, number> = {};
  const byServiceCode: Record<string, number> = {}; // gateways per public code, as the compat feed publishes it
  for (const g of all) {
    for (const sc of new Set(g.channels.flatMap((x) => x.serviceCodes ?? []))) byServiceCode[sc] = (byServiceCode[sc] ?? 0) + 1;
    bySource[g.source] = (bySource[g.source] ?? 0) + 1;
    byStatus[g.status] = (byStatus[g.status] ?? 0) + 1;
    for (const ch of new Set(g.channels.map((x) => x.modem))) byModem[ch] = (byModem[ch] ?? 0) + 1;
    for (const ch of g.channels) {
      const b = bandOf(ch.frequencyHz) ?? "other";
      byBand[b] = (byBand[b] ?? 0) + 1;
    }
  }
  return c.json({ gateways: all.length, channels: all.reduce((n, g) => n + g.channels.length, 0), byModem, bySource, byStatus, byBand, byServiceCode });
});
