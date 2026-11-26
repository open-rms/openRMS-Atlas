// Which callsigns a caller may act for: their own, plus every club they belong to.
// Club membership comes from the account cache (which webhooks keep current), so a member
// removed in Accounts loses access here immediately, even with an older token.
import { q } from "../db/pool.js";
import type { Viewer } from "./identity.js";

export interface ManagedCallsign {
  callsign: string;
  clubId: string | null; // null: the account's own callsign
  clubName: string | null;
  role: "self" | "owner" | "admin" | "member";
  verified: boolean;
}

export async function managedCallsigns(v: Pick<Viewer, "sub" | "callsign" | "callsignVerified">): Promise<ManagedCallsign[]> {
  const { rows } = await q<{ id: string; name: string; callsign: string; role: string; verified: boolean }>(
    `SELECT c.id, c.name, c.callsign, m.role, c.verified FROM account_club_member m JOIN account_club c ON c.id = m.club_id
      WHERE m.sub = $1 ORDER BY c.callsign`,
    [v.sub],
  );
  return [
    { callsign: v.callsign, clubId: null, clubName: null, role: "self", verified: v.callsignVerified },
    ...rows.map((r) => ({ callsign: r.callsign, clubId: r.id, clubName: r.name, role: r.role as ManagedCallsign["role"], verified: r.verified })),
  ];
}

/** True when the caller may manage a gateway row (own listing, or a member of its club). */
export async function canManageGateway(v: { sub: string }, g: { owner_sub: string | null; owner_club_id: string | null }): Promise<boolean> {
  if (g.owner_club_id) {
    const { rowCount } = await q(`SELECT 1 FROM account_club_member WHERE club_id = $1 AND sub = $2`, [g.owner_club_id, v.sub]);
    return !!rowCount;
  }
  return g.owner_sub === v.sub;
}
