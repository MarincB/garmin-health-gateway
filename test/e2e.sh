#!/usr/bin/env bash
# End-to-end test: runs the Worker locally against a mock Garmin API.
# Usage: npm test
set -uo pipefail
cd "$(dirname "$0")/.."
SECRET="test-secret-0123456789abcdefghij"
PASS=0; FAIL=0

cleanup() {
  pkill -f "workerd-linux" 2>/dev/null || true
  pkill -f "node_modules/.bin/wrangler dev" 2>/dev/null || true
  pkill -f "test/mock-garmin.mjs" 2>/dev/null || true
}
trap 'cleanup; rm -f .dev.vars' EXIT

start() { # $1 = ENABLE_FIT_ANALYSIS
  pkill -f "workerd-linux" 2>/dev/null || true
  pkill -f "node_modules/.bin/wrangler dev" 2>/dev/null || true
  sleep 1
  printf 'GARMIN_API_KEY="test-key"\nGATEWAY_SECRET="%s"\nGARMIN_BASE_URL="http://127.0.0.1:8799"\nENABLE_FIT_ANALYSIS="%s"\nHR_ZONES="130,142,152,165"\n' "$SECRET" "$1" > .dev.vars
  npx wrangler dev --port 8787 --ip 127.0.0.1 >/tmp/wrangler.log 2>&1 &
  for _ in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:8787/health && return; sleep 1; done
  echo "wrangler dev did not start"; cat /tmp/wrangler.log; exit 1
}

check() { # name, expected substring, actual
  if [[ "$3" == *"$2"* ]]; then PASS=$((PASS+1)); echo "  ok   $1"
  else FAIL=$((FAIL+1)); echo "  FAIL $1"; echo "       expected: $2"; echo "       got: ${3:0:400}"; fi
}

B="http://127.0.0.1:8787"
MCP="$B/mcp/$SECRET"
H=(-H "content-type: application/json" -H "accept: application/json, text/event-stream" -H "mcp-protocol-version: 2025-06-18")
rpc() { curl -s "${H[@]}" "$MCP" -d "$1"; }
tool() { rpc "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"; }
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }

cleanup; sleep 1
node test/mock-garmin.mjs >/dev/null 2>&1 &
start true

echo "Auth"
check "health is public" "200" "$(code $B/health)"
check "wrong MCP secret -> 404" "404" "$(code -X POST $B/mcp/wrong-secret-wrong-secret-xx -d '{}')"
check "REST without secret -> 404" "404" "$(code $B/api/today)"

echo "MCP"
check "initialize" '"serverInfo":{"name":"garmin-health-gateway"' "$(rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}')"
check "tools/list has 8 tools" "8" "$(rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["result"]["tools"]))')"
R=$(tool analyze_activity '{}')
check "analyze_activity FIT mode" '\"mode\":\"fit\"' "$R"
check "splits computed" '\"split\":\"10\"' "$R"
check "decoupling computed" 'aerobic_decoupling_pct' "$R"
check "HR zones from config" '\"zone\":5' "$R"
check "list_activities compact" '\"avg_pace\":\"5:00/km\"' "$(tool list_activities '{"limit":2}')"
check "training_load ramp" 'ramp_pct' "$(tool training_load '{"weeks":4}')"
check "daily_wellness trims series" 'samples omitted' "$(tool daily_wellness '{"date":"2026-10-22"}')"
check "raw path allowlist" 'Path not allowed' "$(tool garmin_raw_get '{"path":"/download-service/files/activity/1"}')"
check "bad args rejected" '"isError":true' "$(tool daily_wellness '{"date":"yesterday"}')"

echo "REST"
check "GET /api/<secret>/today" '"hrvSummary"' "$(curl -s $B/api/$SECRET/today?date=2026-10-22)"
check "Bearer auth /api/load" '"week_of"' "$(curl -s -H "Authorization: Bearer $SECRET" "$B/api/load?weeks=3")"
check "GET /api/<secret>/tools schemas" '"input_schema"' "$(curl -s $B/api/$SECRET/tools)"
check "query coercion (limit=1)" '"id":"123456789"' "$(curl -s "$B/api/$SECRET/activities?limit=1")"
check "invalid args -> 400" "400" "$(code "$B/api/$SECRET/today?date=nope")"
check "unknown tool -> 404" "404" "$(code "$B/api/$SECRET/nope")"

echo "Token caching"
check "one token exchange per isolate" "token_exchanges=1" "$(curl -s http://127.0.0.1:8799/__calls | python3 -c 'import sys,json; c=json.load(sys.stdin); print("token_exchanges=%d" % sum("token" in x for x in c))')"

echo "Free-tier mode (FIT analysis off)"
start false
check "analyze_activity summary mode" '\"mode\":\"summary\"' "$(tool analyze_activity '{}')"

echo; echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
