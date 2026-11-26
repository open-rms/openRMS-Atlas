#!/usr/bin/env bash
# Watcher feed phase A against a running dev server: watchers, ormsw_ keys, NDJSON ingest,
# /watch/callsigns, moderation. Throwaway accounts N0WAT (watcher owner), N0WMD (moderator).
set -uo pipefail
cd "$(dirname "$0")/.."
. scripts/lib.sh
forget N0WAT N0WMD
psql "$DB" -qc "DELETE FROM gateway WHERE source='openrms' AND base_callsign='N0WAT'" >/dev/null
as N0WAT N0WAT; as N0WMD N0WMD '{"role":"moderator"}'

echo "== watcher and key"
W=$(curl -s -H @$T/N0WAT "${J[@]}" -X POST $B/api/v1/me/watchers -d '{"name":"shack-hackrf","gridsquare":"DN16ra","locationPrecision":"grid4"}' | jq -r .id)
check "watcher created" "true" "$([ -n "$W" ] && [ "$W" != null ] && echo true)"
K=$(curl -s -H @$T/N0WAT "${J[@]}" -X POST $B/api/v1/me/watchers/$W/key | jq -r .key)
check "minted key has ormsw_ prefix" "ormsw_" "${K:0:6}"
GK=$(curl -s -H @$T/N0WAT "${J[@]}" -X POST $B/api/v1/me/keys -d '{"name":"gw"}' | jq -r .key)

NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z); FUT=$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%S.000Z); END=$(date -u -d '+20 seconds' +%Y-%m-%dT%H:%M:%S.000Z)
cat > $T/batch.ndjson <<NDJ
{"type":"frame","id":"01JTEST0000000000000000001","ts":"$NOW","modem":"mercury","dialHz":7101340,"mode":"DATAC16","kind":"CALL","from":"K7TEST","toCrc":"3def","sid":127,"bw":2300,"snrDb":24.0,"raw":"MONITOR DATAC16 CALL FROM=K7TEST TO_CRC=3DEF","hint":{"callsign":"W1RMS-10","match":"inferred","candidates":["W1RMS-10"]}}
{"type":"frame","id":"01JTEST0000000000000000002","ts":"$NOW","modem":"mercury","dialHz":7101340,"kind":"ACCEPT","callerCrc":"C492","calledCrc":"3DEF","snrDb":24.4}
{"type":"attempt","id":"01JTEST0000000000000000003","start":"$NOW","end":"$END","modem":"mercury","dialHz":7101340,"from":"K7TEST","calledCrc":"3DEF","callerCrc":"C492","accepted":true,"calls":3,"bestSnrDb":24.4,"frames":["01JTEST0000000000000000001","01JTEST0000000000000000002"]}
{"type":"coverage","id":"01JTEST0000000000000000004","start":"$NOW","end":"$END","ranges":[[7000000,7300000]],"receiver":"hackrf"}
{"type":"status","id":"01JTEST0000000000000000005","ts":"$NOW","software":"openrms-watch 0.2.0","sdr":"HackRF One","decoders":8,"calibrated":true,"ppm":-24.06}
{"type":"frame","id":"01JTEST0000000000000000008","ts":"$NOW","modem":"mercury","dialHz":7101340,"kind":"CQ","from":"W1RMS","toCrc":null,"callerCrc":null,"calledCrc":null,"bw":null,"hint":null}
this is not json
{"type":"frame","id":"01JTEST0000000000000000006","ts":"$FUT","modem":"mercury","dialHz":7101340,"kind":"CQ","from":"W1RMS"}
{"type":"frame","id":"01JTEST0000000000000000007","ts":"$NOW","modem":"mercury","dialHz":9500000,"kind":"CQ","from":"W1RMS"}
NDJ
ing() { curl -s -H "x-api-key: $1" -H 'content-type: application/x-ndjson' --data-binary @$2 $B/api/v1/watch/ingest; }
echo "== ingest"
R=$(ing "$K" $T/batch.ndjson); echo "  $R" | cut -c1-220
check "6 accepted (incl. one with null optional fields)" 6 "$(echo "$R" | jq .accepted)"
check "3 rejected (not JSON, future, out of band)" 3 "$(echo "$R" | jq '.rejected|length')"
R=$(ing "$K" $T/batch.ndjson)
check "re-post is idempotent: 6 duplicates, 0 accepted" "6/0" "$(echo "$R" | jq -r '"\(.duplicate)/\(.accepted)"')"
check "a gateway key is refused at ingest" 401 "$(code -H "x-api-key: $GK" --data-binary @$T/batch.ndjson $B/api/v1/watch/ingest)"
check "no key: 401" 401 "$(code --data-binary @$T/batch.ndjson $B/api/v1/watch/ingest)"
seq 1 1001 | sed 's/.*/{}/' > $T/big.ndjson
check "over 1000 lines: 413" 413 "$(code -H "x-api-key: $K" --data-binary @$T/big.ndjson $B/api/v1/watch/ingest)"
check "watcher status stored" "HackRF One" "$(curl -s -H @$T/N0WAT $B/api/v1/me/watchers | jq -r '.watchers[0].lastStatus.sdr')"

