// Public read API: no auth. Everything the Site shows comes from here.
import { Hono } from "hono";
import { publicDirectory, type GatewayView } from "../data.js";
import { MODEMS, bandOf } from "../modes.js";
import { gridToLatLon, haversineKm } from "../lib/callsign.js";
import { heardOnAirByGateway, type HeardOnAir } from "../watch/sightings.js";

export const publicRoutes = new Hono();

/** Strip fields that are not public. */
export function publicGateway(g: GatewayView, distanceKm?: number, heard?: Map<string, HeardOnAir>) {
  const { ownerUserId, hidden, ...rest } = g;
  return {
    ...rest,
    // Independent on-air evidence from watchers; separate from status, never edits the listing.
    heardOnAir: heard?.get(g.id) ?? null,
    ...(distanceKm !== undefined ? { distanceKm: Math.round(distanceKm) } : {}),
  };
}

export function filterGateways(all: GatewayView[], p: Record<string, string | undefined>) {
  const modems = p.modem?.split(",").filter(Boolean);
  const bands = p.band?.split(",").filter(Boolean);
  const codes = p.serviceCode?.toUpperCase().split(",").filter(Boolean);
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
    if (codes) channels = channels.filter((c) => codes.includes(c.serviceCode.toUpperCase()));
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

publicRoutes.get("/gateways", async (c) => {
  const p = c.req.query();
  const rows = filterGateways(await publicDirectory(), p);
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
  const g = (await publicDirectory()).find((x) => x.id === c.req.param("id") || x.callsign === c.req.param("id").toUpperCase());
  if (!g) return c.json({ error: "not found" }, 404);
  return c.json(publicGateway(g, undefined, await heardOnAirByGateway()));
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
  for (const g of all) {
    bySource[g.source] = (bySource[g.source] ?? 0) + 1;
    byStatus[g.status] = (byStatus[g.status] ?? 0) + 1;
    for (const ch of new Set(g.channels.map((x) => x.modem))) byModem[ch] = (byModem[ch] ?? 0) + 1;
    for (const ch of g.channels) {
      const b = bandOf(ch.frequencyHz) ?? "other";
      byBand[b] = (byBand[b] ?? 0) + 1;
    }
  }
  return c.json({ gateways: all.length, channels: all.reduce((n, g) => n + g.channels.length, 0), byModem, bySource, byStatus, byBand });
});
