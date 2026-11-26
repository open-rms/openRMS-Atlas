// Winlink-compatible feed for Pat, EmComm Tools, PatMenu and anything else that
// reads api.winlink.org's gateway/status.json shape.
import { Hono, type Context } from "hono";
import { publicDirectory } from "../data.js";
import { env } from "../env.js";
import { parseRequestedMode, patCacheFileName, stringifyWinlink, toWinlinkStatus } from "../compat/winlink-status.js";

export const compatRoutes = new Hono();

async function params(c: Context): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const add = (k: string, v: string) => (out[k.toLowerCase()] ??= []).push(v);
  for (const [k, vs] of Object.entries(c.req.queries())) for (const v of vs) add(k, v);
  if (c.req.method === "POST") {
    const ct = c.req.header("content-type") ?? "";
    if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      const body = await c.req.parseBody({ all: true });
      for (const [k, v] of Object.entries(body)) for (const x of [v].flat()) if (typeof x === "string") add(k, x);
    } else if (ct.includes("application/json")) {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      for (const [k, v] of Object.entries(body)) for (const x of [v].flat()) add(k, String(x));
    }
  }
  return out;
}

async function feed(c: Context, asFile: boolean) {
  const p = await params(c);
  // ServiceCodes may be repeated (Pat) or comma-separated; "key" is accepted and ignored.
  const serviceCodes = (p.servicecodes ?? []).flatMap((s) => s.split(/[,\s]+/)).filter(Boolean).map((s) => s.toUpperCase());
  const hh = Number(p.historyhours?.[0]);
  const source = p.source?.[0];
  let gateways = await publicDirectory();
  if (source === "openrms" || source === "winlink") gateways = gateways.filter((g) => g.source === source);
  const doc = toWinlinkStatus(gateways, {
    mode: parseRequestedMode(p.mode?.[0]),
    historyHours: Number.isFinite(hh) && hh > 0 ? Math.min(hh, 48 * 7) : 48,
    serviceCodes: serviceCodes.length ? serviceCodes : ["PUBLIC"],
    extensions: ["1", "true"].includes(p.extensions?.[0] ?? ""),
    requireVerified: env.COMPAT_REQUIRE_VERIFIED,
    publicBaseUrl: env.PUBLIC_URL,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=300",
    "Access-Control-Allow-Origin": "*",
  };
  if (asFile) headers["Content-Disposition"] = `attachment; filename="${patCacheFileName(serviceCodes.length ? serviceCodes : ["PUBLIC"])}"`;
  return c.body(stringifyWinlink(doc), 200, headers);
}

// Same path as api.winlink.org so a client only has to change its base URL.
compatRoutes.on(["GET", "POST"], "/gateway/status.json", (c) => feed(c, false));
compatRoutes.on(["GET", "POST"], "/gateway/status", (c) => feed(c, false));
// Download for Pat's cache: save as $XDG_DATA_HOME/pat/rmslist.json (see scripts/pat-rmslist-sync.sh).
compatRoutes.get("/export/pat/rmslist.json", (c) => feed(c, true));
