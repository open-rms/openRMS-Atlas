// Who is calling: Accounts-issued access tokens (identity.md §3), verified offline against the
// issuer's JWKS, plus the local account cache (§7) for facts a token can't be trusted for
// (bans, club membership removed since the token was issued).
import type { Context, MiddlewareHandler } from "hono";
import { bearerToken, TokenError, verifyAccessToken, type AccessClaims, type ClubRole } from "@openrms/service-auth";
import { q, tx } from "../db/pool.js";
import { env } from "../env.js";

export interface Viewer {
  sub: string;
  callsign: string;
  callsignVerified: boolean;
  name: string | null;
  role: string; // site role from the token (first-party tokens only; else "user")
  clubs: { id: string; callsign: string; role: ClubRole; verified: boolean }[];
  clientId: string | null;
}

export type ViewerVars = { Variables: { viewer: Viewer } };

const issuers = env.OPENRMS_ISSUER.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);

/**
 * Refresh the caller's own cache rows from the token, unless the cache already holds newer
 * facts (a webhook arrived after the token was issued, e.g. a club membership was removed).
 */
async function refreshFromClaims(c: AccessClaims) {
  if (!c.callsign) return;
  const iat = new Date((c.iat ?? Math.floor(Date.now() / 1000)) * 1000);
  await tx(async (db) => {
    const cur = await db.query<{ updated_at: Date }>(`SELECT updated_at FROM account_cache WHERE sub = $1 FOR UPDATE`, [c.sub]);
    if (cur.rows[0] && cur.rows[0].updated_at > iat) return;
    // Another account may still hold this callsign in a stale cache row (callsign moved): free it.
    await db.query(`UPDATE account_cache SET callsign = callsign || '~' || sub WHERE callsign = $1 AND sub <> $2`, [c.callsign, c.sub]);
    await db.query(
      `INSERT INTO account_cache (sub, callsign, callsign_verified, callsign_verified_method, name, role, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (sub) DO UPDATE SET callsign = EXCLUDED.callsign, callsign_verified = EXCLUDED.callsign_verified,
         callsign_verified_method = EXCLUDED.callsign_verified_method, name = COALESCE(EXCLUDED.name, account_cache.name),
         role = EXCLUDED.role, updated_at = EXCLUDED.updated_at`,
      [c.sub, c.callsign, !!c.callsign_verified, c.callsign_verified_method ?? null, c.name ?? null, c.role ?? "user", iat],
    );
    if (c.clubs) {
      for (const club of c.clubs) {
        await db.query(`UPDATE account_club SET callsign = callsign || '~' || id WHERE callsign = $1 AND id <> $2`, [club.callsign, club.id]);
        await db.query(
          `INSERT INTO account_club (id, callsign, name, verified, updated_at) VALUES ($1,$2,$2,$3,$4)
           ON CONFLICT (id) DO UPDATE SET callsign = EXCLUDED.callsign, verified = EXCLUDED.verified,
             name = CASE WHEN account_club.name = '' OR account_club.name LIKE '~%' THEN EXCLUDED.name ELSE account_club.name END,
             updated_at = GREATEST(account_club.updated_at, EXCLUDED.updated_at)`,
          [club.id, club.callsign, club.verified, iat],
        );
      }
      await db.query(`DELETE FROM account_club_member WHERE sub = $1 AND NOT (club_id = ANY($2))`, [c.sub, c.clubs.map((x) => x.id)]);
      for (const club of c.clubs) {
        await db.query(
          `INSERT INTO account_club_member (club_id, sub, role, updated_at) VALUES ($1,$2,$3,$4)
           ON CONFLICT (club_id, sub) DO UPDATE SET role = EXCLUDED.role, updated_at = EXCLUDED.updated_at`,
          [club.id, c.sub, club.role, iat],
        );
      }
    }
  });
}

/** Verify the bearer token and build the Viewer. Throws TokenError, or returns null when absent. */
export async function viewerFrom(c: Context): Promise<Viewer | null> {
  const token = bearerToken(c.req.header("authorization"));
  if (!token) return null;
  const claims = await verifyAccessToken(token, { audience: env.DIRECTORY_AUDIENCE, issuers });
  await refreshFromClaims(claims);
  const { rows } = await q<{ callsign: string; callsign_verified: boolean; banned: boolean; name: string | null }>(
    `SELECT callsign, callsign_verified, banned, name FROM account_cache WHERE sub = $1`, [claims.sub],
  );
  const acct = rows[0];
  if (acct?.banned) throw new TokenError("account is banned", "invalid");
  const { rows: clubs } = await q<{ id: string; callsign: string; role: ClubRole; verified: boolean }>(
    `SELECT c.id, c.callsign, m.role, c.verified FROM account_club_member m JOIN account_club c ON c.id = m.club_id WHERE m.sub = $1 ORDER BY c.callsign`,
    [claims.sub],
  );
  return {
    sub: claims.sub,
    callsign: acct?.callsign ?? claims.callsign ?? "",
    callsignVerified: acct?.callsign_verified ?? !!claims.callsign_verified,
    name: acct?.name ?? claims.name ?? null,
    role: claims.client_id ? "user" : (claims.role ?? "user"), // third-party clients never carry staff power
    clubs, // from the cache: removals by webhook win over older tokens
    clientId: claims.client_id ?? null,
  };
}

function deny(c: Context, e: unknown) {
  const code = e instanceof TokenError ? e.code : "invalid";
  const msg = e instanceof TokenError ? e.message : "invalid token";
  return c.json({ error: msg, code }, code === "invalid" && msg === "account is banned" ? 403 : 401);
}

/** Require a signed-in caller (Authorization: Bearer <Accounts access token>). */
export const requireViewer: MiddlewareHandler<ViewerVars> = async (c, next) => {
  try {
    const v = await viewerFrom(c);
    if (!v) return c.json({ error: "sign in required (Authorization: Bearer <access token from openRMS Accounts>)", code: "missing" }, 401);
    if (!v.callsign) return c.json({ error: "this token has no callsign claim; request the callsign scope" }, 403);
    c.set("viewer", v);
  } catch (e) {
    return deny(c, e);
  }
  await next();
};

/** Optional caller: invalid or missing tokens are treated as anonymous. */
export async function optionalViewer(c: Context): Promise<Viewer | null> {
  try {
    return await viewerFrom(c);
  } catch {
    return null;
  }
}