echo "== a watcher key never works as a gateway key"
GW=$(curl -s -H @$T/N0WAT "${J[@]}" -X POST $B/api/v1/me/gateways -d '{"callsign":"N0WAT-10","gridsquare":"DN16ra","channels":[{"frequencyKhz":7101.5,"modem":"mercury"},{"frequencyKhz":10145.5,"modem":"mercury"},{"frequencyKhz":3590,"modem":"ardop","variant":"2000"}]}' | jq -r .id)
check "watcher key on heartbeat is refused" 401 "$(code -H "x-api-key: $K" -X POST $B/api/v1/gateways/$GW/heartbeat)"
check "gateway key on heartbeat still works" 200 "$(code -H "x-api-key: $GK" -X POST $B/api/v1/gateways/$GW/heartbeat)"

echo "== /watch/callsigns"
sleep 0.3
curl -s -D $T/h $B/api/v1/watch/callsigns > $T/calls.json
check "N0WAT-10 listed with its CRC" "$(node -e 'let c=0xffff;for(const b of Buffer.from("N0WAT-10")){c^=b<<8;for(let i=0;i<8;i++)c=c&0x8000?((c<<1)^0x1021)&0xffff:(c<<1)&0xffff}console.log(c.toString(16).toUpperCase().padStart(4,"0"))')" "$(jq -r '.[]|select(.callsign=="N0WAT-10")|.crc' $T/calls.json)"
check "dialHz lists every Mercury channel, not ARDOP" "[7100000,10144000]" "$(jq -c '.[]|select(.callsign=="N0WAT-10")|.dialHz' $T/calls.json)"
check "Winlink rows included (WINLINK_PUBLISH on)" true "$(jq '[.[]|select(.source=="winlink")]|length > 1000' $T/calls.json)"
ET=$(grep -i '^etag:' $T/h | cut -d' ' -f2 | tr -d '\r')
check "ETag: 304 when unchanged" 304 "$(code -H "If-None-Match: $ET" $B/api/v1/watch/callsigns)"

echo "== rotation, moderation, revocation"
K2=$(curl -s -H @$T/N0WAT "${J[@]}" -X POST $B/api/v1/me/watchers/$W/key | jq -r .key)
check "old key rejected after rotation" 401 "$(code -H "x-api-key: $K" --data-binary @$T/batch.ndjson $B/api/v1/watch/ingest)"
check "new key accepted" 200 "$(code -H "x-api-key: $K2" --data-binary @$T/batch.ndjson $B/api/v1/watch/ingest)"
check "moderator disables the watcher" 200 "$(code -H @$T/N0WMD "${J[@]}" -X POST $B/api/v1/admin/watchers/$W/disable -d '{"reason":"test"}')"
check "disabled watcher: 403" 403 "$(code -H "x-api-key: $K2" --data-binary @$T/batch.ndjson $B/api/v1/watch/ingest)"
check "moderator re-enables" 200 "$(code -H @$T/N0WMD "${J[@]}" -X POST $B/api/v1/admin/watchers/$W/disable -d '{"disabled":false}')"
check "moderator cannot change site settings" 403 "$(code -H @$T/N0WMD "${J[@]}" -X PUT $B/api/v1/admin/settings/publish_client_callsigns -d '{"value":true}')"
check "moderator manages the opt-out list" 201 "$(code -H @$T/N0WMD "${J[@]}" -X POST $B/api/v1/admin/optouts -d '{"callsign":"K7TEST","reason":"asked by holder"}')"
check "moderator purges the watcher's events" 6 "$(curl -s -H @$T/N0WMD -X POST $B/api/v1/admin/watchers/$W/purge | jq .deleted)"
check "owner revokes the key" 204 "$(code -H @$T/N0WAT -X DELETE $B/api/v1/me/watchers/$W/key)"
check "revoked key: 401" 401 "$(code -H "x-api-key: $K2" --data-binary @$T/batch.ndjson $B/api/v1/watch/ingest)"
check "publish_client_callsigns defaults to off" false "$(curl -s -H @$T/N0WMD $B/api/v1/admin/settings | jq '.settings[]|select(.key=="publish_client_callsigns")|.value')"

psql "$DB" -qc "DELETE FROM callsign_optout WHERE callsign='K7TEST'" >/dev/null
forget N0WAT N0WMD
finish
