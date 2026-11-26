// Timed reconcile of the local account cache against openRMS-Accounts (identity.md §6–7),
// as a safety net for missed webhooks. Uses Atlas's OAuth client (client credentials).
import { q, tx } from "../db/pool.js";
import { env } from "../env.js";
import { invalidateDirectory } from "../data.js";

interface RemoteUser {
  sub: string; name: string | null; callsign: string; callsign_verified: boolean; callsign_verified_method: string | null;
  role: string; banned: boolean; clubs: { id: string; callsign: string; role: string; verified: boolean }[];
}

export const issuer = () => env.OPENRMS_ISSUER.split(",")[0]!.trim().replace(/\/+$/, "");
const tokens = new Map<string, { value: string; exp: number }>();

/** Atlas's client-credentials token at Accounts, cached per scope ("" = the client's default). */
export async function serviceToken(scope = ""): Promise<string> {
  const hit = tokens.get(scope);
  if (hit && hit.exp > Date.now() + 60_000) return hit.value;
  const body = new URLSearchParams({ grant_type: "client_credentials", resource: issuer() });
  if (scope) body.set("scope", scope);
  const res = await fetch(`${issuer()}/api/auth/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${env.ACCOUNTS_CLIENT_ID}:${env.ACCOUNTS_CLIENT_SECRET}`).toString("base64")}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`Accounts token: HTTP ${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in?: number };
  const t = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 600) * 1000 };
  tokens.set(scope, t);
  return t.value;
}

export async function reconcileAccounts(): Promise<number> {
  const { rows } = await q<{ value: string }>(`SELECT value FROM site_setting WHERE key = 'accounts_reconciled_at'`);
  const since = rows[0]?.value ?? "1970-01-01T00:00:00Z";
  const started = new Date().toISOString();
  const res = await fetch(`${issuer()}/api/v1/users?updatedSince=${encodeURIComponent(since)}`, {
    headers: { Authorization: `Bearer ${await serviceToken()}` },
  });
  if (!res.ok) throw new Error(`Accounts users: HTTP ${res.status}`);
  const { users } = (await res.json()) as { users: RemoteUser[] };
  for (const u of users) {
    await tx(async (db) => {
      await db.query(`UPDATE account_cache SET callsign = callsign || '~' || sub WHERE callsign = $1 AND sub <> $2`, [u.callsign, u.sub]);
      await db.query(
        `INSERT INTO account_cache (sub, callsign, callsign_verified, callsign_verified_method, name, role, banned, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (sub) DO UPDATE SET callsign = EXCLUDED.callsign, callsign_verified = EXCLUDED.callsign_verified,
           callsign_verified_method = EXCLUDED.callsign_verified_method, name = EXCLUDED.name, role = EXCLUDED.role,
           banned = EXCLUDED.banned, updated_at = now()`,
        [u.sub, u.callsign, u.callsign_verified, u.callsign_verified_method, u.name, u.role, u.banned],
      );
      for (const c of u.clubs ?? []) {
        await db.query(`UPDATE account_club SET callsign = callsign || '~' || id WHERE callsign = $1 AND id <> $2`, [c.callsign, c.id]);
        await db.query(
          `INSERT INTO account_club (id, callsign, name, verified, updated_at) VALUES ($1,$2,$2,$3, now())
           ON CONFLICT (id) DO UPDATE SET callsign = EXCLUDED.callsign, verified = EXCLUDED.verified, updated_at = now()`,
          [c.id, c.callsign, c.verified],
        );
      }
      await db.query(`DELETE FROM account_club_member WHERE sub = $1 AND NOT (club_id = ANY($2))`, [u.sub, (u.clubs ?? []).map((c) => c.id)]);
      for (const c of u.clubs ?? []) {
        await db.query(
          `INSERT INTO account_club_member (club_id, sub, role, updated_at) VALUES ($1,$2,$3, now())
           ON CONFLICT (club_id, sub) DO UPDATE SET role = EXCLUDED.role, updated_at = now()`,
          [c.id, u.sub, c.role],
        );
      }
    });
  }
  // Clubs: names, verification, and deletions missed by webhooks (GET /api/v1/clubs lists every club).
  const cr = await fetch(`${issuer()}/api/v1/clubs`, { headers: { Authorization: `Bearer ${await serviceToken()}` } });
  if (cr.ok) {
    const { clubs } = (await cr.json()) as { clubs: { id: string; name: string; callsign: string; verified: boolean }[] };
    for (const c of clubs) {
      await q(`UPDATE account_club SET callsign = callsign || '~' || id WHERE callsign = $1 AND id <> $2`, [c.callsign, c.id]);
      await q(
        `INSERT INTO account_club (id, callsign, name, verified, updated_at) VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (id) DO UPDATE SET callsign = EXCLUDED.callsign, name = EXCLUDED.name, verified = EXCLUDED.verified, updated_at = now()`,
        [c.id, c.callsign, c.name || c.callsign, c.verified],
      );
    }
    // Guard: an empty list while we know clubs is more likely an Accounts fault than every club
    // being deleted at once; don't prune on it (club.deleted webhooks still apply).
    const known = await q<{ n: number }>(`SELECT count(*)::int AS n FROM account_club`);
    const gone = clubs.length === 0 && (known.rows[0]?.n ?? 0) > 0
      ? { rows: [] as { id: string }[] }
      : await q<{ id: string }>(`SELECT id FROM account_club WHERE NOT (id = ANY($1))`, [clubs.map((c) => c.id)]);
    for (const { id } of gone.rows) {
      await q(`DELETE FROM gateway WHERE source = 'openrms' AND owner_club_id = $1`, [id]);
      await q(
        `UPDATE gateway SET owner_sub = NULL, owner_club_id = NULL, claimed_at = NULL, owner_comments = '', software = NULL, emcomm = '{}'::jsonb
          WHERE source = 'winlink' AND owner_club_id = $1`,
        [id],
      );
      await q(`DELETE FROM account_club WHERE id = $1`, [id]);
    }
  }
  await q(
    `INSERT INTO site_setting (key, value, updated_at) VALUES ('accounts_reconciled_at', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(started)],
  );
  if (users.length) invalidateDirectory();
  return users.length;
}

export function startAccountsReconcile(): void {
  if (!env.ACCOUNTS_CLIENT_ID || !env.ACCOUNTS_CLIENT_SECRET) {
    console.log("[accounts] reconcile disabled (no ACCOUNTS_CLIENT_ID/SECRET)");
    return;
  }
  const run = () =>
    reconcileAccounts()
      .then((n) => n && console.log(`[accounts] reconciled ${n} account(s)`))
      .catch((e) => console.error(`[accounts] reconcile failed: ${e}`));
  void run();
  setInterval(run, env.ACCOUNTS_RECONCILE_MINUTES * 60_000).unref();
}
