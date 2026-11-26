#!/usr/bin/env bash
# End-to-end: custom service codes and their visibility. An unlisted code is never enumerated
# (list, detail, stats, code list, dumps, compat feed) and matches only an exact request.
# Each run looks up 3 distinct non-public codes, which count toward the per-IP hourly limit
# (UNLISTED_CODES_PER_HOUR); raise it in .env if you rerun this many times in an hour.
set -uo pipefail
cd "$(dirname "$0")/.."
. scripts/lib.sh
cleanup() { forget N0SCA; psql "$DB" -qc "DELETE FROM service_code WHERE code LIKE 'ZZ%'" >/dev/null; }
cleanup
as N0SCA N0SCA; as N0SCS N0SCS '{"role":"admin"}'; as N0SCM N0SCM '{"role":"moderator"}'

say "sysops add custom codes"
check "invalid code refused" 400 "$(code -H @$T/N0SCA "${J[@]}" -X POST $B/api/v1/me/gateways -d '{"callsign":"N0SCA-10","gridsquare":"DN16","channels":[{"frequencyKhz":3590,"modem":"ardop","serviceCode":"MY-GRP"}]}')"
G1=$(curl -s -H @$T/N0SCA "${J[@]}" -X POST $B/api/v1/me/gateways -d '{"callsign":"N0SCA-10","gridsquare":"DN16","channels":[{"frequencyKhz":3590,"modem":"ardop","variant":"2000","extraServiceCodes":["zzgrp1"]}]}' | jq -r .id)
G2=$(curl -s -H @$T/N0SCA "${J[@]}" -X POST $B/api/v1/me/gateways -d '{"callsign":"N0SCA-11","gridsquare":"DN16","channels":[{"frequencyKhz":7101.5,"modem":"ardop","variant":"500","serviceCode":"ZZGRP1"}]}' | jq -r .id)
check "both gateways created" true "$([ ${#G1} = 36 ] && [ ${#G2} = 36 ] && echo true)"
check "new code registered as unlisted" unlisted "$(psql "$DB" -Atc "SELECT visibility FROM service_code WHERE code='ZZGRP1'")"
check "owner sees the stored codes" "PUBLIC/ZZGRP1" "$(curl -s -H @$T/N0SCA $B/api/v1/me/gateways | jq -r '.gateways[]|select(.callsign=="N0SCA-10")|.channels[0]|"\(.serviceCode)/\(.extraServiceCodes|join(","))"')"

say "unlisted: never enumerated"
check "list: unlisted-only gateway hidden" 0 "$(curl -s "$B/api/v1/gateways?q=N0SCA-11" | jq .total)"
check "list: mixed channel shows public code only" "PUBLIC" "$(curl -s "$B/api/v1/gateways?q=N0SCA-10" | jq -r '.gateways[0].channels[0].serviceCodes|join(",")')"
check "detail: unlisted-only gateway 404" 404 "$(code $B/api/v1/gateways/N0SCA-11)"
check "stats: not counted" null "$(curl -s $B/api/v1/stats | jq .byServiceCode.ZZGRP1)"
check "service-codes: not listed" 0 "$(curl -s $B/api/v1/service-codes | jq '[.serviceCodes[]|select(.code=="ZZGRP1")]|length')"
curl -s $B/api/v1/dumps/latest.csv > $T/dump.csv
check "CSV dump: gateway there, code absent" "1/0" "$(grep -c '^N0SCA-10,' $T/dump.csv)/$(grep -c ZZGRP1 $T/dump.csv)"
check "compat default: absent" 0 "$(curl -s "$B/gateway/status.json?source=openrms" | grep -c ZZGRP1)"

say "unlisted: exact request only"
check "list ?serviceCode=zzgrp1 finds both" "N0SCA-10,N0SCA-11" "$(curl -s "$B/api/v1/gateways?serviceCode=zzgrp1" | jq -r '[.gateways[].callsign]|join(",")')"
check "answer is not cached publicly" "private, no-store" "$(curl -s -D - -o /dev/null "$B/api/v1/gateways?serviceCode=ZZGRP1" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')"
check "detail with ?serviceCode" 200 "$(code "$B/api/v1/gateways/N0SCA-11?serviceCode=ZZGRP1")"
check "compat ServiceCodes=ZZGRP1" "ARDOP 2000|ZZGRP1,ARDOP 500|ZZGRP1" "$(curl -s -X POST $B/gateway/status.json --data 'ServiceCodes=ZZGRP1&source=openrms' | jq -r '[.Gateways[].GatewayChannels[]|"\(.SupportedModes)|\(.ServiceCode)"]|sort|join(",")')"
psql "$DB" -qc "INSERT INTO service_code (code) VALUES ('ZZGRP2')" >/dev/null
check "more than 5 non-public codes in one request: 400" 400 "$(code "$B/api/v1/gateways?serviceCode=ZZA,ZZB,ZZC,ZZD,ZZE,ZZF")"
check "same in the compat feed" 400 "$(code -X POST $B/gateway/status.json --data 'ServiceCodes=ZZA,ZZB,ZZC,ZZD,ZZE,ZZF')"
check "unknown code and empty unlisted code answer alike" true "$([ "$(curl -s "$B/api/v1/gateways?serviceCode=ZZGRP2")" = "$(curl -s "$B/api/v1/gateways?serviceCode=ZZNOPE")" ] && echo true)"

say "staff"
check "moderator lists every code" true "$(curl -s -H @$T/N0SCM $B/api/v1/admin/service-codes | jq '[.serviceCodes[].code]|index("ZZGRP1") != null')"
check "moderator can't change visibility" 403 "$(code -H @$T/N0SCM "${J[@]}" -X PATCH $B/api/v1/admin/service-codes/ZZGRP1 -d '{"visibility":"public"}')"
check "PUBLIC can't be unlisted" 400 "$(code -H @$T/N0SCS "${J[@]}" -X PATCH $B/api/v1/admin/service-codes/PUBLIC -d '{"visibility":"unlisted"}')"
check "admin promotes ZZGRP1" public "$(curl -s -H @$T/N0SCS "${J[@]}" -X PATCH $B/api/v1/admin/service-codes/zzgrp1 -d '{"visibility":"public","description":"Smoke test group"}' | jq -r .visibility)"
check "now listed with its gateways" "2" "$(curl -s $B/api/v1/service-codes | jq '.serviceCodes[]|select(.code=="ZZGRP1")|.gateways')"
check "now enumerated in stats" 2 "$(curl -s $B/api/v1/stats | jq .byServiceCode.ZZGRP1)"
check "audited" 1 "$(psql "$DB" -Atc "SELECT count(*) FROM audit_log WHERE action='servicecode.update' AND target='ZZGRP1' AND actor_sub='sub-N0SCS'")"

psql "$DB" -qc "DELETE FROM audit_log WHERE target LIKE 'ZZ%'" >/dev/null
cleanup
finish
