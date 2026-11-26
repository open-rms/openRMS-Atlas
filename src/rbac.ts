// What each site role may do in Atlas. The role itself comes from the caller's
// openRMS-Accounts token (identity.md §4); who holds which role, and the rank rules for
// assigning roles, live in Accounts.
//
//   superadmin, admin  everything here, including the client-callsign setting and the audit log
//   moderator          hide listings, resolve reports, moderate watchers, manage opt-outs, view imports,
//                      see every service code (including unlisted ones)
//   user               nothing beyond their own and their clubs' gateways and watchers

export const statements = {
  gateway: ["hide", "edit-any"],
  report: ["list", "resolve"],
  import: ["view", "run"],
  audit: ["view"],
  watcher: ["list", "disable", "purge", "view-clients"],
  setting: ["edit"],
  optout: ["manage"],
  servicecode: ["view", "edit"],
} as const;

type Statements = typeof statements;
export type Perms = { [K in keyof Statements]?: readonly Statements[K][number][] };
export type RoleName = "user" | "moderator" | "admin" | "superadmin";
export const RANK: Record<RoleName, number> = { user: 0, moderator: 1, admin: 2, superadmin: 3 };

const moderator: Perms = {
  gateway: ["hide"],
  report: ["list", "resolve"],
  import: ["view"],
  watcher: ["list", "disable", "purge"],
  optout: ["manage"],
  servicecode: ["view"],
};
const admin: Perms = {
  gateway: ["hide", "edit-any"],
  report: ["list", "resolve"],
  import: ["view", "run"],
  audit: ["view"],
  watcher: ["list", "disable", "purge", "view-clients"],
  setting: ["edit"],
  optout: ["manage"],
  servicecode: ["view", "edit"],
};
const ROLES: Record<RoleName, Perms> = { user: {}, moderator, admin, superadmin: admin };

export function roleOf(role: string | null | undefined): RoleName {
  const names = (role ?? "user").split(",").map((r) => r.trim()) as RoleName[];
  return names.filter((r) => r in RANK).sort((a, b) => RANK[b] - RANK[a])[0] ?? "user";
}

/** Does `role` hold every action listed in `perms`? */
export function can(role: string | null | undefined, perms: Perms): boolean {
  const granted = ROLES[roleOf(role)];
  return Object.entries(perms).every(([res, actions]) =>
    (actions as readonly string[]).every((a) => ((granted[res as keyof Perms] ?? []) as readonly string[]).includes(a)),
  );
}

/** The role's permissions, for the Site to decide what to show. */
export function permissionsOf(role: string | null | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [res, actions] of Object.entries(ROLES[roleOf(role)])) if (actions?.length) out[res] = [...actions];
  return out;
}
