// Accounts webhooks (identity.md §7): keep the local account cache current and apply the
// Atlas-side effects of identity changes. Each event id is applied once.
import { Hono } from "hono";
import { verifyWebhook, type AccountsEvent } from "@openrms/service-auth";
import { q, tx } from "../db/pool.js";
import { env } from "../env.js";
import { invalidateDirectory } from "../data.js";
import { invalidateSightings } from "../watch/sightings.js";

export const hookRoutes = new Hono();

type UserData = { sub: string; callsign?: string | { from?: string; to?: string }; callsign_verified?: boolean; callsign_verified_method?: string | null; name?: string | null; role?: string; banned?: boolean };
type ClubData = { id: string; callsign?: string; name?: string; verified?: boolean };
type MemberData = { clubId: string; sub: string; role?: string };

// Accept { user: {...} } / { club: {...} } envelopes as well as flat data.
// user.updated after a callsign change carries callsign {from, to} (Accounts' shape).
const userOf = (d: Record<string, unknown>): UserData & { callsign?: string } => {
  const u = (d.user ?? d) as UserData;
  const cs = typeof u.callsign === "object" && u.callsign ? u.callsign.to : u.callsign;
  return { ...u, callsign: cs ?? undefined };
};
const clubOf = (d: Record<string, unknown>) => ((d.club ?? d) as ClubData);
const memberOf = (d: Record<string, unknown>): MemberData => ({
  // Accounts sends { id: <club id>, sub, role }
  clubId: String(d.clubId ?? d.club_id ?? (d.club as ClubData | undefined)?.id ?? d.id ?? ""),
  sub: String(d.sub ?? (d.user as UserData | undefined)?.sub ?? ""),
  role: (d.role as string | undefined) ?? "member",
});

