// Demand for service codes that aren't public: which codes people search for (Site code box,
// ?serviceCode=, Pat's ServiceCodes), so admins can spot common codes worth making public.
//
// Privacy: no IP is stored. Each searcher is counted once per code per UTC day using an HMAC of
// their IP under a random key that lives only in memory and is replaced every day (and on every
// restart), so stored counts can't be linked back to anyone. The database keeps only
// (code, day, searchers, searches). Admins see a code only once its searcher-days reach
// DEMAND_MIN_SEARCHERS within DEMAND_DAYS; rows older than that are deleted.
import { createHmac, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { q } from "../db/pool.js";
import { clientIp } from "./codelimit.js";

export const DEMAND_DAYS = 90;
export const DEMAND_MIN_SEARCHERS = 3;
const CODE = /^[A-Z0-9]{1,16}$/;
const MAX_SEEN = 200_000;

let day = "";
let key = randomBytes(32);
let seen = new Set<string>();

function today(): string {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== day) {
    day = d;
    key = randomBytes(32);
    seen = new Set();
  }
  return d;
}

/** Count a search for non-public codes. Fire and forget: never slows or fails the request. */
export function trackSearch(c: Context, codes: string[]): void {
  const valid = codes.filter((x) => CODE.test(x));
  if (!valid.length) return;
  const d = today();
  const who = createHmac("sha256", key).update(clientIp(c)).digest("base64url").slice(0, 22);
  if (seen.size > MAX_SEEN) seen = new Set(); // bounded memory; at worst a few searchers count twice
  for (const code of valid) {
    const k = `${code}|${who}`;
    const first = !seen.has(k);
    seen.add(k);
    q(
      `INSERT INTO service_code_search (code, day, searchers, searches) VALUES ($1, $2, $3, 1)
       ON CONFLICT (code, day) DO UPDATE SET searchers = service_code_search.searchers + EXCLUDED.searchers,
                                             searches = service_code_search.searches + 1`,
      [code, d, first ? 1 : 0],
    ).catch((e) => console.error(`[service-codes] demand count failed: ${(e as Error).message}`));
  }
  if (Math.random() < 0.01) pruneDemand().catch(() => {});
}

export async function pruneDemand(): Promise<void> {
  await q(`DELETE FROM service_code_search WHERE day < (now() AT TIME ZONE 'UTC')::date - $1::int`, [DEMAND_DAYS]);
}

/** For tests. */
export function resetDemand(): void {
  day = "";
  seen = new Set();
}
