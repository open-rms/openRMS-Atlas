// Imports the Winlink gateway list (api.winlink.org gateway/status.json) on a
// timer, server side only. Each row is tagged source='winlink' so it can be
// filtered, dropped (WINLINK_PUBLISH=false) or replaced by an owner listing.
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { env } from "../env.js";
import { tx, q } from "../db/pool.js";
import { parseWinlinkModes } from "../modes.js";
import { invalidateDirectory, publicServiceCodes } from "../data.js";

const WINLINK_URL = "https://api.winlink.org/gateway/status.json";

interface WlChannel {
  SupportedModes: string; Mode: number; Gridsquare: string; Frequency: number;
  OperatingHours: string; Baud: string; RadioRange: string; Antenna: string; ServiceCode: string;
}
interface WlGateway {
  Callsign: string; BaseCallsign: string; Latitude: number; Longitude: number;
  LastStatus: string; Comments: string; GatewayChannels: WlChannel[];
}

/**
 * The configured codes that may be imported: only public ones. Private group codes (MARS,
 * SHARES, agency codes) must never be fetched; if one is configured by mistake it is skipped.
 */
export async function importableCodes(): Promise<{ codes: string[]; skipped: number; pub: Set<string> }> {
  const pub = await publicServiceCodes();
  const configured = [...new Set(env.WINLINK_SERVICE_CODES.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))];
  const codes = configured.filter((c) => pub.has(c));
  return { codes, skipped: configured.length - codes.length, pub };
}

