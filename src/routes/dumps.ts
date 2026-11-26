// Full exports for offline use and mirroring. Signing (minisign/ed25519) is a
// planned follow-up; ETags let mirrors poll cheaply today.
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { publicDirectory } from "../data.js";
import { publicGateway } from "./public.js";

export const dumpRoutes = new Hono();

function etagged(body: string, type: string, ifNoneMatch: string | undefined, filename: string) {
  const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
  const headers: Record<string, string> = {
    ETag: etag,
    "Cache-Control": "public, max-age=300",
    "Access-Control-Allow-Origin": "*",
    "Content-Type": type,
    "Content-Disposition": `inline; filename="${filename}"`,
  };
  if (ifNoneMatch === etag) return new Response(null, { status: 304, headers });
  return new Response(body, { status: 200, headers });
}

dumpRoutes.get("/latest.json", async (c) => {
  const gws = (await publicDirectory()).map((g) => publicGateway(g));
  const body = JSON.stringify({ format: "openrms-atlas-dump", version: 1, generatedAt: new Date().toISOString(), gateways: gws });
  return etagged(body, "application/json; charset=utf-8", c.req.header("if-none-match"), "openrms-gateways.json");
});

dumpRoutes.get("/latest.geojson", async (c) => {
  const features = (await publicDirectory())
    .filter((g) => g.latitude != null && g.longitude != null)
    .map((g) => {
      const { channels, latitude, longitude, ...props } = publicGateway(g);
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [longitude, latitude] },
        properties: { ...props, modems: [...new Set(channels.map((ch) => ch.modem))], channels },
      };
    });
  return etagged(JSON.stringify({ type: "FeatureCollection", features }), "application/geo+json", c.req.header("if-none-match"), "openrms-gateways.geojson");
});

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

dumpRoutes.get("/latest.csv", async (c) => {
  const cols = ["callsign", "base_callsign", "source", "status", "latitude", "longitude", "gridsquare", "frequency_hz", "band",
    "modem", "variant", "service_code", "operating_hours", "last_seen_at", "owner_verified"];
  const lines = [cols.join(",")];
  for (const g of await publicDirectory()) {
    for (const ch of g.channels) {
      lines.push([g.callsign, g.baseCallsign, g.source, g.status, g.latitude, g.longitude, ch.gridsquare ?? g.gridsquare, ch.frequencyHz,
        ch.band, ch.modem, ch.variant, ch.serviceCode, ch.operatingHours, g.lastSeenAt, g.ownerVerified].map(csvCell).join(","));
    }
  }
  return etagged(lines.join("\n") + "\n", "text/csv; charset=utf-8", c.req.header("if-none-match"), "openrms-channels.csv");
});
