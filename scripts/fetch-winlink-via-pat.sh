#!/usr/bin/env bash
# DEVELOPMENT ONLY: refresh the local Winlink gateway snapshot by letting the installed Pat
# download its own list (Pat uses the key Winlink issued to Pat, for Pat). Production uses the
# Atlas's own key (WINLINK_API_KEY) instead. Runs Pat in a throwaway data dir, so the
# user's own Pat cache and config are never touched.
#
# Usage: [FORCE=1] scripts/fetch-winlink-via-pat.sh [OUT]   (default backups/winlink-gateway-status.latest.json)
# Skips the download when the snapshot is less than 50 minutes old, unless FORCE=1.
# Service codes: WINLINK_SERVICE_CODES (default PUBLIC,MERCURY,XARA,DATA2G,EMCOMM), merged into one file.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-backups/winlink-gateway-status.latest.json}
CODES=${WINLINK_SERVICE_CODES:-PUBLIC,MERCURY,XARA,DATA2G,EMCOMM}
command -v pat >/dev/null || { echo "pat not installed" >&2; exit 1; }
# Dev servers restart often; don't download again if the snapshot is fresh (FORCE=1 overrides).
if [ -z "${FORCE:-}" ] && [ -n "$(find "$OUT" -mmin -50 2>/dev/null)" ]; then
  echo "snapshot is less than 50 minutes old, not downloading"; exit 0
fi
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$W"/{data,config,state}/pat "$(dirname "$OUT")"
export XDG_DATA_HOME=$W/data XDG_CONFIG_HOME=$W/config XDG_STATE_HOME=$W/state
IFS=',' read -r -a list <<< "$CODES"
for code in "${list[@]}"; do
  printf '{"mycall":"N0CALL","locator":"DN16","service_codes":["%s"]}' "$code" > "$W/config/pat/config.json"
  timeout 120 pat rmslist --force-download >/dev/null 2>&1 || { echo "pat download failed for $code" >&2; exit 1; }
done
node - "$W/data/pat" "$OUT.tmp" <<'JS'
const fs = require("fs"), path = require("path");
const [dir, out] = process.argv.slice(2);
const merged = new Map();
for (const f of fs.readdirSync(dir).filter((n) => /^rmslist.*\.json$/.test(n))) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  for (const g of d.Gateways ?? []) {
    const cur = merged.get(g.Callsign);
    if (!cur) { merged.set(g.Callsign, g); continue; }
    const seen = new Set(cur.GatewayChannels.map((c) => `${c.Frequency}|${c.SupportedModes}|${c.ServiceCode}`));
    for (const c of g.GatewayChannels) if (!seen.has(`${c.Frequency}|${c.SupportedModes}|${c.ServiceCode}`)) cur.GatewayChannels.push(c);
  }
}
if (merged.size === 0) { console.error("empty list, keeping the previous snapshot"); process.exit(1); }
fs.writeFileSync(out, JSON.stringify({ Gateways: [...merged.values()], ResponseStatus: {} }));
console.log(`${merged.size} gateways`);
JS
mv "$OUT.tmp" "$OUT"
