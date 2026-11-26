# Changelog

Notable changes to the Atlas API and feeds. The contract lives in openRMS-Spec `atlas/`.

## 2026-11-26 (API keys from Accounts)

### Changed (breaking)
- API keys are minted by openRMS Accounts (`ormk_…`, identity.md §5) and verified here. Atlas's
  own `orms_` and `ormsw_` keys stop working; production had none.
- `POST /api/v1/gateways/{id}/heartbeat` takes a key with `heartbeat` (Authorization: Bearer or
  x-api-key). Keys limited to some gateways (`gatewayIds`) no longer exist; a key works for every
  gateway its owner can manage.
- `POST /api/v1/watch/link` takes a `watch:ingest` key and binds it to the watcher; it no longer
  returns a key. Ingest needs a linked key (403 `not_linked` otherwise).
- `POST /api/v1/me/keys`, `DELETE /api/v1/me/keys/{id}` and `POST /api/v1/me/watchers/{id}/key`
  return 410 with the Accounts keys page. `GET /api/v1/me/keys` lists the caller's Atlas keys from
  Accounts. `DELETE /api/v1/me/watchers/{id}/key` unlinks keys instead of revoking.

### Added
- Key scopes per route: `gateways:read` (GET /me/gateways), `gateways:write` (create, edit,
  delete listings and details), `heartbeat` (heartbeat, still-on-air confirm), `watch:ingest`.
  Wrong scope: 403 with `WWW-Authenticate: Bearer error="insufficient_scope"`.
- `GET /.well-known/oauth-protected-resource` (RFC 9728) with `openrms_key_scopes`.
- Persisted key denylist (migration 0006 `revoked_key`, `watcher_key`), fed by `key.revoked` and a
  pull every 5 minutes; last use reported to Accounts in batches.

## 2026-11-26 (later)

### Changed (behavior)
- Service codes are visible to admins and superadmins only. Moderators lost `servicecode:view`.
- `PATCH /api/v1/admin/service-codes/{code}` creates the code if it doesn't exist.

### Added
- Search demand: searches for non-public codes are counted per code per day (migration 0005,
  `service_code_search`). No IPs are stored. `GET /api/v1/admin/service-codes/searches` lists codes
  with 3+ searcher-days in 90 days. The admin code list gains `owners`, `lastUsedAt` and `searchers`.

### Fixed
- The request log no longer writes query strings. It logs only method, path, status and time.
  It used to log full URLs, so `?serviceCode=` (including unlisted codes) ended up in the journal.

## 2026-11-26

### Changed (behavior)
- In public output (`/api/v1/gateways`, `/api/v1/gateways/{id}`, dumps), a channel's `serviceCode`
  and `feedServiceCode` are now `serviceCodes[0]`, the first code the request may see.
  `serviceCode` used to be the stored code. Both fields are **deprecated**: use `serviceCodes`.
  Owner endpoints (`/me/gateways`) still return the stored `serviceCode` plus `extraServiceCodes`.
- Channels under **unlisted** service codes are left out of every public output unless the request
  names the code exactly. A gateway whose channels are all unlisted is left out, and its detail
  is 404, unless the request names one of its codes.
- `/api/v1/stats` counts public codes only. `byServiceCode` and every total exclude unlisted listings.
- Compat feed: for Mercury, XARA and Data2G channels, only `PUBLIC` and `EMCOMM` are swapped for
  the mode's code. Custom group codes stay as typed (before, every code was swapped).
- Sysop service codes must be 1–16 letters or digits. Before, `-`, `_` and up to 32 characters
  were allowed.
- The Winlink import fetches only configured codes that are public; others are skipped and logged.
- The CSV dump's `service_code` column lists every visible code, space-separated.

### Added
- `service_code` table (migration 0004) with `public` / `unlisted` visibility. PUBLIC, EMCOMM,
  MERCURY, XARA and DATA2G are seeded public; other codes already in use start unlisted.
- `channel.extra_service_codes` (up to 8): `extraServiceCodes` on channel input and owner output.
  The compat feed lists a channel once per requested code it carries.
- `serviceCodes` on every channel in public output.
- `GET /api/v1/service-codes`: public codes with descriptions and gateway counts.
- `?serviceCode=` on `GET /api/v1/gateways/{id}`.
- Staff: `GET /api/v1/admin/service-codes` and `PATCH /api/v1/admin/service-codes/{code}`, with
  rbac `servicecode:view` (moderator and up) and `servicecode:edit` (admin and up). Audited.
- Per-IP limit on distinct non-public codes looked up per hour (`UNLISTED_CODES_PER_HOUR`,
  default 60; `429` + `Retry-After`). Repeating a code is free. At most 5 non-public codes per
  request (`400`). Client IP comes from `TRUSTED_IP_HEADERS`, honoured only from loopback.
  Such answers are sent `Cache-Control: private, no-store`. Repeated misses are logged as counts.

## 2026-11-25

### Changed (behavior)
- `GET /api/v1/gateways?serviceCode=` now matches each channel's `feedServiceCode`, the code
  the Winlink-compatible feed publishes it under. Before this it matched the stored
  `serviceCode`. A sysop-listed Mercury, XARA or Data2G channel stored as `PUBLIC` now matches
  `MERCURY`, `XARA` or `DATA2G`, not `PUBLIC`. Matching is case-insensitive. Only the Site used
  this filter.
- The Winlink import requests service codes `PUBLIC,MERCURY,XARA,DATA2G,EMCOMM` by default
  (`WINLINK_SERVICE_CODES`). It used to request `PUBLIC,MERCURY,EMCOMM`.

### Added
- `feedServiceCode` on every channel in `/api/v1/gateways` and `/api/v1/gateways/{id}`.
- `byServiceCode` (gateways per `feedServiceCode`) in `/api/v1/stats`.
- Modem `xara` (mode code 9006). Its compat rule is VARA strings under the forced service code `XARA`.
- Data2G now appears in the compat feed as `VARA` / `VARA 500` under the forced service code
  `DATA2G` (mode code 9002). Before this it was left out.
- The import maps Winlink VARA listings under `XARA` and `DATA2G` to those modems, the way it
  already mapped `MERCURY`.
