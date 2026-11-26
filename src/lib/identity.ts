// Who is calling: Accounts-issued access tokens (identity.md §3) and API keys (§5), verified
// offline against the issuer's JWKS, plus the local account cache (§7) for facts a token can't
// be trusted for (bans, club membership removed since the token was issued).
//
// Keys are refused everywhere by default. A route accepts one only by naming the key scopes
// that may call it (requireViewer({ keyScopes }) or requireKey). Staff routes never do (§5.2).
import type { Context, MiddlewareHandler } from "hono";
import { bearerToken, KEY_PREFIX, TokenError, verifyBearer, type AccessClaims, type ClubRole } from "@openrms/service-auth";
import { q, tx } from "../db/pool.js";
import { env } from "../env.js";
import { isRevoked, noteKeyUse, rateLimit, type KeyScope } from "./apikeys.js";

export interface Viewer {
  sub: string;
  callsign: string;
  callsignVerified: boolean;
  name: string | null;
  role: string; // site role from the token (first-party tokens only; else "user")
  clubs: { id: string; callsign: string; role: ClubRole; verified: boolean }[];
  clientId: string | null;
}

/** The API key a request was made with (null for access tokens). */
export interface KeyInfo {
  jti: string;
  scopes: string[];
  exp: number;
  replaces: string | null;
}

export interface Caller {
  viewer: Viewer;
  key: KeyInfo | null;
}

export type ViewerVars = { Variables: { viewer: Viewer; key: KeyInfo | null; caller: Caller | null } };

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

/** The presented credential: `Authorization: Bearer`, or `x-api-key` carrying an `ormk_` key. */
function presented(c: Context): string | null {
  const bearer = bearerToken(c.req.header("authorization"));
  if (bearer) return bearer;
  const x = c.req.header("x-api-key")?.trim();
  return x?.startsWith(KEY_PREFIX) ? x : null;
}

async function clubsOf(sub: string) {
  const { rows } = await q<{ id: string; callsign: string; role: ClubRole; verified: boolean }>(
    `SELECT c.id, c.callsign, m.role, c.verified FROM account_club_member m JOIN account_club c ON c.id = m.club_id WHERE m.sub = $1 ORDER BY c.callsign`,
    [sub],
  );
  return rows;
}

/** Verify the credential and build the Caller. Throws TokenError, or returns null when absent. */
export async function callerFrom(c: Context): Promise<Caller | null> {
  const cached = c.get("caller") as Caller | null | undefined;
  if (cached !== undefined) return cached;
  const token = presented(c);
  if (!token) return null;
  const b = await verifyBearer(token, { audience: env.OPENRMS_AUDIENCE, issuers, isRevoked });
  let caller: Caller;
  if (b.kind === "key") {
    // A key's claims are as old as the key (up to a year): its callsign is display-only, and it
    // never refreshes the cache or carries a role. Everything comes from the account cache.
    const k = b.claims;
    const { rows } = await q<{ callsign: string; callsign_verified: boolean; banned: boolean; name: string | null }>(
      `SELECT callsign, callsign_verified, banned, name FROM account_cache WHERE sub = $1`, [k.sub],
    );
    const acct = rows[0];
    if (acct?.banned) throw new TokenError("account is banned", "invalid");
    caller = {
      viewer: {
        sub: k.sub, callsign: acct?.callsign ?? "", callsignVerified: acct?.callsign_verified ?? false, name: acct?.name ?? null,
        role: "user", clubs: await clubsOf(k.sub), clientId: null,
      },
      key: { jti: k.jti, scopes: k.scope, exp: k.exp, replaces: k.replaces ?? null },
    };
  } else {
    const claims = b.claims;
    await refreshFromClaims(claims);
    const { rows } = await q<{ callsign: string; callsign_verified: boolean; banned: boolean; name: string | null }>(
      `SELECT callsign, callsign_verified, banned, name FROM account_cache WHERE sub = $1`, [claims.sub],
    );
    const acct = rows[0];
    if (acct?.banned) throw new TokenError("account is banned", "invalid");
    caller = {
      viewer: {
        sub: claims.sub,
        callsign: acct?.callsign ?? claims.callsign ?? "",
        callsignVerified: acct?.callsign_verified ?? !!claims.callsign_verified,
        name: acct?.name ?? claims.name ?? null,
        role: claims.client_id ? "user" : (claims.role ?? "user"), // third-party clients never carry staff power
        clubs: await clubsOf(claims.sub), // from the cache: removals by webhook win over older tokens
        clientId: claims.client_id ?? null,
      },
      key: null,
    };
  }
  c.set("caller", caller);
  return caller;
}

