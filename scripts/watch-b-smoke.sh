#!/usr/bin/env bash
# Watcher feed phase B: sightings, heardOnAir on gateways, contributors.
# Accounts: N0WBA, N0WBB (verified), N0WBC (unverified, watcher not public).
set -uo pipefail
cd "$(dirname "$0")/.."
. scripts/lib.sh
CALLS="'N0WBA','N0WBB','N0WBC'"
clean() { forget N0WBA N0WBB N0WBC; psql "$DB" -qc "DELETE FROM gateway WHERE source='openrms' AND base_callsign IN ($CALLS)" >/dev/null; }
clean
as N0WBA N0WBA '{"callsign_verified":true}'; as N0WBB N0WBB '{"callsign_verified":true}'; as N0WBC N0WBC
clean
GA=$(curl -s -H @$T/N0WBA "${J[@]}" -X POST $B/api/v1/me/gateways -d '{"callsign":"N0WBA-10","gridsquare":"DN16ra","channels":[{"frequencyKhz":7101.5,"modem":"mercury"}]}' | jq -r .id)
GC=$(curl -s -H @$T/N0WBC "${J[@]}" -X POST $B/api/v1/me/gateways -d '{"callsign":"N0WBC-10","gridsquare":"DN17","channels":[{"frequencyKhz":10145.5,"modem":"mercury"}]}' | jq -r .id)
mkkey() { local w; w=$(curl -s -H @$T/$1 "${J[@]}" -X POST $B/api/v1/me/watchers -d "{\"name\":\"$1-sdr\",\"gridsquare\":\"DN16ab\",\"locationPrecision\":\"$2\",\"public\":$3}" | jq -r .id); wkey $1 $w; }
KA=$(mkkey N0WBA grid6 true); KB=$(mkkey N0WBB grid4 true); KC=$(mkkey N0WBC hidden false)
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z); END=$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%S.000Z); START=$(date -u -d '-2 hours' +%Y-%m-%dT%H:%M:%S.000Z)
CA=$(crc N0WBA-10); CC=$(crc N0WBC-10)
up() { # key prefix crc dial kind
  printf '%s\n' \
   "{\"type\":\"frame\",\"id\":\"$2-1\",\"ts\":\"$NOW\",\"modem\":\"mercury\",\"dialHz\":$4,\"kind\":\"CALL\",\"from\":\"K7TEST\",\"toCrc\":\"$3\",\"snrDb\":12}" \
   "{\"type\":\"frame\",\"id\":\"$2-2\",\"ts\":\"$NOW\",\"modem\":\"mercury\",\"dialHz\":$4,\"kind\":\"$5\",\"callerCrc\":\"C492\",\"calledCrc\":\"$3\",\"snrDb\":18}" \
   "{\"type\":\"coverage\",\"id\":\"$2-3\",\"start\":\"$START\",\"end\":\"$NOW\",\"ranges\":[[7000000,7300000],[10100000,10150000]]}" \
   "{\"type\":\"status\",\"id\":\"$2-4\",\"ts\":\"$NOW\",\"software\":\"openrms-watch 0.2.0\"}" \
   | curl -s -H "x-api-key: $1" --data-binary @- $B/api/v1/watch/ingest | jq -c '{accepted,rejected:(.rejected|length)}'
}
echo "== uploads"
up "$KA" "01JBA00000000000000000000A" "$CA" 7100000 ACCEPT
up "$KB" "01JBB00000000000000000000B" "$CA" 7100040 ACCEPT
up "$KC" "01JBC00000000000000000000C" "$CC" 10144000 ACCEPT
up "$KC" "01JBC00000000000000000000D" "ABCD" 14104000 ACCEPT
up "$KC" "01JBC00000000000000000000E" "$CA" 3585000 CALL
sleep 0.3
echo "== sightings and heardOnAir"
S=$(curl -s "$B/api/v1/watch/sightings?days=1")
check "N0WBA-10 heard by 2 verified accounts: confirmed" "confirmed" "$(echo "$S" | jq -r --arg c "$CA" '[.sightings[]|select(.crc==$c and .heard)][0].confidence')"
check "...named uniquely" "unique/N0WBA-10" "$(echo "$S" | jq -r --arg c "$CA" '[.sightings[]|select(.crc==$c and .heard)][0]|"\(.resolution)/\(.callsign)"')"
check "...two watchers, 2 frames merged within 80 Hz" "2/2" "$(echo "$S" | jq -r --arg c "$CA" '[.sightings[]|select(.crc==$c and .heard)][0]|"\(.watchers)/\(.frames - 2)"')"
check "a CALL on another frequency is a separate 'called' sighting" "called" "$(echo "$S" | jq -r --arg c "$CA" '[.sightings[]|select(.crc==$c and .dialHz==3585000)][0].confidence')"
check "unverified watcher only: single" "single" "$(echo "$S" | jq -r --arg c "$CC" '[.sightings[]|select(.crc==$c)][0].confidence')"
check "unlisted CRC: unknown" "unknown" "$(echo "$S" | jq -r '[.sightings[]|select(.crc=="ABCD")][0].resolution')"
check "no client callsigns in sightings" "false" "$(echo "$S" | jq 'tostring | test("K7TEST")')"
check "gateway API: heardOnAir confirmed" "confirmed" "$(curl -s $B/api/v1/gateways/$GA | jq -r .heardOnAir.confidence)"
check "gateway API: unverified-only gateway is single" "single" "$(curl -s $B/api/v1/gateways/$GC | jq -r .heardOnAir.confidence)"
check "heardOnAir also in the list endpoint" "confirmed" "$(curl -s "$B/api/v1/gateways?q=N0WBA" | jq -r '.gateways[0].heardOnAir.confidence')"
echo "== contributors"
C=$(curl -s "$B/api/v1/watch/contributors?days=7")
check "two public contributors named" "N0WBA,N0WBB" "$(echo "$C" | jq -r '[.contributors[]|select(.callsign|startswith("N0WB"))|.callsign]|sort|join(",")')"
check "non-public watcher counted anonymously" true "$(echo "$C" | jq '.totals.anonymous >= 1')"
check "grid shown at chosen precision (grid6)" "DN16ab" "$(echo "$C" | jq -r '.contributors[]|select(.callsign=="N0WBA")|.gridsquare')"
check "grid4 precision" "DN16" "$(echo "$C" | jq -r '.contributors[]|select(.callsign=="N0WBB")|.gridsquare')"
check "listening hours from coverage" "2" "$(echo "$C" | jq -r '.contributors[]|select(.callsign=="N0WBA")|.listeningHours')"
check "bands from coverage" "30m,40m" "$(echo "$C" | jq -r '.contributors[]|select(.callsign=="N0WBA")|.bands|sort|join(",")')"
check "live (status in last 10 min)" true "$(echo "$C" | jq '.contributors[]|select(.callsign=="N0WBA")|.live')"
clean
finish
