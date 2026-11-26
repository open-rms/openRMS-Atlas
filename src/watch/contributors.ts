// Contributor recognition (openRMS-Spec/watch/feed.md §7): public watchers active in the last N days.
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { bandOf } from "../modes.js";

export interface Contributor {
  callsign: string; ownerVerified: boolean; watcher: string; gridsquare: string | null; bands: string[];
  listeningHours: number; frames: number; firstContribution: string; lastSeen: string | null; live: boolean;
}

const LIVE_MS = 10 * 60_000;

export async function contributors(days: number) {
  const since = new Date(Date.now() - days * 86400_000);
  const res = await db.execute<{
    id: string; name: string; gridsquare: string | null; location_precision: string; public: boolean; last_seen_at: Date | null;
    callsign: string; verified: boolean; frames: number; first_at: Date; coverage: { s: string; e: string; r: [number, number][] }[] | null;
    dials: number[] | null;
  }>(sql`
    SELECT w.id, w.name, w.gridsquare, w.location_precision, w.public, w.last_seen_at,
           COALESCE(u.callsign, '?') AS callsign, COALESCE(u.callsign_verified, false) AS verified,
           count(*) FILTER (WHERE e.type = 'frame')::int AS frames,
           (SELECT min(received_at) FROM watch_event x WHERE x.watcher_id = w.id) AS first_at,
           jsonb_agg(jsonb_build_object('s', e.ts, 'e', e.ts_end, 'r', e.payload->'ranges')) FILTER (WHERE e.type = 'coverage') AS coverage,
           array_agg(DISTINCT e.dial_hz) FILTER (WHERE e.dial_hz IS NOT NULL) AS dials
      FROM watcher w
      LEFT JOIN account_cache u ON u.sub = w.owner_sub
      JOIN watch_event e ON e.watcher_id = w.id AND e.ts >= ${since}
     WHERE NOT w.disabled
     GROUP BY w.id, u.callsign, u.callsign_verified`);
  const now = Date.now();
  const all = res.rows.map((r) => {
    const bands = new Set<string>();
    let ms = 0;
    for (const c of r.coverage ?? []) {
      ms += Math.max(0, Date.parse(c.e) - Date.parse(c.s));
      for (const [lo, hi] of c.r ?? []) for (const hz of [lo, (lo + hi) / 2, hi]) { const b = bandOf(hz); if (b) bands.add(b); }
    }
    for (const d of r.dials ?? []) { const b = bandOf(Number(d) + 1500); if (b) bands.add(b); }
    const grid = r.location_precision === "hidden" || !r.gridsquare ? null : r.gridsquare.slice(0, r.location_precision === "grid6" ? 6 : 4);
    const lastSeen = r.last_seen_at ? new Date(r.last_seen_at) : null;
    return {
      public: r.public,
      c: {
        callsign: r.callsign, ownerVerified: r.verified, watcher: r.name, gridsquare: grid, bands: [...bands],
        listeningHours: Math.round((ms / 3.6e6) * 10) / 10, frames: r.frames, firstContribution: new Date(r.first_at).toISOString(),
        lastSeen: lastSeen?.toISOString() ?? null, live: !!lastSeen && now - lastSeen.getTime() < LIVE_MS,
      } satisfies Contributor,
    };
  });
  const named = all.filter((x) => x.public).map((x) => x.c).sort((a, b) => b.listeningHours - a.listeningHours || b.frames - a.frames);
  return {
    days,
    totals: {
      watchers: all.length,
      live: all.filter((x) => x.c.live).length,
      listeningHours: Math.round(all.reduce((s, x) => s + x.c.listeningHours, 0) * 10) / 10,
      frames: all.reduce((s, x) => s + x.c.frames, 0),
      anonymous: all.length - named.length,
    },
    contributors: named,
  };
}
