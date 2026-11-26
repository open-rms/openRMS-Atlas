#!/usr/bin/env bash
# Accounts-minted API keys (identity.md §5): which credential each route takes, scopes, the
# denylist, bans, staff routes, and the RFC 9728 scope registry. Keys come from the test
# issuer's /mint-key, shaped like Accounts' ormk_ keys.
set -uo pipefail
cd "$(dirname "$0")/.."
. scripts/lib.sh
forget N0KEY N0KEO N0KES
psql "$DB" -qc "DELETE FROM gateway WHERE source='openrms' AND base_callsign IN ('N0KEY','N0KEO')" >/dev/null
as N0KEY N0KEY; as N0KES N0KES '{"role":"superadmin"}'
GW=$(curl -s -H @$T/N0KEY "${J[@]}" -X POST $B/api/v1/me/gateways -d '{"callsign":"N0KEY-10","gridsquare":"DN16","channels":[{"frequencyKhz":7101.5,"modem":"mercury"}]}' | jq -r .id)
R=$(key N0KEY gateways:read); W=$(key N0KEY gateways:write); H=$(key N0KEY heartbeat); I=$(key N0KEY watch:ingest)
ALL=$(key N0KEY "heartbeat watch:ingest gateways:read gateways:write")
GWBODY='{"callsign":"N0KEY-11","gridsquare":"DN16","channels":[{"frequencyKhz":3590,"modem":"ardop","variant":"2000"}]}'
k() { printf 'Authorization: Bearer %s' "$1"; }

say "scope registry (RFC 9728)"
M=$(curl -s $B/.well-known/oauth-protected-resource)
check "resource is this Atlas's audience" "$(grep '^OPENRMS_AUDIENCE=' .env | cut -d= -f2-)" "$(echo "$M" | jq -r .resource)"
check "key scopes listed" "gateways:read,gateways:write,heartbeat,watch:ingest" "$(echo "$M" | jq -r '[.openrms_key_scopes[].scope]|sort|join(",")')"
check "every scope described" true "$(echo "$M" | jq '[.openrms_key_scopes[]|.description|length>10]|all')"
check "no staff scope offered" 0 "$(echo "$M" | jq '[.scopes_supported[]|select(test("admin|staff|moder"))]|length')"

say "route × credential"
check "GET /me/gateways: gateways:read key" 200 "$(code -H "$(k $R)" $B/api/v1/me/gateways)"
check "GET /me/gateways: heartbeat key (wrong scope)" 403 "$(code -H "$(k $H)" $B/api/v1/me/gateways)"
check "wrong scope says which scope" '"gateways:read"' "$(curl -s -D - -o /dev/null -H "$(k $H)" $B/api/v1/me/gateways | tr -d '\r' | awk -F'scope=' 'tolower($0)~/^www-authenticate/{print $2}')"
check "POST /me/gateways: gateways:read key" 403 "$(code -H "$(k $R)" "${J[@]}" -X POST $B/api/v1/me/gateways -d "$GWBODY")"
check "POST /me/gateways: gateways:write key" 201 "$(code -H "$(k $W)" "${J[@]}" -X POST $B/api/v1/me/gateways -d "$GWBODY")"
GW11=$(curl -s -H @$T/N0KEY $B/api/v1/me/gateways | jq -r '.gateways[]|select(.callsign=="N0KEY-11")|.id')
check "PUT /me/gateways/:id: gateways:write key" 200 "$(code -H "$(k $W)" "${J[@]}" -X PUT $B/api/v1/me/gateways/$GW11 -d "$GWBODY")"
check "confirm: heartbeat key" 200 "$(code -H "$(k $H)" -X POST $B/api/v1/me/gateways/$GW/confirm)"
check "confirm: gateways:read key" 403 "$(code -H "$(k $R)" -X POST $B/api/v1/me/gateways/$GW/confirm)"
check "DELETE /me/gateways/:id: gateways:write key" 204 "$(code -H "$(k $W)" -X DELETE $B/api/v1/me/gateways/$GW11)"
check "heartbeat: heartbeat key" 200 "$(code -H "$(k $H)" -X POST $B/api/v1/gateways/$GW/heartbeat)"
check "heartbeat: gateways:write key" 403 "$(code -H "$(k $W)" -X POST $B/api/v1/gateways/$GW/heartbeat)"
check "heartbeat: sign-in token (keys only)" 401 "$(code -H @$T/N0KEY -X POST $B/api/v1/gateways/$GW/heartbeat)"
check "ingest: heartbeat key" 403 "$(code -H "$(k $H)" --data-binary '{}' $B/api/v1/watch/ingest)"
check "claimable (sign-in only): all-scope key" 403 "$(code -H "$(k $ALL)" $B/api/v1/me/claimable)"
check "watchers (sign-in only): all-scope key" 403 "$(code -H "$(k $ALL)" $B/api/v1/me/watchers)"
check "key list (sign-in only): all-scope key" 403 "$(code -H "$(k $ALL)" $B/api/v1/me/keys)"
check "report (sign-in only): all-scope key" 403 "$(code -H "$(k $ALL)" "${J[@]}" -X POST $B/api/v1/gateways/$GW/report -d '{"reason":"x"}')"
check "/me with a key: treated as signed out" null "$(curl -s -H "$(k $ALL)" $B/api/v1/me | jq .user)"