export async function fetchWinlink(codes: string[]): Promise<WlGateway[]> {
  let text: string;
  if (env.WINLINK_FIXTURE) {
    if (env.WINLINK_FIXTURE_REFRESH_CMD) {
      // Development: refresh the snapshot first. On failure, import the previous snapshot.
      try {
        const { stdout } = await promisify(execFile)("sh", ["-c", env.WINLINK_FIXTURE_REFRESH_CMD], { timeout: 6 * 60_000 });
        console.log(`[winlink] snapshot refreshed: ${stdout.trim()}`);
      } catch (e) {
        console.error(`[winlink] snapshot refresh failed, using the previous one: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    const buf = await readFile(env.WINLINK_FIXTURE);
    text = (env.WINLINK_FIXTURE.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8");
  } else if (env.WINLINK_API_KEY) {
    const params = new URLSearchParams({ Mode: "AnyAll", HistoryHours: "48", key: env.WINLINK_API_KEY });
    for (const c of codes) params.append("ServiceCodes", c);
    const res = await fetch(WINLINK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "openrms-atlas/0.1" },
      body: params,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`api.winlink.org: HTTP ${res.status}`);
    text = await res.text();
  } else {
    throw new Error("Winlink import disabled: set WINLINK_API_KEY (production) or WINLINK_FIXTURE (development)");
  }
  const doc = JSON.parse(text) as { Gateways?: WlGateway[]; ResponseStatus?: { ErrorCode?: string; Message?: string } };
  if (!Array.isArray(doc.Gateways)) throw new Error(`unexpected Winlink response: ${JSON.stringify(doc.ResponseStatus ?? {}).slice(0, 200)}`);
  return doc.Gateways;
}

export async function importWinlink(opts: { force?: boolean } = {}): Promise<{ gateways: number; channels: number }> {
  const run = await q<{ id: number }>(`INSERT INTO import_run (source) VALUES ('winlink') RETURNING id`);
  const runId = run.rows[0]!.id;
  try {
    const { codes, skipped, pub } = await importableCodes();
    if (skipped) console.warn(`[winlink] ${skipped} configured service code(s) skipped: only public codes are imported`);
    if (codes.length === 0) throw new Error("no public service codes configured in WINLINK_SERVICE_CODES");
    // Keep only channels under public codes (a snapshot may hold others), and drop gateways left empty.
    const gateways = (await fetchWinlink(codes))
      .map((g) => ({ ...g, GatewayChannels: (g.GatewayChannels ?? []).filter((ch) => pub.has(String(ch.ServiceCode || "PUBLIC").trim().toUpperCase())) }))
      .filter((g) => g.GatewayChannels.length > 0);
    // Guard: an empty or truncated response would mark every Winlink row removed.
    const last = await q<{ gateways: number }>(
      `SELECT gateways FROM import_run WHERE source = 'winlink' AND ok AND gateways > 0 ORDER BY id DESC LIMIT 1`,
    );
    const prev = last.rows[0]?.gateways ?? 0;
    if (!opts.force && (gateways.length === 0 || (prev > 0 && gateways.length < prev * 0.5))) {
      throw new Error(`refusing import: ${gateways.length} gateways vs ${prev} last time (run 'pnpm cli import-winlink --force' to override)`);
    }
    let channels = 0;
    await tx(async (c) => {
      const seen: string[] = [];
      for (const g of gateways) {
        const callsign = String(g.Callsign ?? "").trim().toUpperCase();
        if (!callsign) continue;
        seen.push(callsign);
        const lastStatus = new Date(g.LastStatus);
        const grid = g.GatewayChannels?.[0]?.Gridsquare || null;
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO gateway (source, callsign, base_callsign, latitude, longitude, gridsquare, comments, winlink_last_status, winlink_listed, removed_at, updated_at)
           VALUES ('winlink', $1, $2, $3, $4, $5, $6, $7, true, NULL, now())
           ON CONFLICT (source, callsign) DO UPDATE SET
             base_callsign = EXCLUDED.base_callsign, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
             gridsquare = EXCLUDED.gridsquare, comments = EXCLUDED.comments,
             winlink_last_status = EXCLUDED.winlink_last_status, removed_at = NULL, updated_at = now()
           RETURNING id`,
          [callsign, String(g.BaseCallsign || callsign.split("-")[0]).toUpperCase(), g.Latitude, g.Longitude, grid,
           g.Comments ?? "", isNaN(lastStatus.getTime()) ? null : lastStatus],
        );
        const gwId = rows[0]!.id;
        await c.query(`DELETE FROM channel WHERE gateway_id = $1`, [gwId]);
        for (const ch of g.GatewayChannels ?? []) {
          if (!(ch.Frequency > 0) || !ch.SupportedModes) continue;
          const { modem, variant } = parseWinlinkModes(ch.SupportedModes, ch.ServiceCode ?? "PUBLIC");
          await c.query(
            `INSERT INTO channel (gateway_id, frequency_hz, modem, variant, service_code, operating_hours, antenna, radio_range,
                                  gridsquare, baud, winlink_supported_modes, winlink_mode)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [gwId, Math.round(ch.Frequency), modem, variant, ch.ServiceCode || "PUBLIC", ch.OperatingHours || "00-23",
             ch.Antenna ?? "", ch.RadioRange ?? "", ch.Gridsquare || null, ch.Baud ?? "0", ch.SupportedModes, ch.Mode ?? null],
          );
          channels++;
        }
      }
      await c.query(
        `UPDATE gateway SET removed_at = now() WHERE source = 'winlink' AND removed_at IS NULL AND NOT (callsign = ANY($1))`,
        [seen],
      );
    });
    await q(`UPDATE import_run SET finished_at = now(), ok = true, gateways = $2, channels = $3 WHERE id = $1`, [runId, gateways.length, channels]);
    invalidateDirectory();
    return { gateways: gateways.length, channels };
  } catch (e) {
    await q(`UPDATE import_run SET finished_at = now(), ok = false, message = $2 WHERE id = $1`, [runId, String(e)]);
    throw e;
  }
}

export function startWinlinkPoller(): void {
  if (!env.WINLINK_API_KEY && !env.WINLINK_FIXTURE) {
    console.log("[winlink] import disabled (no WINLINK_API_KEY or WINLINK_FIXTURE)");
    return;
  }
  const run = () =>
    importWinlink()
      .then((r) => console.log(`[winlink] imported ${r.gateways} gateways, ${r.channels} channels`))
      .catch((e) => console.error(`[winlink] import failed: ${e}`));
  void run();
  setInterval(run, env.WINLINK_POLL_MINUTES * 60_000).unref();
}
