#!/usr/bin/env bash
# Identity in Atlas after the Accounts split: token checks, staff permissions from the
# role claim, Accounts webhooks and the local account cache.
set -uo pipefail
cd "$(dirname "$0")/.."
. scripts/lib.sh
forget N0IDA N0IDM N0IDX N0IDB
psql "$DB" -qc "DELETE FROM gateway WHERE source='openrms' AND base_callsign IN ('N0IDA','N0IDB')" >/dev/null

say "tokens"
mint() { curl -s -X POST $ISSUER/mint -d "$1" | jq -r .token; }
check "wrong audience: 401 wrong_audience" "wrong_audience" "$(curl -s -H "Authorization: Bearer $(mint '{"sub":"sub-N0IDA","callsign":"N0IDA","aud":"https://rigs.openrms.dev"}')" $B/api/v1/me/gateways | jq -r .code)"
check "expired: 401 expired" "expired" "$(curl -s -H "Authorization: Bearer $(mint "{\"sub\":\"sub-N0IDA\",\"callsign\":\"N0IDA\",\"iat\":$(( $(date +%s) - 7200 )),\"exp\":$(( $(date +%s) - 3600 ))}")" $B/api/v1/me/gateways | jq -r .code)"
FOREIGN=$(node -e 'const h=Buffer.from(JSON.stringify({alg:"ES256"})).toString("base64url");const p=Buffer.from(JSON.stringify({iss:"https://evil.example",sub:"x",aud:"https://atlas.openrms.dev",exp:9999999999})).toString("base64url");console.log(h+"."+p+".sig")')
check "untrusted issuer: 401" "untrusted_issuer" "$(curl -s -H "Authorization: Bearer $FOREIGN" $B/api/v1/me/gateways | jq -r .code)"
check "token without callsign claim: 403" 403 "$(code -H "Authorization: Bearer $(mint '{"sub":"sub-N0IDX","callsign":null}')" $B/api/v1/me/gateways)"

say "staff permissions come from the role claim (assignment lives in Accounts)"
as N0IDA N0IDA '{"role":"admin"}'; as N0IDM N0IDM '{"role":"moderator"}'; as N0IDB N0IDB
check "user: staff routes 403" 403 "$(code -H @$T/N0IDB $B/api/v1/admin/reports)"
check "moderator: reports" 200 "$(code -H @$T/N0IDM $B/api/v1/admin/reports)"
check "moderator: can't run the import" 403 "$(code -H @$T/N0IDM -X POST $B/api/v1/admin/imports/winlink)"
check "moderator: no audit log" 403 "$(code -H @$T/N0IDM $B/api/v1/admin/audit)"
check "moderator: no site settings" 403 "$(code -H @$T/N0IDM "${J[@]}" -X PUT $B/api/v1/admin/settings/publish_client_callsigns -d '{"value":false}')"
check "admin: audit log" 200 "$(code -H @$T/N0IDA $B/api/v1/admin/audit)"
check "admin: permissions in /me" true "$(curl -s -H @$T/N0IDA $B/api/v1/me | jq '.permissions.setting|index("edit") != null')"
as N0IDX N0IDX '{"role":"admin","client_id":"some-third-party-app"}'
check "third-party client token never carries staff power" 403 "$(code -H @$T/N0IDX $B/api/v1/admin/reports)"
check "old identity routes are gone (users, clubs)" "404/404" "$(code -H @$T/N0IDA $B/api/v1/admin/users)/$(code -H @$T/N0IDA $B/api/v1/me/clubs)"

