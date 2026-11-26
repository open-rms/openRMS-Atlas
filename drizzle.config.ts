import { defineConfig } from "drizzle-kit";

// Drizzle manages openRMS's own tables. Better Auth's tables (user, session, account,
// verification, apikey, organization, member, invitation) are created and migrated by
// Better Auth itself, so they are excluded here.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: process.env.DRIZZLE_OUT ?? "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://openrms:openrms@127.0.0.1:5442/openrms" },
  tablesFilter: ["gateway", "channel", "import_run", "abuse_report", "audit_log", "watcher", "watch_event", "site_setting", "callsign_optout", "account_cache", "account_club", "account_club_member", "account_event", "api_key"],
  strict: true,
  verbose: true,
});