async function apply(e: AccountsEvent) {
  await tx(async (db) => {
    const seen = await db.query(`INSERT INTO account_event (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [e.id, e.type]);
    if (!seen.rowCount) return; // already applied
    const d = e.data as Record<string, unknown>;
    switch (e.type) {
      case "user.updated":
      case "user.callsign_verified":
      case "user.banned":
      case "user.unbanned": {
        const u = userOf(d);
        const prev = await db.query<{ callsign: string }>(`SELECT callsign FROM account_cache WHERE sub = $1`, [u.sub]);
        // An account we don't know yet, sent without its callsign: leave it to the reconcile
        // rather than caching a half-empty row.
        if (!prev.rowCount && !u.callsign) break;
        if (u.callsign) {
          await db.query(`UPDATE account_cache SET callsign = callsign || '~' || sub WHERE callsign = $1 AND sub <> $2`, [u.callsign, u.sub]);
        }
        await db.query(
          `INSERT INTO account_cache (sub, callsign, callsign_verified, callsign_verified_method, name, role, banned, updated_at)
           VALUES ($1, COALESCE($2, ''), COALESCE($3, false), $4, $5, COALESCE($6, 'user'), COALESCE($7, false), now())
           ON CONFLICT (sub) DO UPDATE SET
             callsign = COALESCE($2, account_cache.callsign),
             callsign_verified = COALESCE($3, account_cache.callsign_verified),
             callsign_verified_method = CASE WHEN $3 IS NULL THEN account_cache.callsign_verified_method ELSE $4 END,
             name = COALESCE($5, account_cache.name),
             role = COALESCE($6, account_cache.role),
             banned = COALESCE($7, account_cache.banned),
             updated_at = now()`,
          [u.sub, u.callsign ?? null, u.callsign_verified ?? null, u.callsign_verified_method ?? null, u.name ?? null, u.role ?? null,
           e.type === "user.banned" ? true : e.type === "user.unbanned" ? false : (u.banned ?? null)],
        );
        // Callsign changed: personal listings under the old callsign no longer belong to the account.
        const old = prev.rows[0]?.callsign;
        if (u.callsign && old && old !== u.callsign) {
          await db.query(
            `UPDATE gateway SET hidden = true, hidden_reason = 'owner callsign changed'
              WHERE source = 'openrms' AND owner_sub = $1 AND owner_club_id IS NULL AND base_callsign <> $2`,
            [u.sub, u.callsign],
          );
          await db.query(
            `UPDATE gateway SET owner_sub = NULL, claimed_at = NULL, owner_comments = '', software = NULL, emcomm = '{}'::jsonb
              WHERE source = 'winlink' AND owner_sub = $1 AND owner_club_id IS NULL AND base_callsign <> $2`,
            [u.sub, u.callsign],
          );
        }
        break;
      }
      case "user.deleted": {
        const u = userOf(d);
        await db.query(`UPDATE api_key SET revoked_at = now() WHERE owner_sub = $1 AND revoked_at IS NULL`, [u.sub]);
        await db.query(`UPDATE watcher SET disabled = true, disabled_reason = 'account deleted', api_key_id = NULL WHERE owner_sub = $1`, [u.sub]);
        await db.query(
          `UPDATE gateway SET hidden = true, hidden_reason = 'owner account deleted' WHERE source = 'openrms' AND owner_sub = $1 AND owner_club_id IS NULL`,
          [u.sub],
        );
        await db.query(
          `UPDATE gateway SET owner_sub = NULL, claimed_at = NULL, owner_comments = '', software = NULL, emcomm = '{}'::jsonb
            WHERE source = 'winlink' AND owner_sub = $1 AND owner_club_id IS NULL`,
          [u.sub],
        );
        await db.query(`DELETE FROM account_club_member WHERE sub = $1`, [u.sub]);
        await db.query(`DELETE FROM account_cache WHERE sub = $1`, [u.sub]);
        break;
      }
      case "club.created":
      case "club.updated":
      case "club.verified": {
        const c = clubOf(d);
        if (c.callsign) await db.query(`UPDATE account_club SET callsign = callsign || '~' || id WHERE callsign = $1 AND id <> $2`, [c.callsign, c.id]);
        await db.query(
          `INSERT INTO account_club (id, callsign, name, verified, updated_at) VALUES ($1, COALESCE($2, ''), COALESCE($3, $2, ''), COALESCE($4, false), now())
           ON CONFLICT (id) DO UPDATE SET callsign = COALESCE($2, account_club.callsign),
             name = COALESCE($3, CASE WHEN account_club.name = '' THEN $2 END, account_club.name),
             verified = COALESCE($4, account_club.verified), updated_at = now()`,
          [c.id, c.callsign ?? null, c.name ?? null, e.type === "club.verified" ? (c.verified ?? true) : (c.verified ?? null)],
        );
        break;
      }
      case "club.deleted": {
        const c = clubOf(d);
        // The club's own listings go with it; its Winlink claims are released (the listings stay).
        await db.query(`DELETE FROM gateway WHERE source = 'openrms' AND owner_club_id = $1`, [c.id]);
        await db.query(
          `UPDATE gateway SET owner_sub = NULL, owner_club_id = NULL, claimed_at = NULL, owner_comments = '', software = NULL, emcomm = '{}'::jsonb
            WHERE source = 'winlink' AND owner_club_id = $1`,
          [c.id],
        );
        await db.query(`DELETE FROM account_club WHERE id = $1`, [c.id]);
        break;
      }
      case "club.member_added": {
        const m = memberOf(d);
        // Accounts includes the club's callsign and name; fall back to a placeholder that the
        // token or the reconcile fills in.
        const club = clubOf(d);
        const cs = typeof club.callsign === "string" && club.callsign ? club.callsign : null;
        if (cs) await db.query(`UPDATE account_club SET callsign = callsign || '~' || id WHERE callsign = $1 AND id <> $2`, [cs, m.clubId]);
        await db.query(
          `INSERT INTO account_club (id, callsign, name) VALUES ($1, COALESCE($2, '~' || $1), COALESCE($3, $2, ''))
           ON CONFLICT (id) DO UPDATE SET callsign = COALESCE($2, account_club.callsign),
             name = COALESCE($3, CASE WHEN account_club.name = '' THEN $2 END, account_club.name)`,
          [m.clubId, cs, club.name ?? null],
        );
        await db.query(
          `INSERT INTO account_club_member (club_id, sub, role, updated_at) VALUES ($1,$2,$3, now())
           ON CONFLICT (club_id, sub) DO UPDATE SET role = EXCLUDED.role, updated_at = now()`,
          [m.clubId, m.sub, m.role],
        );
        break;
      }
      case "club.member_removed": {
        const m = memberOf(d);
        await db.query(`DELETE FROM account_club_member WHERE club_id = $1 AND sub = $2`, [m.clubId, m.sub]);
        // Newer than any token issued before the removal, so an old token can't re-add the membership.
        await db.query(`UPDATE account_cache SET updated_at = now() WHERE sub = $1`, [m.sub]);
        break;
      }
      default:
        break; // unknown events are recorded and ignored
    }
  });
}

/** POST /api/v1/hooks/accounts: signed with `openrms-signature: t=…,v1=…` (identity.md §7). */
hookRoutes.post("/accounts", async (c) => {
  if (!env.ACCOUNTS_WEBHOOK_SECRET) return c.json({ error: "webhooks not configured" }, 404);
  const raw = await c.req.text();
  let e: AccountsEvent;
  try {
    e = verifyWebhook(raw, c.req.header("openrms-signature"), env.ACCOUNTS_WEBHOOK_SECRET);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 401);
  }
  if (!e.id || !e.type) return c.json({ error: "event needs id and type" }, 400);
  await apply(e);
  invalidateDirectory();
  invalidateSightings();
  return c.json({ ok: true });
});
