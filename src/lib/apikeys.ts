// Accounts-minted API keys (identity.md §5): Atlas only verifies them. This module holds the
// key scopes Atlas offers, the persisted denylist and its sync, per-key rate limits, and the
// batched last-use report.
import { RevocationSync, type RevokedKey } from "@openrms/service-auth";
import { q, tx } from "../db/pool.js";
import { env } from "../env.js";
import { issuer, serviceToken } from "../accounts/reconcile.js";

/** Key-grantable scopes (identity.md §5.2), published at /.well-known/oauth-protected-resource. Never staff powers. */
export const KEY_SCOPES = [
  { scope: "heartbeat", description: "Send gateway heartbeats and confirm your gateways are still on the air" },
  { scope: "watch:ingest", description: "Upload what your openRMS Watch receiver hears, as one of your watchers" },
  { scope: "gateways:read", description: "Read your own gateway listings, including hidden ones" },
  { scope: "gateways:write", description: "Create, edit and delete your own gateway listings" },
] as const;
export type KeyScope = (typeof KEY_SCOPES)[number]["scope"];

export const keysManageUrl = () => `${issuer()}/keys`;

// ── Denylist ───────────────────────────────────────────────────────────────────

export async function isRevoked(jti: string): Promise<boolean> {
  const { rowCount } = await q(`SELECT 1 FROM revoked_key WHERE jti = $1`, [jti]);
  return !!rowCount;
}

/**
 * Store revoked keys (idempotent). Watcher bindings of those keys become tombstones: the key
 * itself is refused by the denylist, but a renewal naming it in `replaces` can still rebind.
 */
export async function storeRevoked(keys: RevokedKey[], source: "pull" | "webhook"): Promise<void> {
  if (!keys.length) return;
  await tx(async (db) => {
    await db.query(
      `INSERT INTO revoked_key (jti, sub, exp, revoked_at, source)
       SELECT k.jti, k.sub, to_timestamp(k.exp), k.revoked_at::timestamptz, $2
         FROM jsonb_to_recordset($1::jsonb) AS k(jti text, sub text, exp double precision, revoked_at text)
       ON CONFLICT (jti) DO UPDATE SET source = CASE WHEN EXCLUDED.source = 'pull' THEN 'pull' ELSE revoked_key.source END`,
      [JSON.stringify(keys), source],
    );
    await db.query(`UPDATE watcher_key SET revoked_at = now() WHERE jti = ANY($1) AND revoked_at IS NULL`, [keys.map((k) => k.jti)]);
  });
}

/** The pull cursor: only pulled rows count, so a webhook can't skip the pull past a missed revocation. */
export async function lastSync(): Promise<string | null> {
  const { rows } = await q<{ at: Date | null }>(`SELECT max(revoked_at) AS at FROM revoked_key WHERE source = 'pull'`);
  return rows[0]?.at ? rows[0].at.toISOString() : null;
}

/** Drop denylist rows for keys that have expired anyway, and old watcher-key tombstones. */
export async function pruneKeys(): Promise<void> {
  await q(`DELETE FROM revoked_key WHERE exp < now() - interval '1 hour'`);
  // A renewal may arrive after its old key expired (watcher offline); keep the tombstone a while.
  await q(`DELETE FROM watcher_key WHERE key_exp < now() - interval '30 days'`);
}

// ── Per-key rate limits (in memory; a key is one machine) ──────────────────────

/** Requests per hour per key and scope. Heartbeats come every few minutes; watchers batch every 10 min. */
const RATE: Record<KeyScope, number> = { heartbeat: 120, "watch:ingest": 400, "gateways:read": 600, "gateways:write": 600 };
const WINDOW_MS = 60 * 60_000;
const buckets = new Map<string, { start: number; count: number }>();

/** Count one request; returns seconds to wait when over the limit, else 0. */
export function rateLimit(jti: string, scope: KeyScope, now = Date.now()): number {
  const k = `${jti} ${scope}`;
  let b = buckets.get(k);
  if (!b || now - b.start >= WINDOW_MS) buckets.set(k, (b = { start: now, count: 0 }));
  b.count++;
  if (buckets.size > 50_000) for (const [key, v] of buckets) if (now - v.start >= WINDOW_MS) buckets.delete(key);
  return b.count > RATE[scope] ? Math.max(1, Math.ceil((b.start + WINDOW_MS - now) / 1000)) : 0;
}

// ── Last use, reported to Accounts in batches (identity.md §5.5) ───────────────

const used = new Map<string, number>();

export function noteKeyUse(jti: string, at = Date.now()) {
  used.set(jti, Math.max(at, used.get(jti) ?? 0));
}

/** POST {issuer}/api/v1/keys/used. On failure the batch is kept for the next try. */
export async function flushKeyUse(): Promise<number> {
  if (!used.size) return 0;
  const batch = [...used].slice(0, 5000);
  for (const [jti] of batch) used.delete(jti);
  try {
    const res = await fetch(`${issuer()}/api/v1/keys/used`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await serviceToken("accounts.keys")}` },
      body: JSON.stringify(batch.map(([jti, at]) => ({ jti, at: new Date(at).toISOString() }))),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return batch.length;
  } catch (e) {
    for (const [jti, at] of batch) noteKeyUse(jti, at);
    throw e;
  }
}

/** The caller's Atlas keys, from Accounts (metadata only, never the key). */
export async function accountsKeys(sub: string): Promise<{ keys: unknown[]; manage: string }> {
  const res = await fetch(`${issuer()}/api/v1/users/${encodeURIComponent(sub)}/keys`, {
    headers: { Authorization: `Bearer ${await serviceToken("accounts.keys")}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Accounts keys: HTTP ${res.status}`);
  const j = (await res.json()) as { keys: unknown[]; manage?: string };
  return { keys: j.keys ?? [], manage: j.manage ?? keysManageUrl() };
}

export const keysConfigured = () => !!(env.ACCOUNTS_CLIENT_ID && env.ACCOUNTS_CLIENT_SECRET);

/** Pull revocations at start and every 5 min; report key use and prune on the same tick. */
export function startKeySync(): void {
  const tick = () => {
    pruneKeys().catch((e) => console.error(`[keys] prune failed: ${e}`));
    if (keysConfigured()) flushKeyUse().catch((e) => console.error(`[keys] last-use report failed (kept for next time): ${e}`));
  };
  setInterval(tick, 5 * 60_000).unref();
  if (!keysConfigured()) {
    console.error("[keys] no ACCOUNTS_CLIENT_ID/SECRET: revocations arrive only by webhook, and key use isn't reported");
    return;
  }
  const sync = new RevocationSync({
    issuer: issuer(),
    clientId: env.ACCOUNTS_CLIENT_ID!,
    clientSecret: env.ACCOUNTS_CLIENT_SECRET!,
    store: (keys) => storeRevoked(keys, "pull"),
    lastSync,
    log: (m, e) => console.error(`[keys] ${m}`, e instanceof Error ? e.message : (e ?? "")),
  });
  void sync.start();
}

/** Tests: forget in-memory state. */
export function resetKeyState() {
  buckets.clear();
  used.clear();
}
