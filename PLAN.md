# openRMS-Directory

**Role:** the open, **API-first** registry of gateways: every mode, real waveforms, emcomm
readiness, live status, downloadable for offline use. Designed so other apps (Pat, Winlink
Express plug-ins, mapping tools, emcomm planners) adopt it.
**Binary:** `openrms-directory` · **License:** AGPL-3.0-or-later

## API (OpenAPI 3.1 in openRMS-Spec; Swagger UI and Redoc public)

- `GET /gateways`: filter by mode, band or frequency, grid or radius, service code, capability,
  emcomm attributes, online status.
- `GET /gateways/{id}`, `GET /gateways/{id}/channels`, `GET /gateways/{id}/status`
- `GET /dumps/latest.{json,csv,geojson,sqlite}`: signed full exports, with ETags and
  `?since=` deltas.
- `GET /export/pat`: a channel list in a form Pat can use.
- Write (authenticated): accounts, gateway CRUD, API keys, `POST /gateways/{id}/heartbeat`.
- Generated clients: Rust (`openrms-dirclient`), TypeScript, Python.

## Data model

- **Station:** callsign, sysop contact (private by default), grid, location precision chosen
  by the owner.
- **Channel:** dial and center frequency, bandwidth, **modem + version (the real waveform)**,
  how it appears on Winlink (if at all), hours, service codes, antenna.
- **Capabilities:** modes, multimode listening, scanning, back ends (CMS / local / Exchange),
  software and version.
- **Emcomm:** backup power (battery, solar, generator), runtime hours, off-grid capable, last
  tested, served agencies and ARES/RACES affiliation, contact for activation.
- **Status:** last heartbeat, online/stale/offline, current channel, busy or in session.

## Trust

- Callsign proof: LoTW certificate signature (strong), licensing-database lookup plus email, or
  an on-air challenge code.
- API keys per gateway, scoped to heartbeat only. Signed heartbeats.
- Listings are marked stale after N hours without a heartbeat and hidden after M (both
  configurable).
- Abuse reporting and moderator tools.

## Resilience

Signed dumps let anyone mirror the directory. Federation between directory instances comes
later. The gateway caches the latest dump so it works offline.

## Identity moving to openRMS-Accounts (2026-11-25)

Decided: identity is extracted into openRMS-Accounts (`auth.openrms.dev`, spec
`openRMS-Spec/accounts/identity.md`). **AC1 done on the Directory and Site side (2026-11-25):**
Better Auth removed from the Directory; JWT verification via `@openrms/service-auth`; own
`api_key` table (69 existing keys imported, hashes unchanged); account cache fed by webhooks,
tokens and a 10-minute reconcile; migrations 0002/0003; `POST /api/v1/watch/link`; Site signs in
at Accounts and sends Bearer tokens. Verified end to end against the running Accounts service
(real token, real `user.updated` webhook, reconcile). Old Better Auth tables dropped from the dev
database 2026-11-26 (user-approved; dump in `backups/`). Left: Accounts' own UI takes over the
account pages later.

- **Moves to Accounts:** users, sessions, sign-up with callsign, callsign verification fields,
  clubs (organizations), site roles and the rank guard, device authorization (the `/link` page,
  `device_link`, `/api/v1/watch/link/complete`).
- **Stays here:** gateways, channels, claims, watchers and watcher events, sightings, the
  Winlink import and compat feed, `orms_`/`ormsw_` keys, the Directory's own permission table
  (`gateway:hide`, `watcher:purge`, …), the audit log, site settings and opt-outs.
- **Becomes:** JWT verification against Accounts' JWKS (`aud` = the Directory's audience);
  `owner_user_id`/`owner_org_id` → `owner_sub`/`owner_club_id` (same ids); a local cache of
  account facts the Directory uses in queries (callsign, verified, banned; for dedupe, sightings
  `confirmed`, contributors) kept fresh by Accounts webhooks plus a periodic reconcile; club
  delete and callsign change handled from webhooks; API keys in the Directory's own table
  (existing hashes imported as-is, no rotation). Watcher linking becomes one call with the
  device token (aud = Directory): `POST /api/v1/watch/link {watcherId} | {name, gridsquare?}`
  → `{key, watcherId, name}`, plus `GET /api/v1/me/watchers` (identity.md §5). Host and
  audience: `https://directory.openrms.dev` (user's choice, one subdomain per project; the
  Site is `openrms.dev`, Accounts `auth.openrms.dev`).
