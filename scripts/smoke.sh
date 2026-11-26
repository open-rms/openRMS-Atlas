#!/usr/bin/env bash
# End-to-end: gateways, API keys, heartbeats, compat feed, claims and clubs, with identity from
# Accounts-style tokens (the test issuer). Sign-up and callsign rules are tested in Accounts.
set -uo pipefail
cd "$(dirname "$0")/.."
. scripts/lib.sh
WLGW=$(psql "$DB" -Atc "SELECT callsign FROM gateway WHERE source='winlink' AND removed_at IS NULL AND callsign LIKE '%-%' ORDER BY callsign LIMIT 1")
WLBASE=${WLGW%%-*}
forget N0CALL N0CALM WL
psql "$DB" -qc "DELETE FROM gateway WHERE source='openrms' AND base_callsign IN ('N0CALL','N0CALM','N0CLB','$WLBASE'); DELETE FROM account_club WHERE id='club-n0clb'" >/dev/null
as N0CALL N0CALL; as N0CALM N0CALM

say "identity"
check "no token: 401" 401 "$(code $B/api/v1/me/gateways)"
check "garbage token: 401" 401 "$(code -H 'Authorization: Bearer junk' $B/api/v1/me/gateways)"
check "/me from token" "N0CALL/sub-N0CALL" "$(curl -s -H @$T/N0CALL $B/api/v1/me | jq -r '"\(.user.callsign)/\(.user.id)"')"

say "gateways"
check "gateway under someone else's callsign: 403" 403 "$(code -H @$T/N0CALL "${J[@]}" -X POST $B/api/v1/me/gateways -d '{"callsign":"W1AW-10","gridsquare":"DN16","channels":[{"frequencyKhz":7101.5,"modem":"mercury"}]}')"
GW=$(curl -s -H @$T/N0CALL "${J[@]}" -X POST $B/api/v1/me/gateways -d '{"callsign":"N0CALL-10","gridsquare":"DN16ra","latitude":46.73,"longitude":-117.0,"comments":"openRMS test gateway","channels":[{"frequencyKhz":7101.5,"modem":"mercury","modemVersion":"0.3"},{"frequencyKhz":3590,"modem":"ardop","variant":"2000"},{"frequencyKhz":14105,"modem":"data2g"},{"frequencyKhz":10145,"modem":"vara-hf","variant":"500"}],"emcomm":{"backupPower":["battery","solar"],"runtimeHours":48}}' | jq -r .id)
check "gateway created" true "$([ ${#GW} = 36 ] && echo true)"
check "listed in /me/gateways" "N0CALL-10" "$(curl -s -H @$T/N0CALL $B/api/v1/me/gateways | jq -r '.gateways[0].callsign')"

say "API keys (minted by Accounts; Atlas verifies)"
KEY=$(key N0CALL heartbeat)
check "heartbeat with bad key: 401" 401 "$(code -H 'x-api-key: ormk_nope' -X POST $B/api/v1/gateways/$GW/heartbeat)"
check "heartbeat (x-api-key)" 200 "$(code -H "x-api-key: $KEY" "${J[@]}" -X POST $B/api/v1/gateways/$GW/heartbeat -d '{"currentFrequencyHz":7101500,"currentModem":"mercury","busy":false}')"
check "public view online with live data" "online/mercury" "$(curl -s $B/api/v1/gateways/N0CALL-10 | jq -r '"\(.status)/\(.live.currentModem)"')"
GW2=$(curl -s -H @$T/N0CALL "${J[@]}" -X POST $B/api/v1/me/gateways -d '{"callsign":"N0CALL-11","gridsquare":"DN16","channels":[{"frequencyKhz":145050,"modem":"packet","variant":"1200"}]}' | jq -r .id)
check "heartbeat (Authorization: Bearer) for a second gateway" 200 "$(code -H "Authorization: Bearer $KEY" -X POST $B/api/v1/gateways/$GW2/heartbeat)"
K2=$(key N0CALM heartbeat)
check "another account's key can't heartbeat it" 404 "$(code -H "x-api-key: $K2" -X POST $B/api/v1/gateways/$GW/heartbeat)"
check "another account can't edit it" 404 "$(code -H @$T/N0CALM "${J[@]}" -X PUT $B/api/v1/me/gateways/$GW -d '{"callsign":"N0CALM","gridsquare":"DN16","channels":[{"frequencyKhz":7101.5,"modem":"mercury"}]}')"
check "Atlas no longer mints keys: 410" 410 "$(code -H @$T/N0CALL "${J[@]}" -X POST $B/api/v1/me/keys -d '{"name":"gw"}')"
check "revoked (key.revoked webhook)" 200 "$(revoke "$(cat $T/N0CALL.jti)" sub-N0CALL)"
check "revoked key: 401" 401 "$(code -H "x-api-key: $KEY" -X POST $B/api/v1/gateways/$GW/heartbeat)"

