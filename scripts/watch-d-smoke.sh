#!/usr/bin/env bash
# Watcher linking with an Accounts API key (identity.md §5.6): openRMS Watch mints a renewable
# watch:ingest key at Accounts through the device flow, then binds it to a watcher here with
# POST /watch/link (Atlas records jti → watcher; nothing is minted at Atlas).
set -uo pipefail
cd "$(dirname "$0")/.."
. scripts/lib.sh
forget N0WDA N0WDB
as N0WDA N0WDA '{"client_id":"openrms-watch","scope":"openid callsign"}'
KA=$(key N0WDA watch:ingest '{"renewable":true}')
KB=$(key N0WDB watch:ingest)

say "link"
check "no key: 401" 401 "$(code "${J[@]}" -X POST $B/api/v1/watch/link -d '{"name":"x"}')"
check "a sign-in token isn't enough: 401 key_required" key_required "$(curl -s -H @$T/N0WDA "${J[@]}" -X POST $B/api/v1/watch/link -d '{"name":"x"}' | jq -r .code)"
check "a key without watch:ingest: 403" 403 "$(code -H "Authorization: Bearer $(key N0WDA heartbeat)" "${J[@]}" -X POST $B/api/v1/watch/link -d '{"name":"x"}')"
check "bad body: 400" 400 "$(code -H "Authorization: Bearer $KA" "${J[@]}" -X POST $B/api/v1/watch/link -d '{}')"
R=$(curl -s -H "Authorization: Bearer $KA" "${J[@]}" -X POST $B/api/v1/watch/link -d '{"name":"linked-sdr","gridsquare":"DN16"}')
WID=$(echo "$R" | jq -r .watcherId)
check "new watcher created and bound, no key returned" "linked-sdr/null" "$(echo "$R" | jq -r '"\(.name)/\(.key)"')"
check "listed with GET /me/watchers (sign-in token), hasKey" "linked-sdr/true" "$(curl -s -H @$T/N0WDA $B/api/v1/me/watchers | jq -r '.watchers[0]|"\(.name)/\(.hasKey)"')"
check "a key can't list watchers" 403 "$(code -H "Authorization: Bearer $KA" $B/api/v1/me/watchers)"
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
up() { echo "{\"type\":\"status\",\"id\":\"01JD$(date +%s%N)\",\"ts\":\"$NOW\"}" | code -H "x-api-key: $1" --data-binary @- $B/api/v1/watch/ingest; }
check "the key uploads" 200 "$(up "$KA")"
W2=$(curl -s -H @$T/N0WDA "${J[@]}" -X POST $B/api/v1/me/watchers -d '{"name":"second"}' | jq -r .id)
check "relinking moves the key to another watcher" "$W2" "$(curl -s -H "Authorization: Bearer $KA" "${J[@]}" -X POST $B/api/v1/watch/link -d "{\"watcherId\":\"$W2\"}" | jq -r .watcherId)"
check "first watcher no longer has a key" false "$(curl -s -H @$T/N0WDA $B/api/v1/me/watchers | jq --arg w "$WID" '.watchers[]|select(.id==$w)|.hasKey')"
check "another account can't link to N0WDA's watcher" 404 "$(code -H "Authorization: Bearer $KB" "${J[@]}" -X POST $B/api/v1/watch/link -d "{\"watcherId\":\"$WID\"}")"
psql "$DB" -qc "UPDATE watcher SET disabled = true WHERE id = '$WID'" >/dev/null
check "a disabled watcher can't be linked" 403 "$(code -H "Authorization: Bearer $KA" "${J[@]}" -X POST $B/api/v1/watch/link -d "{\"watcherId\":\"$WID\"}")"
check "Atlas no longer mints watcher keys: 410" 410 "$(code -H @$T/N0WDA -X POST $B/api/v1/me/watchers/$W2/key)"
forget N0WDA N0WDB
finish
