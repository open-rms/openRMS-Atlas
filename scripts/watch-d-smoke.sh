#!/usr/bin/env bash
# Watcher linking after the Accounts split (identity.md §5): the device flow runs in Accounts;
# the watcher then calls the Directory once with its device-flow token (aud = this Directory)
# to pick or create a watcher and receive its ormsw_ key.
set -uo pipefail
cd "$(dirname "$0")/.."
. scripts/lib.sh
forget N0WDA N0WDB
as N0WDA N0WDA '{"client_id":"openrms-watch","scope":"openid callsign"}'
as N0WDB N0WDB '{"client_id":"openrms-watch"}'

say "link"
check "no token: 401" 401 "$(code "${J[@]}" -X POST $B/api/v1/watch/link -d '{"name":"x"}')"
check "bad body: 400" 400 "$(code -H @$T/N0WDA "${J[@]}" -X POST $B/api/v1/watch/link -d '{}')"
R=$(curl -s -H @$T/N0WDA "${J[@]}" -X POST $B/api/v1/watch/link -d '{"name":"linked-sdr","gridsquare":"DN16"}')
K=$(echo "$R" | jq -r .key); WID=$(echo "$R" | jq -r .watcherId)
check "new watcher created, key returned" "ormsw_/linked-sdr" "${K:0:6}/$(echo "$R" | jq -r .name)"
check "listed with GET /me/watchers (same token)" "linked-sdr" "$(curl -s -H @$T/N0WDA $B/api/v1/me/watchers | jq -r '.watchers[0].name')"
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
up() { echo "{\"type\":\"status\",\"id\":\"01JD$(date +%s%N)\",\"ts\":\"$NOW\"}" | code -H "x-api-key: $1" --data-binary @- $B/api/v1/watch/ingest; }
check "the key uploads" 200 "$(up "$K")"
R2=$(curl -s -H @$T/N0WDA "${J[@]}" -X POST $B/api/v1/watch/link -d "{\"watcherId\":\"$WID\"}")
K2=$(echo "$R2" | jq -r .key)
check "re-linking an existing watcher rotates its key" "$WID" "$(echo "$R2" | jq -r .watcherId)"
check "old key stops working" 401 "$(up "$K")"
check "new key works" 200 "$(up "$K2")"
check "another account can't link to N0WDA's watcher" 404 "$(code -H @$T/N0WDB "${J[@]}" -X POST $B/api/v1/watch/link -d "{\"watcherId\":\"$WID\"}")"
psql "$DB" -qc "UPDATE watcher SET disabled = true WHERE id = '$WID'" >/dev/null
check "a disabled watcher can't be re-linked" 403 "$(code -H @$T/N0WDA "${J[@]}" -X POST $B/api/v1/watch/link -d "{\"watcherId\":\"$WID\"}")"
forget N0WDA N0WDB
finish