say "webhooks"
SECRET=$(grep '^ACCOUNTS_WEBHOOK_SECRET=' .env | cut -d= -f2-)
check "unsigned: 401" 401 "$(code -H 'Content-Type: application/json' -X POST $B/api/v1/hooks/accounts -d '{"id":"x","type":"user.updated","data":{}}')"
check "bad signature: 401" 401 "$(code -H 'Content-Type: application/json' -H "openrms-signature: t=$(date +%s),v1=00" -X POST $B/api/v1/hooks/accounts -d '{"id":"x","type":"user.updated","data":{}}')"
BODY='{"id":"evt-replay-test-'$$'","type":"user.callsign_verified","createdAt":"2026-11-25T00:00:00Z","data":{"sub":"sub-N0IDB","callsign":"N0IDB","callsign_verified":true,"callsign_verified_method":"moderator"}}'
TS=$(date +%s); SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')
check "user.callsign_verified applied" 200 "$(code -H 'Content-Type: application/json' -H "openrms-signature: t=$TS,v1=$SIG" -X POST $B/api/v1/hooks/accounts -d "$BODY")"
check "same event again: still 200 (idempotent)" 200 "$(code -H 'Content-Type: application/json' -H "openrms-signature: t=$TS,v1=$SIG" -X POST $B/api/v1/hooks/accounts -d "$BODY")"
check "cache updated: N0IDB verified" t "$(psql "$DB" -Atc "SELECT callsign_verified FROM account_cache WHERE sub='sub-N0IDB'")"
OLD=$(( $(date +%s) - 3600 ))
check "a token older than the webhook doesn't undo it" t "$(as N0IDB N0IDB "{\"callsign_verified\":false,\"iat\":$OLD}"; curl -s -H @$T/N0IDB $B/api/v1/me >/dev/null; psql "$DB" -Atc "SELECT callsign_verified FROM account_cache WHERE sub='sub-N0IDB'")"

say "user.banned stops the account's API use and keys"
as N0IDB N0IDB
GB=$(curl -s -H @$T/N0IDB "${J[@]}" -X POST $B/api/v1/me/gateways -d '{"callsign":"N0IDB-10","gridsquare":"DN16","channels":[{"frequencyKhz":7101.5,"modem":"mercury"}]}' | jq -r .id)
KB=$(curl -s -H @$T/N0IDB "${J[@]}" -X POST $B/api/v1/me/keys -d '{"name":"b"}' | jq -r .key)
check "key works before the ban" 200 "$(code -H "x-api-key: $KB" -X POST $B/api/v1/gateways/$GB/heartbeat)"
check "user.banned webhook" 200 "$(hook user.banned '{"sub":"sub-N0IDB","banned":true}')"
check "banned: API refused (even with a valid token)" 403 "$(code -H @$T/N0IDB $B/api/v1/me/gateways)"
check "banned: key refused" 403 "$(code -H "x-api-key: $KB" -X POST $B/api/v1/gateways/$GB/heartbeat)"
check "unban (user.updated banned:false)" 200 "$(hook user.updated '{"sub":"sub-N0IDB","banned":false}')"
check "key works again" 200 "$(code -H "x-api-key: $KB" -X POST $B/api/v1/gateways/$GB/heartbeat)"

say "callsign change (user.updated)"
check "user.updated with a new callsign" 200 "$(hook user.updated '{"sub":"sub-N0IDB","callsign":"N0IDZ"}')"
check "listing under the old callsign hidden" 404 "$(code $B/api/v1/gateways/$GB)"
check "reason recorded" "owner callsign changed" "$(psql "$DB" -Atc "SELECT hidden_reason FROM gateway WHERE id='$GB'")"

say "user.deleted"
check "user.deleted webhook" 200 "$(hook user.deleted '{"sub":"sub-N0IDB"}')"
check "keys revoked" 401 "$(code -H "x-api-key: $KB" -X POST $B/api/v1/gateways/$GB/heartbeat)"
check "account removed from cache" 0 "$(psql "$DB" -Atc "SELECT count(*) FROM account_cache WHERE sub='sub-N0IDB'")"

psql "$DB" -qc "DELETE FROM gateway WHERE id='$GB'" >/dev/null
forget N0IDA N0IDM N0IDX N0IDB
finish
