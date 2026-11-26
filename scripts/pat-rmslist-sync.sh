#!/usr/bin/env bash
# pat-rmslist-sync: fill Pat's gateway list from an openRMS Directory.
#
# Pat v1.0.x fetches its list from a fixed address (api.winlink.org) and caches
# it as $XDG_DATA_HOME/pat/rmslist.json (rmslist-CODE1-CODE2.json when
# service_codes is not just PUBLIC). Pat reads that cache instead of
# downloading when it exists, so writing our Winlink-compatible feed there makes
# `pat rmslist`, Pat's web UI and EmComm Tools' et-winlink-data (re-run it
# afterwards) use the openRMS list. The feed already includes Winlink's
# listings, plus gateways on open modes.
#
# Note: `pat rmslist --force-download` (or Pat's "update" button) replaces the
# file with Winlink's list again. PatMenu's getardoplist (73 Linux) does exactly
# that, so it needs a change before it shows openRMS gateways. Re-run this
# script (e.g. from cron) to restore the file.
#
# Usage: pat-rmslist-sync.sh [--url https://directory.example] [--codes PUBLIC,MERCURY] [--dry-run]
# Env:   OPENRMS_DIRECTORY_URL, PAT_CONFIG (path to Pat's config.json)
set -euo pipefail

URL="${OPENRMS_DIRECTORY_URL:-http://localhost:8787}"
CODES=""
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --codes) CODES="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

DATA="${XDG_DATA_HOME:-$HOME/.local/share}/pat"
CONF="${PAT_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/pat/config.json}"

# Use Pat's own service_codes so the file name matches what Pat looks for.
if [ -z "$CODES" ]; then
  if [ -f "$CONF" ] && command -v jq >/dev/null; then
    CODES=$(jq -r '(.service_codes // ["PUBLIC"]) | join(",")' "$CONF")
  fi
  CODES="${CODES:-PUBLIC}"
fi

IFS=',' read -r -a CODE_ARR <<< "$CODES"
if [ "${#CODE_ARR[@]}" -eq 1 ] && [ "${CODE_ARR[0]}" = "PUBLIC" ]; then
  FILE="rmslist.json"
else
  FILE="rmslist-$(IFS=-; echo "${CODE_ARR[*]}").json"
fi

QS="HistoryHours=48"
for c in "${CODE_ARR[@]}"; do QS="$QS&ServiceCodes=$c"; done

mkdir -p "$DATA"
TMP=$(mktemp "$DATA/.rmslist.XXXXXX")
trap 'rm -f "$TMP"' EXIT
curl -fsS --max-time 60 "$URL/export/pat/rmslist.json?$QS" -o "$TMP"

# Refuse to install something Pat cannot read.
if command -v jq >/dev/null; then
  jq -e '.Gateways | type == "array"' "$TMP" >/dev/null || { echo "bad response from $URL" >&2; exit 1; }
  N=$(jq '[.Gateways[].GatewayChannels[]] | length' "$TMP")
else
  grep -q '"Gateways"' "$TMP" || { echo "bad response from $URL" >&2; exit 1; }
  N="?"
fi

if [ "$DRY" = 1 ]; then
  echo "would write $N channels to $DATA/$FILE"
  exit 0
fi
mv "$TMP" "$DATA/$FILE"
trap - EXIT
echo "wrote $N channels from $URL to $DATA/$FILE"