- Not adopted: a shared-secret introspection endpoint and `ormsr_` keys in the Directory
  (briefly added for openRMS-Rigs, then removed the same day; Rigs verifies JWTs and mints its
  own keys).



Drizzle for openRMS's own tables: schema in `src/db/schema.ts`, versioned SQL migrations in
`drizzle/` applied at startup. Better Auth keeps migrating its own tables. Chosen for
reviewable, repeatable deployments; queries move from raw SQL to Drizzle gradually.

## Stack (changed 2026-11-25)

**TypeScript** (Node, Hono) with **Better Auth** for accounts, sessions and API keys, on
PostgreSQL. This replaces the earlier Rust/axum plan: Better Auth is TypeScript-only, and the
directory is a web service where its account, API-key and admin features save the most work.
Rust stays the language for everything that touches a radio. Distance filtering runs in
memory for now; PostGIS only when the listing count needs it. Self-hosted SQLite is deferred.

Database (2026-11-25): own database and role `openrms_directory` on the shared Postgres
(`db/bootstrap.sql`). The openrms.dev deployment uses a managed PostgreSQL service (umbrella `PLAN.md`, Database); the
code stays provider-neutral. The local dev database is still named `openrms` in the Docker
container.

## Phases

- **P3a:** read API, Swagger, dumps, Winlink import, compat feed. **Done (alpha) 2026-11-25.**
- **P3b:** accounts with required callsign, API keys, heartbeats, stale handling, moderator
  callsign verification. **Done (alpha) 2026-11-25.** Still open: LoTW / on-air callsign proof,
  signed dumps and heartbeats, SMTP for email verification, rate limits on public reads.
- **P4:** Gateway self-registration.
- **Later:** federation and mirrors, webhooks and a change stream.

## Winlink list (changed 2026-11-25)

Earlier this plan ruled out copying Winlink's list. **Reversed:** the directory now imports
api.winlink.org's gateway list on a timer, server side, with **our own access key** (never
Pat's). Every row is tagged `source = winlink`. An owner listing replaces the Winlink copy of
the same callsign. `WINLINK_PUBLISH=false` drops them from all outputs if Winlink's terms
require it. Getting the key and checking the terms is an open task for the maintainer.

## Claiming Winlink listings (2026-11-25)

A signed-up sysop can claim the Winlink listings under their callsign and add comments,
software and emcomm readiness. Winlink stays the source of channels, location and status; the
added details live in columns the import never writes, show on the site and in the API, and
stay out of the compat feed. Claims by unverified accounts are allowed and labelled as such.

## Clubs and extra callsigns (2026-11-25)

A club call (or special-event or second call) is a Better Auth organization holding that
callsign. Members manage its gateways from their own accounts; owners and admins manage the
member list. New club callsigns work immediately and show as unverified until a moderator
confirms trusteeship.

## Staff roles (2026-11-25)

RBAC on Better Auth access control: superadmin, admin, moderator, user, with a rank rule
(act only on lower ranks, assign only lower roles) enforced on our routes and on Better Auth's
admin endpoints, plus an audit log. Next: callsign verification and lookup (license databases,
QRZ/HamQTH, LoTW certificate, on-air code) feeding `callsignVerifiedMethod`.

## Winlink-compatible feed

`/gateway/status.json` returns api.winlink.org's shape, so existing clients need no code change.
Pat reads its cached list, so `pat-rmslist-sync.sh` puts our feed there, and EmComm Tools reads
the same file. 73 Linux's PatMenu forces a fresh download, so it needs a PatMenu change. Details: `openRMS-Spec/directory/winlink-compat.md`. Next step: propose an
upstream Pat option for the list URL.
