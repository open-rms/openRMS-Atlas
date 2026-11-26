#!/usr/bin/env bash
# Watcher feed phase C: events API, live stream (SSE), client-callsign privacy rules.
set -uo pipefail
cd "$(dirname "$0")/.."
. scripts/lib.sh
CALLS="'N0WCA','N0WCD'"
clean() { forget N0WCA N0WCD; psql "$DB" -qc "UPDATE site_setting SET value='false' WHERE key='publish_client_callsigns'; DELETE FROM callsign_optout WHERE callsign='K7OPT'; DELETE FROM gateway WHERE source='openrms' AND base_callsign IN ($CALLS)" >/dev/null; }
clean
as N0WCA N0WCA; as N0WCD N0WCD '{"role":"admin"}'
clean
curl -s -H @$T/N0WCA "${J[@]}" -X POST $B/api/v1/me/gateways -d '{"callsign":"N0WCA-10","gridsquare":"DN16ra","channels":[{"frequencyKhz":7101.5,"modem":"mercury"}]}' >/dev/null
W=$(curl -s -H @$T/N0WCA "${J[@]}" -X POST $B/api/v1/me/watchers -d '{"name":"wca-sdr","gridsquare":"DN16ab","locationPrecision":"grid4"}' | jq -r .id)
K=$(wkey N0WCA $W)
CR=$(crc N0WCA-10); NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z); P=01JC$(date +%s)
printf '%s\n' \
 "{\"type\":\"frame\",\"id\":\"${P}1\",\"ts\":\"$NOW\",\"modem\":\"mercury\",\"dialHz\":7100000,\"kind\":\"CALL\",\"from\":\"K7TEST\",\"toCrc\":\"$CR\"}" \
 "{\"type\":\"frame\",\"id\":\"${P}2\",\"ts\":\"$NOW\",\"modem\":\"mercury\",\"dialHz\":7100000,\"kind\":\"CALL\",\"from\":\"K7OPT-7\",\"toCrc\":\"$CR\"}" \
 "{\"type\":\"frame\",\"id\":\"${P}3\",\"ts\":\"$NOW\",\"modem\":\"mercury\",\"dialHz\":7100000,\"kind\":\"ACCEPT\",\"callerCrc\":\"C492\",\"calledCrc\":\"$CR\"}" \
 | curl -s -H "x-api-key: $K" --data-binary @- $B/api/v1/watch/ingest >/dev/null
ev() { curl -s ${2:+-H @$2} "$B/api/v1/watch/events?gateway=$1&limit=10"; }
GID=$(curl -s "$B/api/v1/gateways/N0WCA-10" | jq -r .id)
clients() { ev $GID ${1:-} | jq -r '[.events[]|select(.kind=="CALL")|.client]|sort|join(",")'; }
echo "== privacy: publish off (default)"
check "public sees 'a client' only" "a client,a client" "$(clients)"
check "admin sees client callsigns" "K7OPT-7,K7TEST" "$(clients $T/N0WCD)"
check "watcher owner (not staff) does not" "a client,a client" "$(clients $T/N0WCA)"
check "station resolved to the listing" "N0WCA-10" "$(ev $GID | jq -r '.events[0].station.callsign')"
check "watcher shown at grid4" "DN16" "$(ev $GID | jq -r '.events[0].watcher.gridsquare')"
check "ACCEPT client stays anonymous publicly" "a client" "$(ev $GID | jq -r '[.events[]|select(.kind=="ACCEPT")][0].client')"
echo "== privacy: publish on, with an opt-out"
curl -s -H @$T/N0WCD "${J[@]}" -X PUT $B/api/v1/admin/settings/publish_client_callsigns -d '{"value":true}' >/dev/null
curl -s -H @$T/N0WCD "${J[@]}" -X POST $B/api/v1/admin/optouts -d '{"callsign":"K7OPT","reason":"test"}' >/dev/null
check "public sees K7TEST; opted-out K7OPT-7 (base call) stays hidden" "K7TEST,a client" "$(ev $GID | jq -r '[.events[]|select(.kind=="CALL")|.client]|sort|join(",")')"
check "admin still sees the opted-out call" "K7OPT-7,K7TEST" "$(clients $T/N0WCD)"
curl -s -H @$T/N0WCD "${J[@]}" -X PUT $B/api/v1/admin/settings/publish_client_callsigns -d '{"value":false}' >/dev/null
check "publish off again: hidden" "a client,a client" "$(clients)"
check "sightings never carry client calls" false "$(curl -s "$B/api/v1/watch/sightings?gateway=$GID" | jq 'tostring|test("K7TEST")')"
echo "== live stream (SSE)"
curl -sN "$B/api/v1/watch/stream?gateway=$GID" > $T/sse.txt &
sleep 1
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
echo "{\"type\":\"frame\",\"id\":\"${P}4\",\"ts\":\"$NOW\",\"modem\":\"mercury\",\"dialHz\":7100000,\"kind\":\"CALL\",\"from\":\"K7LIVE\",\"toCrc\":\"$CR\"}" | curl -s -H "x-api-key: $K" --data-binary @- $B/api/v1/watch/ingest >/dev/null
sleep 1.5; kill %1 2>/dev/null
check "hello event sent" 1 "$(grep -c '^event: hello' $T/sse.txt)"
check "new frame pushed live" 1 "$(grep -c '^event: frame' $T/sse.txt)"
check "live frame is projected (client hidden)" "a client" "$(grep '^data: {"id"' $T/sse.txt | tail -1 | sed 's/^data: //' | jq -r .client)"
LID=$(grep '^id:' $T/sse.txt | tail -1 | awk '{print $2}')
FIRST=$(ev $GID | jq -r '[.events[].id]|min')
curl -sN -H "Last-Event-ID: $((FIRST-1))" "$B/api/v1/watch/stream?gateway=$GID" > $T/resume.txt & sleep 1.5; kill %2 2>/dev/null
check "Last-Event-ID resume replays missed frames" 4 "$(grep -c '^event: frame' $T/resume.txt)"
check "admin stream shows clients" "K7LIVE" "$(curl -sN -m 2 -H @$T/N0WCD -H "Last-Event-ID: $((LID-1))" "$B/api/v1/watch/stream?gateway=$GID" | grep '^data: {"id"' | tail -1 | sed 's/^data: //' | jq -r .client)"
clean
finish
