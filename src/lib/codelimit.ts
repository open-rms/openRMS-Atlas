// Unlisted service codes are not enumerated anywhere, so the only way to find one is to guess.
// This makes guessing slow. Each IP may look up a limited number of *distinct* non-public codes
// per hour (repeating a code it already asked for is free, so a group member browsing with their
// code isn't charged again), and one request may name only a few of them. An IP that keeps
// missing is logged. Requests naming only public codes are never limited.
// Responses don't depend on whether a non-public code exists: an unknown code and an unlisted
// code with no listings go through the same path and return the same empty result.
import type { Context } from "hono";
import { env } from "../env.js";

const HOUR = 3_600_000;
const LOG_EVERY = 10; // misses per IP per hour between log lines
/** Non-public codes one request may name. Stops one request from testing many guesses at once. */
export const MAX_HIDDEN_PER_REQUEST = 5;

interface Bucket { start: number; codes: Set<string>; misses: number }
const buckets = new Map<string, Bucket>();

const trustedHeaders = env.TRUSTED_IP_HEADERS.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

/** The caller's IP: a trusted proxy header only when the request came from the local proxy. */
export function clientIp(c: Context): string {
  const peer: string = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? "unknown";
  if (LOOPBACK.test(peer)) {
    for (const h of trustedHeaders) {
      const v = c.req.header(h)?.split(",")[0]?.trim();
      if (v) return v;
    }
  }
  return peer;
}

function bucket(ip: string, now: number): Bucket {
  let b = buckets.get(ip);
  if (!b || now - b.start >= HOUR) {
    b = { start: now, codes: new Set(), misses: 0 };
    buckets.set(ip, b);
    if (buckets.size > 50_000) for (const [k, v] of buckets) if (now - v.start >= HOUR) buckets.delete(k);
  }
  return b;
}

/** The requested codes that are not public (empty when the request names only public codes). */
export function nonPublic(requested: Set<string>, pub: Set<string>): string[] {
  return [...requested].filter((c) => !pub.has(c));
}

/**
 * Charge an IP for the non-public codes a request names. Returns an error response (400 when the
 * request names too many, 429 when the IP's hourly allowance of distinct codes would be exceeded),
 * otherwise null. Codes the IP already looked up this hour cost nothing.
 */
export function limitUnlisted(c: Context, hidden: string[]): Response | null {
  if (hidden.length > MAX_HIDDEN_PER_REQUEST) {
    return c.json({ error: `name at most ${MAX_HIDDEN_PER_REQUEST} service codes that aren't public in one request` }, 400, { "Cache-Control": "no-store" });
  }
  const now = Date.now();
  const b = bucket(clientIp(c), now);
  const fresh = hidden.filter((x) => !b.codes.has(x));
  if (b.codes.size + fresh.length > env.UNLISTED_CODES_PER_HOUR) {
    const retry = Math.ceil((b.start + HOUR - now) / 1000);
    return c.json({ error: "too many requests for service codes that are not public; try again later" }, 429, {
      "Retry-After": String(retry), "Cache-Control": "no-store",
    });
  }
  for (const x of fresh) b.codes.add(x);
  return null;
}

/** Record that a request naming non-public codes found nothing under any of them. */
export function recordMiss(c: Context, codes: string[]): void {
  const ip = clientIp(c);
  const b = bucket(ip, Date.now());
  b.misses++;
  if (b.misses % LOG_EVERY === 0) console.warn(`[service-codes] ${ip}: ${b.misses} unmatched non-public code lookups this hour (last: ${codes.length} code(s))`);
}

/** Test hook. */
export function resetCodeLimits(): void {
  buckets.clear();
}