say "compat feed"
check "PUBLIC: Mercury and Data2G absent" "ARDOP 2000,VARA 500" "$(curl -s "$B/gateway/status.json?source=openrms" | jq -r '[.Gateways[]|select(.Callsign=="N0CALL-10")|.GatewayChannels[].SupportedModes]|join(",")')"
check "PUBLIC+MERCURY (form POST like Pat)" "ARDOP 2000,VARA,VARA 500" "$(curl -s -X POST "$B/gateway/status.json" --data 'Mode=AnyAll&HistoryHours=48&key=x&ServiceCodes=PUBLIC&ServiceCodes=MERCURY&source=openrms' | jq -r '[.Gateways[]|select(.Callsign=="N0CALL-10")|.GatewayChannels[].SupportedModes]|join(",")')"

say "unverified owner vs Winlink listing ($WLGW)"
as WL "$WLBASE"
curl -s -H @$T/WL "${J[@]}" -X POST $B/api/v1/me/gateways -d "{\"callsign\":\"$WLGW\",\"gridsquare\":\"DN16\",\"channels\":[{\"frequencyKhz\":7101.5,\"modem\":\"ardop\",\"variant\":\"2000\"}]}" >/dev/null
sleep 0.2
check "both shown, Winlink row kept (unverified conflict)" "openrms:true,winlink:false" "$(curl -s "$B/api/v1/gateways?q=$WLGW" | jq -r "[.gateways[]|select(.callsign==\"$WLGW\")|\"\(.source):\(.unverifiedConflict)\"]|sort|join(\",\")")"

say "claims"
WLID=$(psql "$DB" -Atc "SELECT id FROM gateway WHERE source='winlink' AND callsign='$WLGW'")
check "$WLBASE sees its Winlink listings" true "$(curl -s -H @$T/WL $B/api/v1/me/claimable | jq "[.gateways[].callsign]|index(\"$WLGW\") != null")"
check "N0CALL can't claim it" 403 "$(code -H @$T/N0CALL -X POST $B/api/v1/me/gateways/$WLID/claim)"
check "$WLBASE claims it" 200 "$(code -H @$T/WL -X POST $B/api/v1/me/gateways/$WLID/claim)"
check "adds details" 200 "$(code -H @$T/WL "${J[@]}" -X PUT $B/api/v1/me/gateways/$WLID/details -d '{"comments":"Generator on site","emcomm":{"backupPower":["generator"],"runtimeHours":72}}')"
pnpm -s cli import-winlink >/dev/null 2>&1
check "details survive a re-import" "Generator on site/true" "$(curl -s $B/api/v1/gateways/$WLID | jq -r '"\(.ownerComments)/\(.claimed)"')"
check "release" 200 "$(code -H @$T/WL -X POST $B/api/v1/me/gateways/$WLID/release)"
check "details removed" "/false" "$(curl -s $B/api/v1/gateways/$WLID | jq -r '"\(.ownerComments)/\(.claimed)"')"

say "clubs (membership from the token, kept current by webhooks)"
CLUB='[{"id":"club-n0clb","callsign":"N0CLB","role":"owner","verified":false}]'
as N0CALL N0CALL "{\"clubs\":$CLUB}"
as N0CALM N0CALM '{"clubs":[{"id":"club-n0clb","callsign":"N0CLB","role":"member","verified":false}]}'
GWC='{"callsign":"N0CLB-10","gridsquare":"DN16","comments":"club station","channels":[{"frequencyKhz":7101.5,"modem":"mercury"}]}'
GWCID=$(curl -s -H @$T/N0CALM "${J[@]}" -X POST $B/api/v1/me/gateways -d "$GWC" | jq -r .id)
check "member lists N0CLB-10" true "$([ ${#GWCID} = 36 ] && echo true)"
check "club shown on the listing" "N0CLB" "$(curl -s $B/api/v1/gateways/$GWCID | jq -r .club.callsign)"
check "owner edits a gateway a member listed" 200 "$(code -H @$T/N0CALL "${J[@]}" -X PUT $B/api/v1/me/gateways/$GWCID -d "$GWC")"
check "club.member_removed webhook accepted" 200 "$(hook club.member_removed '{"clubId":"club-n0clb","sub":"sub-N0CALM"}')"
check "removed member's older token no longer edits" 404 "$(code -H @$T/N0CALM "${J[@]}" -X PUT $B/api/v1/me/gateways/$GWCID -d "$GWC")"
check "club.deleted webhook" 200 "$(hook club.deleted '{"id":"club-n0clb"}')"
check "club's listings removed" 404 "$(code $B/api/v1/gateways/$GWCID)"

forget N0CALL N0CALM WL
finish