/** Access tokens only (keys are treated as absent). */
export async function viewerFrom(c: Context): Promise<Viewer | null> {
  const caller = await callerFrom(c);
  return caller && !caller.key ? caller.viewer : null;
}

function deny(c: Context, e: unknown) {
  const code = e instanceof TokenError ? e.code : "invalid";
  const msg = e instanceof TokenError ? e.message : "invalid token";
  return c.json({ error: msg, code }, code === "invalid" && msg === "account is banned" ? 403 : 401,
    { "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${env.PUBLIC_URL.replace(/\/+$/, "")}/.well-known/oauth-protected-resource"` });
}

const KEY_HINT = `manage keys at ${env.OPENRMS_ISSUER.split(",")[0]!.trim().replace(/\/+$/, "")}/keys`;

/**
 * Check a key's scope and rate limit for this route. Returns a response to send, or null to go on.
 * `scopes`: any one of them is enough.
 */
function keyGate(c: Context, key: KeyInfo, scopes: readonly KeyScope[]): Response | null {
  const scope = scopes.find((s) => key.scopes.includes(s));
  if (!scope) {
    return scopes.length
      ? c.json({ error: `this API key lacks the ${scopes.join(" or ")} scope (${KEY_HINT})`, code: "insufficient_scope" }, 403,
          { "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${scopes.join(" ")}"` })
      : c.json({ error: "API keys can't be used here; sign in to openRMS Accounts", code: "key_not_allowed" }, 403);
  }
  const wait = rateLimit(key.jti, scope);
  if (wait) return c.json({ error: "rate limit reached for this key", code: "rate_limited" }, 429, { "Retry-After": String(wait) });
  noteKeyUse(key.jti);
  return null;
}

/**
 * Require a signed-in caller: an Accounts access token, or an API key holding one of
 * `keyScopes` (none by default, so keys are refused).
 */
export function requireViewer(opts: { keyScopes?: readonly KeyScope[]; needCallsign?: boolean } = {}): MiddlewareHandler<ViewerVars> {
  const keyScopes = opts.keyScopes ?? [];
  const needCallsign = opts.needCallsign ?? true;
  return async (c, next) => {
    let caller: Caller | null;
    try {
      caller = await callerFrom(c);
    } catch (e) {
      return deny(c, e);
    }
    if (!caller) return c.json({ error: "sign in required (Authorization: Bearer <access token or API key from openRMS Accounts>)", code: "missing" }, 401);
    if (caller.key) {
      const r = keyGate(c, caller.key, keyScopes);
      if (r) return r;
    }
    if (needCallsign && !caller.viewer.callsign) {
      return c.json({ error: caller.key ? "the key's account isn't known here yet; sign in to the site once" : "this token has no callsign claim; request the callsign scope" }, 403);
    }
    c.set("viewer", caller.viewer);
    c.set("key", caller.key);
    await next();
  };
}

/** Signed-in callers with access tokens only: staff, account and moderation routes. */
export const requireSignedIn = requireViewer();

/** An API key with `scope` only (machine routes: heartbeats, watcher uploads). */
export function requireKey(scope: KeyScope): MiddlewareHandler<ViewerVars> {
  return async (c, next) => {
    let caller: Caller | null;
    try {
      caller = await callerFrom(c);
    } catch (e) {
      return deny(c, e);
    }
    if (!caller) return c.json({ error: `API key required (Authorization: Bearer ormk_…, scope ${scope}; ${KEY_HINT})`, code: "missing" }, 401);
    if (!caller.key) return c.json({ error: `this route takes an API key with the ${scope} scope, not a sign-in token (${KEY_HINT})`, code: "key_required" }, 401);
    const r = keyGate(c, caller.key, [scope]);
    if (r) return r;
    c.set("viewer", caller.viewer);
    c.set("key", caller.key);
    await next();
  };
}

/** Optional caller (access tokens only): invalid or missing credentials are treated as anonymous. */
export async function optionalViewer(c: Context): Promise<Viewer | null> {
  try {
    return await viewerFrom(c);
  } catch {
    return null;
  }
}
