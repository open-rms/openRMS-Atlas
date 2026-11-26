// Service-owned API keys (identity.md §5): gateway heartbeats (orms_) and watcher uploads
// (ormsw_). The kind is fixed at creation and never read from user-editable data.
import { randomBytes, randomUUID } from "node:crypto";
import { hashApiKey } from "@openrms/service-auth";
import { q } from "../db/pool.js";

export type KeyKind = "gateway" | "watcher";
const PREFIX: Record<KeyKind, string> = { gateway: "orms_", watcher: "ormsw_" };
/** Requests per hour per key. Heartbeats come every few minutes; watchers post every 10–30 s. */
const RATE: Record<KeyKind, number> = { gateway: 120, watcher: 400 };
const WINDOW_MS = 60 * 60 * 1000;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function randomKey(len = 64) {
  const bytes = randomBytes(len);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

export interface KeyRow {
  id: string; kind: KeyKind; name: string | null; prefix: string; start: string | null; owner_sub: string;
  watcher_id: string | null; gateway_ids: string[] | null; last_used_at: Date | null; created_at: Date;
}

export async function createKey(o: { kind: KeyKind; ownerSub: string; name: string; watcherId?: string; gatewayIds?: string[] | null }) {
  const key = PREFIX[o.kind] + randomKey();
  const id = randomUUID();
  await q(
    `INSERT INTO api_key (id, kind, name, prefix, start, hash, owner_sub, watcher_id, gateway_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, o.kind, o.name.slice(0, 60), PREFIX[o.kind], key.slice(0, 6), hashApiKey(key), o.ownerSub, o.watcherId ?? null,
     o.gatewayIds ? JSON.stringify(o.gatewayIds) : null],
  );
  return { id, key };
}

export async function revokeKey(id: string, ownerSub?: string) {
  const r = await q(`UPDATE api_key SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL ${ownerSub ? "AND owner_sub = $2" : ""}`,
    ownerSub ? [id, ownerSub] : [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function listKeys(ownerSub: string, kind: KeyKind): Promise<KeyRow[]> {
  const { rows } = await q<KeyRow>(
    `SELECT id, kind, name, prefix, start, owner_sub, watcher_id, gateway_ids, last_used_at, created_at FROM api_key
      WHERE owner_sub = $1 AND kind = $2 AND revoked_at IS NULL ORDER BY created_at`,
    [ownerSub, kind],
  );
  return rows;
}

export type VerifyResult =
  | { ok: true; key: KeyRow }
  | { ok: false; status: 401 | 403 | 429; error: string; retryAfter?: number };

/**
 * Check a presented key: right kind, not revoked or expired, owner not banned, within its
 * hourly rate. Counts the request atomically.
 */
export async function verifyKey(raw: string | null | undefined, kind: KeyKind): Promise<VerifyResult> {
  if (!raw || !raw.startsWith(PREFIX[kind]) || (kind === "gateway" && raw.startsWith("ormsw_"))) {
    return { ok: false, status: 401, error: "invalid API key" };
  }
  const { rows } = await q<KeyRow & { revoked_at: Date | null; expires_at: Date | null; banned: boolean | null }>(
    `SELECT k.*, a.banned FROM api_key k LEFT JOIN account_cache a ON a.sub = k.owner_sub WHERE k.hash = $1 AND k.kind = $2`,
    [hashApiKey(raw), kind],
  );
  const k = rows[0];
  if (!k || k.revoked_at || (k.expires_at && k.expires_at < new Date())) return { ok: false, status: 401, error: "invalid API key" };
  if (k.banned) return { ok: false, status: 403, error: "the key's owner is banned" };
  const r = await q<{ rate_count: number; rate_window_start: Date }>(
    `UPDATE api_key SET
       rate_count = CASE WHEN rate_window_start IS NULL OR rate_window_start < now() - interval '1 hour' THEN 1 ELSE rate_count + 1 END,
       rate_window_start = CASE WHEN rate_window_start IS NULL OR rate_window_start < now() - interval '1 hour' THEN now() ELSE rate_window_start END,
       last_used_at = now()
     WHERE id = $1 RETURNING rate_count, rate_window_start`,
    [k.id],
  );
  const used = r.rows[0]!;
  if (used.rate_count > RATE[kind]) {
    const wait = Math.max(1, Math.ceil((used.rate_window_start.getTime() + WINDOW_MS - Date.now()) / 1000));
    return { ok: false, status: 429, error: "rate limit reached", retryAfter: wait };
  }
  return { ok: true, key: k };
}
