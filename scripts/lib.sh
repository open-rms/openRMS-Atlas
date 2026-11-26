# Shared helpers for the smoke tests. Needs the dev server (pnpm dev) and the test issuer
# (pnpm exec tsx scripts/dev-issuer.ts, port 8799) trusted via OPENRMS_ISSUER in .env.
B=${B:-http://localhost:8787}
ISSUER=${ISSUER:-http://localhost:8799}
DB="${DATABASE_URL:-postgres://openrms:openrms@127.0.0.1:5442/openrms}"
T=$(mktemp -d); trap 'rm -rf "$T"; kill $(jobs -p) 2>/dev/null' EXIT
J=(-H 'Content-Type: application/json')
pass=0; fail=0
say() { printf '\n== %s\n' "$*"; }
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  ok   %-68s %s\n' "$1" "$3"; else fail=$((fail+1)); printf '  FAIL %-68s want %s got %s\n' "$1" "$2" "$3"; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
finish() { echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]; }

# as NAME CALLSIGN [extra-claims-json]: mint an Accounts-style token for account "sub-NAME"
# and write "$T/NAME" as a curl header file, used as: curl -H @$T/NAME ...
as() {
  local extra=${3:-'{}'}
  local body; body=$(jq -cn --arg sub "sub-$1" --arg cs "$2" --argjson x "$extra" '{sub:$sub, callsign:$cs} + $x')
  local tok; tok=$(curl -s -X POST $ISSUER/mint -d "$body" | jq -r .token)
  printf 'Authorization: Bearer %s\n' "$tok" > "$T/$1"
  printf '%s' "$tok" > "$T/$1.tok"
}

# key NAME SCOPE [extra-claims-json]: mint an Accounts-style API key (ormk_) for "sub-NAME";
# prints the key. Its jti is written to "$T/NAME.jti".
key() {
  local extra=${3:-'{}'}
  local body; body=$(jq -cn --arg sub "sub-$1" --arg scope "$2" --argjson x "$extra" '{sub:$sub, scope:$scope} + $x')
  local r; r=$(curl -s -X POST $ISSUER/mint-key -d "$body")
  printf '%s' "$(echo "$r" | jq -r .jti)" > "$T/$1.jti"
  echo "$r" | jq -r .key
}

# wkey NAME WATCHER-ID: mint a watch:ingest key for "sub-NAME", link it to the watcher, print it
wkey() {
  local k; k=$(key "$1" watch:ingest)
  curl -s -o /dev/null -H "Authorization: Bearer $k" -H 'Content-Type: application/json' -X POST $B/api/v1/watch/link -d "{\"watcherId\":\"$2\"}"
  echo "$k"
}

# revoke JTI SUB: tell Atlas a key was revoked (key.revoked webhook)
revoke() { hook key.revoked "$(jq -cn --arg j "$1" --arg s "$2" '{jti:$j, sub:$s, aud:"x", exp:(now+86400|floor)}')"; }

# hook TYPE DATA-JSON: deliver a signed Accounts webhook to Atlas
hook() {
  local secret; secret=$(grep '^ACCOUNTS_WEBHOOK_SECRET=' .env | cut -d= -f2-)
  local body; body=$(jq -cn --arg id "evt-$(date +%s%N)-$RANDOM" --arg type "$1" --argjson data "$2" '{id:$id, type:$type, createdAt:(now|todate), data:$data}')
  local t; t=$(date +%s)
  local sig; sig=$(printf '%s.%s' "$t" "$body" | openssl dgst -sha256 -hmac "$secret" -hex | awk '{print $NF}')
  curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -H "openrms-signature: t=$t,v1=$sig" -X POST $B/api/v1/hooks/accounts -d "$body"
}

# forget SUB...: remove cached accounts and their data (test cleanup)
forget() {
  for s in "$@"; do
    psql "$DB" -qc "DELETE FROM gateway WHERE source='openrms' AND owner_sub='sub-$s'; UPDATE gateway SET owner_sub=NULL, owner_club_id=NULL, claimed_at=NULL, owner_comments='', emcomm='{}' WHERE source='winlink' AND owner_sub='sub-$s'; DELETE FROM watcher WHERE owner_sub='sub-$s'; DELETE FROM watcher_key WHERE owner_sub='sub-$s'; DELETE FROM revoked_key WHERE sub='sub-$s'; DELETE FROM account_club_member WHERE sub='sub-$s'; DELETE FROM account_cache WHERE sub='sub-$s'" >/dev/null
  done
}
crc() { node -e 'let c=0xffff;for(const b of Buffer.from(process.argv[1].toUpperCase())){c^=b<<8;for(let i=0;i<8;i++)c=c&0x8000?((c<<1)^0x1021)&0xffff:(c<<1)&0xffff}console.log(c.toString(16).toUpperCase().padStart(4,"0"))' "$1"; }
