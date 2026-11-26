# openRMS-Directory

**Provides:** `openrms-directory`, the open, API-first registry of radio email gateways on every
mode (Winlink's list plus sysop-listed gateways on Mercury, Data2G, modem73, ION HF…), with
API keys, heartbeats, watcher evidence, dumps, and a **Winlink-compatible feed** that Pat,
EmComm Tools and 73 Linux can read. · **Consumes:** PostgreSQL; **openRMS-Accounts** for
identity (JWTs, webhooks, service API); optionally the api.winlink.org gateway list (your own key). · **Status:** alpha. · **License:** AGPL-3.0-or-later.

Spec: `../openRMS-Spec/directory/` (`openapi.yaml`, `modes.md`, `winlink-compat.md`).
Identity: `../openRMS-Accounts` (`../openRMS-Spec/accounts/identity.md`): sign-up, callsigns,
clubs and staff roles live there. Website: `../openRMS-Site`.

## Quick start

```sh
docker compose up -d          # Postgres 18 on 127.0.0.1:5442
cp .env.example .env          # issuer, audience, webhook secret, Accounts client (see below)
pnpm install                  # links @openrms/service-auth from ../openRMS-Accounts
pnpm dev                      # migrates, starts the Winlink poller and account reconcile, serves :8787
pnpm test                     # unit tests, including the real `pat` binary when installed

# Smoke tests use a local test issuer instead of Accounts (trusted only in development):
pnpm exec tsx --env-file=.env scripts/dev-issuer.ts &   # :8799
scripts/smoke.sh              # gateways, keys, heartbeats, compat feed, claims, clubs (33)
scripts/identity-smoke.sh     # tokens, staff permissions, webhooks, bans, callsign changes (31)
scripts/watch-smoke.sh        # watcher keys, ingest, callsign list, moderation (26)
scripts/watch-b-smoke.sh      # sightings, heardOnAir, contributors (17)
scripts/watch-c-smoke.sh      # events, live stream, client-callsign privacy (15)
scripts/watch-d-smoke.sh      # watcher linking with a device-flow token (10)
```

`.env.example` imports a bundled Winlink sample (`fixtures/`, from Pat's source) for
development. It dates from 2026-11-01, so those gateways show as offline and drop out of the
48-hour compat feed. That is expected.

## Endpoints

| Path | What |
|---|---|
| `GET /api/v1/gateways` | filter by `modem, band, serviceCode, status, source, q, grid, radiusKm` |
| `GET /api/v1/gateways/{id or callsign}` · `/api/v1/modems` · `/api/v1/stats` | |
| `GET /api/v1/dumps/latest.{json,geojson,csv}` | full exports with ETag |
| `GET\|POST /gateway/status.json` | **Winlink-compatible** (same keys and parameters as api.winlink.org) |
| `GET /export/pat/rmslist.json` | the same feed, as a file for Pat's cache |
| `/api/v1/me/gateways` | list, create, update, delete, confirm your own and your clubs' gateways (Bearer token) |
| `/api/v1/me/keys` | your gateway keys (`orms_`): create (optionally limited to some gateways), list, revoke |
| `/api/v1/me/watchers`, `…/{id}/key` | your openRMS-Watch receivers and their `ormsw_` upload keys (minted server-side, one per watcher) |
| `POST /api/v1/watch/ingest` | watcher NDJSON upload (frame, attempt, coverage, status; idempotent by event id) |
| `GET /api/v1/watch/sightings` | stations heard on the air, matched to listings (`unique`/`ambiguous`/`unknown`), `single`/`confirmed`/`called` |
| `GET /api/v1/watch/contributors?days=7` | public watchers active recently, with listening hours, bands, live flag |
| `GET /api/v1/watch/events`, `GET /api/v1/watch/stream` (SSE) | public projection of watcher frames; client callsigns per the admin toggle and opt-out list |
| `POST /api/v1/watch/link` | watcher linking: with its device-flow token (device flow at Accounts), pick or create a watcher and get its `ormsw_` key |
| `POST /api/v1/hooks/accounts` | Accounts webhooks (signed), keeping the local account cache current |
| `GET /api/v1/watch/callsigns` | every listed callsign with its Mercury CRC16 and all Mercury dial frequencies (ETag) |
| `/api/v1/me/claimable`, `/api/v1/me/gateways/{id}/claim\|details\|release` | claim a Winlink listing under your callsign and add comments, software, emcomm readiness |
| `POST /api/v1/gateways/{id}/heartbeat` | gateway software, `x-api-key` |
| `/api/v1/admin/*` | staff (role from the token): hide listings, reports, imports, watchers, settings, opt-outs, audit log |
| `/docs` | Swagger UI |

## Rules the code enforces

- **Identity** is an openRMS-Accounts access token (`Authorization: Bearer`), verified offline
  against the issuer's JWKS (`OPENRMS_ISSUER`) with audience `DIRECTORY_AUDIENCE`. Third-party
  client tokens never carry staff power. Owners are stored as Accounts ids (`owner_sub`,
  `owner_club_id`).
- **Account cache** (`account_cache`, `account_club`, `account_club_member`): facts about other
  accounts used inside queries (dedupe, club verification, sightings `confirmed`, contributors)
  and checked on every write (bans, club membership). Fed by webhooks, by each caller's own
  token (only when newer than the cache, so a webhook removal beats an older token), and by a
  timed reconcile over Accounts' service API.
- A gateway's base callsign must be the caller's callsign or one of their clubs' (any SSID).
  Staff with `gateway:edit-any` are exempt.
- Keys are the Directory's own (`api_key`): kind fixed at creation, stored hashed, per-kind hourly
  rate limit, refused while the owner is banned. A key limited to some gateways only works for those.
- Every row has `source` = `openrms` or `winlink`. A listing by a **verified** owner replaces
  the Winlink copy of the same callsign. An unverified one is shown next to it
  (`unverifiedConflict`) and kept out of the compat feed. `WINLINK_PUBLISH=false` drops Winlink
  rows entirely; `COMPAT_REQUIRE_VERIFIED=true` keeps all unverified listings out of the feed.
- A Winlink listing can be claimed by the account whose callsign is its base callsign, and
  never taken from another account. The import never writes the claim columns
  (`owner_sub`, `owner_club_id`, `owner_comments`, `emcomm`, `software`), so details survive every refresh.
  Details show on the site and in the API only; the compat feed keeps Winlink's own data.
  Releasing a claim deletes the added details.
- **Clubs** are managed in openRMS-Accounts. Every member can list, claim and edit the club
  callsign's gateways. `club.deleted` removes the club's listings and releases its Winlink
  claims; `club.member_removed` ends that member's access at once.
- A callsign change (`user.updated`) hides the account's personal listings under the old
  callsign and releases its personal Winlink claims; `user.banned` blocks its API use and keys;
  `user.deleted` revokes its keys and hides its listings.
- The Winlink import refuses a response that is empty or less than half the previous run
  (`pnpm cli import-winlink --force` overrides).
- Compat feed: Mercury appears as `VARA` under service code `MERCURY` (never `PUBLIC`).
  Modes no client can dial (Data2G etc.) are left out. `SupportedModes` is never empty.

## Database and migrations (Drizzle)

PostgreSQL. openRMS's own tables are defined in `src/db/schema.ts` (Drizzle) and changed
through versioned SQL migrations in `drizzle/`, applied by `src/migrate.ts` at startup (and
`pnpm migrate`), followed by seed rows. Identity tables live in openRMS-Accounts' database.
Migration 0002 copied owner ids to `*_sub` columns, seeded the account cache and imported the
old Better Auth keys with their hashes unchanged; 0003 dropped the old columns. The old Better
Auth tables were dropped from the dev database on 2026-11-26 after Accounts imported them
(backup: `backups/better-auth-tables-20261126T014246Z.sql`, git-ignored). Migrations still run
on a database that has them (0000's foreign keys to them are conditional).

```sh
# change src/db/schema.ts, then:
pnpm db:generate      # writes drizzle/NNNN_*.sql; review it and commit it with the code
pnpm migrate          # apply (also happens on server start)
pnpm db:check         # migration history is consistent
```

Deploying an update is: new code plus its migration files, then start; the server applies
pending migrations before listening. New code uses the typed client in `src/db/index.ts`;
older routes still use raw SQL (`src/db/pool.ts`) and move over gradually. A database created
before Drizzle was adopted is marked as at the baseline automatically.

## Staff permissions

The site role (`user`, `moderator`, `admin`, `superadmin`) comes from the caller's Accounts
token; who holds which role, and the rank rules for assigning roles, live in openRMS-Accounts.
`src/rbac.ts` says what each role may do here:

| Role | Can |
|---|---|
| `admin`, `superadmin` | everything below, plus edit any listing, run the Winlink import, the client-callsign setting, see client callsigns, the audit log |
| `moderator` | hide listings, resolve reports, view imports, disable and purge watchers, manage opt-outs |
| `user` | their own and their clubs' gateways, watchers and keys |

Staff actions go to `audit_log` (`actor_sub`). To add a permission: add the action to
`statements`, grant it in the role table, guard the route with `need({ resource: ["action"] })`.

## Pat, 73 Linux, EmComm Tools

Pat v1.0.1 has the Winlink address hard-coded, but reads its cached list
(`$XDG_DATA_HOME/pat/rmslist[-CODES].json`) when present. `scripts/pat-rmslist-sync.sh` writes
our feed there, and Pat's web UI and `pat rmslist` use it. EmComm Tools' `et-winlink-data`
reads the same file (re-run it after a sync; it ships a prebuilt CSV). **73 Linux's PatMenu
does not pick it up yet:** its `getardoplist` calls `pat rmslist --force-download`, which skips
the cache and re-downloads Winlink's list. That needs a small PatMenu change or an upstream
Pat option for the list URL. `test/compat.test.ts` checks that `pat rmslist`
prints byte-identical output for our re-serialization of a 2,125-gateway Winlink sample and for
the original.

## Production notes

- **Winlink data:** get your own api.winlink.org access key from the Winlink Development Team
  and set `WINLINK_API_KEY`. Do not reuse Pat's key. Republishing their list is subject to their
  terms; `WINLINK_PUBLISH=false` turns it off without code changes.
- **Identity:** `OPENRMS_ISSUER=https://auth.openrms.dev` (never the dev test issuer),
  `DIRECTORY_AUDIENCE=https://directory.openrms.dev`, `ACCOUNTS_WEBHOOK_SECRET` (from
  `pnpm cli add-webhook directory https://directory.openrms.dev/api/v1/hooks/accounts` in
  openRMS-Accounts), `ACCOUNTS_CLIENT_ID`/`ACCOUNTS_CLIENT_SECRET` for the reconcile.
- The Site calls this API at `https://directory.openrms.dev` with Bearer tokens (no cookies);
  set `TRUSTED_ORIGINS=https://openrms.dev` for CORS.
- `pnpm build && pnpm start` runs the compiled server.
