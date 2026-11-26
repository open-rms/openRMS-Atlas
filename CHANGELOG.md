# Changelog

Notable changes to the Atlas API and feeds. The contract lives in openRMS-Spec `atlas/`.

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
