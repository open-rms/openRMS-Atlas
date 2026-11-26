import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().default("postgres://openrms:openrms@127.0.0.1:5442/openrms"),
  PORT: z.coerce.number().default(8787),
  /**
   * Interface to listen on. Default 127.0.0.1: only a reverse proxy on the same host can reach
   * the API. Use 0.0.0.0 (or ::) only when something outside the host must connect directly,
   * e.g. a container whose proxy runs elsewhere.
   */
  HOST: z.string().default("127.0.0.1"),
  /** Public origin of this API (links in API responses and the compat feed). */
  PUBLIC_URL: z.string().default("http://localhost:8787"),
  /** Comma-separated origins allowed to call the API from a browser (the Site). */
  TRUSTED_ORIGINS: z.string().default("http://localhost:5173"),
  /**
   * openRMS-Accounts issuer(s) whose tokens are trusted, comma-separated (identity.md §1).
   * Development may add the test issuer (scripts/dev-issuer.ts, http://localhost:8799). Never in production.
   */
  OPENRMS_ISSUER: z.string().default("http://localhost:8789"),
  /** This service's audience: tokens must be issued for it (identity.md §3). */
  OPENRMS_AUDIENCE: z.string().default("http://localhost:8787"),
  /** Shared secret for Accounts webhooks (identity.md §7). Webhooks are refused when unset. */
  ACCOUNTS_WEBHOOK_SECRET: z.string().min(16).optional(),
  /** Atlas's OAuth client at Accounts (client credentials), for the timed reconcile. */
  ACCOUNTS_CLIENT_ID: z.string().optional(),
  ACCOUNTS_CLIENT_SECRET: z.string().optional(),
  ACCOUNTS_RECONCILE_MINUTES: z.coerce.number().min(1).default(10),

  /** Your own api.winlink.org access key. Never reuse a key issued to another program. */
  WINLINK_API_KEY: z.string().optional(),
  /** Local gateway/status.json(.gz) file to import instead of calling api.winlink.org (development). */
  WINLINK_FIXTURE: z.string().optional(),
  /** Development: command run before each fixture import to refresh it (e.g. scripts/fetch-winlink-via-pat.sh). */
  WINLINK_FIXTURE_REFRESH_CMD: z.string().optional(),
  WINLINK_SERVICE_CODES: z.string().default("PUBLIC,MERCURY,XARA,DATA2G,EMCOMM"),
  WINLINK_POLL_MINUTES: z.coerce.number().min(15).default(60),
  /** Include Winlink-sourced listings in public API, dumps and the compat feed. */
  WINLINK_PUBLISH: z.stringbool().default(true),
  /** Only owner listings with a verified callsign go into the Winlink-compatible feed. */
  COMPAT_REQUIRE_VERIFIED: z.stringbool().default(false),

  /** A heartbeat older than this marks an automated gateway stale. */
  STALE_AFTER_HOURS: z.coerce.number().default(3),
  /** A hand-confirmed listing (no heartbeat) stays listed for this many days. */
  CONFIRMED_LISTING_DAYS: z.coerce.number().default(45),
});

export const env = schema.parse(process.env);
export type Env = typeof env;