say "staff routes never take keys"
SK=$(key N0KES "heartbeat watch:ingest gateways:read gateways:write")
check "superadmin's sign-in token: admin API" 200 "$(code -H @$T/N0KES $B/api/v1/admin/audit)"
check "superadmin's key: admin API refused" 403 "$(code -H "$(k $SK)" $B/api/v1/admin/audit)"
check "superadmin's key: can't edit others' listings" 404 "$(code -H "$(k $SK)" "${J[@]}" -X PUT $B/api/v1/me/gateways/$GW -d "$GWBODY")"
check "a key claiming role superadmin still gets none" 403 "$(code -H "$(k "$(key N0KES gateways:read '{"role":"superadmin"}')")" $B/api/v1/admin/audit)"

say "bad keys"
check "wrong audience" 401 "$(code -H "$(k "$(key N0KEY heartbeat '{"aud":"https://rigs.openrms.dev"}')")" -X POST $B/api/v1/gateways/$GW/heartbeat)"
check "expired" 401 "$(code -H "$(k "$(key N0KEY heartbeat "{\"exp\":$(( $(date +%s) - 120 ))}")")" -X POST $B/api/v1/gateways/$GW/heartbeat)"
check "wrong typ (an access token dressed as a key)" 401 "$(code -H "$(k "$(key N0KEY heartbeat '{"typ":"JWT"}')")" -X POST $B/api/v1/gateways/$GW/heartbeat)"
check "token_use not api_key" 401 "$(code -H "$(k "$(key N0KEY heartbeat '{"token_use":"access"}')")" -X POST $B/api/v1/gateways/$GW/heartbeat)"
check "an ormk_ key without the prefix is not a sign-in token" 401 "$(code -H "Authorization: Bearer ${R#ormk_}" $B/api/v1/me/gateways)"
check "the account isn't known yet: gateways refused" 403 "$(code -H "$(k "$(key N0KEO gateways:read)")" $B/api/v1/me/gateways)"

say "bans and revocation"
check "user.banned" 200 "$(hook user.banned '{"sub":"sub-N0KEY","banned":true}')"
check "banned owner's key refused" 403 "$(code -H "$(k $H)" -X POST $B/api/v1/gateways/$GW/heartbeat)"
check "unban" 200 "$(hook user.updated '{"sub":"sub-N0KEY","banned":false}')"
check "key works again" 200 "$(code -H "$(k $H)" -X POST $B/api/v1/gateways/$GW/heartbeat)"
HJ=$(key N0KEY heartbeat >/dev/null; cat $T/N0KEY.jti)
HK=$(curl -s -X POST $ISSUER/mint-key -d "{\"sub\":\"sub-N0KEY\",\"scope\":\"heartbeat\",\"jti\":\"$HJ\"}" | jq -r .key)
check "key.revoked webhook" 200 "$(revoke $HJ sub-N0KEY)"
check "the same webhook twice is fine" 200 "$(revoke $HJ sub-N0KEY)"
check "revoked key refused" 401 "$(code -H "$(k $HK)" -X POST $B/api/v1/gateways/$GW/heartbeat)"
check "denylist row persisted with its source" webhook "$(psql "$DB" -Atc "SELECT source FROM revoked_key WHERE jti='$HJ'")"
check "Atlas no longer mints or revokes keys: 410" "410/410" "$(code -H @$T/N0KEY "${J[@]}" -X POST $B/api/v1/me/keys -d '{"name":"x"}')/$(code -H @$T/N0KEY -X DELETE $B/api/v1/me/keys/x)"

say "rate limit (120 heartbeats/hour per key)"
RL=$(key N0KEY heartbeat)
for i in $(seq 1 120); do curl -s -o /dev/null -H "$(k $RL)" -X POST $B/api/v1/gateways/$GW/heartbeat; done
check "121st in the hour: 429 with Retry-After" "429/yes" "$(curl -s -D $T/rl -o /dev/null -w '%{http_code}' -H "$(k $RL)" -X POST $B/api/v1/gateways/$GW/heartbeat)/$(grep -qi '^retry-after:' $T/rl && echo yes)"
check "another key is unaffected" 200 "$(code -H "$(k $H)" -X POST $B/api/v1/gateways/$GW/heartbeat)"

forget N0KEY N0KEO N0KES
finish
