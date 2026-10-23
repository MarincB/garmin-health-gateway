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
trap 'cleanup; rm -f .dev.vars .wrangler-test.toml' EXIT

# Same config as production plus a local KV binding for the goal coach.
{ sed '/^\[\[kv_namespaces\]\]/,$d' wrangler.toml; printf '\n[[kv_namespaces]]\nbinding = "STATE"\nid = "test-state"\n'; } > .wrangler-test.toml

start() { # $1 = ENABLE_FIT_ANALYSIS
  pkill -f "workerd-linux" 2>/dev/null || true
  pkill -f "node_modules/.bin/wrangler dev" 2>/dev/null || true
  sleep 1
  printf 'GARMIN_API_KEY="test-key"\nGATEWAY_SECRET="%s"\nGARMIN_BASE_URL="http://127.0.0.1:8799"\nENABLE_FIT_ANALYSIS="%s"\nHR_ZONES="130,142,152,165"\n' "$SECRET" "$1" > .dev.vars
  npx wrangler dev -c .wrangler-test.toml --test-scheduled --port 8787 --ip 127.0.0.1 >/tmp/wrangler.log 2>&1 &
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
rm -rf .wrangler/state # local KV from earlier runs
node test/mock-garmin.mjs >/dev/null 2>&1 &
start true

echo "Auth"
check "health is public" "200" "$(code $B/health)"
check "wrong MCP secret -> 404" "404" "$(code -X POST $B/mcp/wrong-secret-wrong-secret-xx -d '{}')"
check "REST without secret -> 404" "404" "$(code $B/api/today)"

echo "MCP"
check "initialize" '"serverInfo":{"name":"garmin-health-gateway"' "$(rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}')"
check "tools/list has 19 tools" "19" "$(rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["result"]["tools"]))')"
R=$(tool analyze_activity '{}')
check "analyze_activity FIT mode" '\"mode\":\"fit\"' "$R"
check "splits computed" '\"split\":\"10\"' "$R"
check "decoupling computed" 'aerobic_decoupling_pct' "$R"
check "HR zones from config" '\"zone\":5' "$R"
check "list_activities compact" '\"avg_pace\":\"5:00/km\"' "$(tool list_activities '{"limit":2}')"
check "training_load ramp" 'ramp_pct' "$(tool training_load '{"weeks":4}')"
check "daily_wellness trims series" 'samples omitted' "$(tool daily_wellness '{"date":"2026-10-22"}')"
check "fitness_age route" 'fitnessAge' "$(tool fitness_age '{"date":"2026-10-22"}')"
check "raw path allowlist" 'Path not allowed' "$(tool garmin_raw_get '{"path":"/download-service/files/activity/1"}')"
check "bad args rejected" '"isError":true' "$(tool daily_wellness '{"date":"yesterday"}')"

echo "Goal coach"
D=$(python3 -c 'import datetime as d; print(d.datetime.now(d.timezone.utc).date())')
PLAN=$(python3 - <<'PY'
import datetime as d, json
t = d.datetime.now(d.timezone.utc).date()
def s(n, kind, title, km=None):
    x = {"date": str(t - d.timedelta(days=n)), "kind": kind, "title": title}
    if km: x["distance_km"] = km
    return x
weeks = {}
for x in [s(2, "easy", "Easy 6 km", 6), s(1, "tempo", "Tempo 5 km", 5), s(0, "easy", "Easy 8 km", 8)]:
    dt = d.date.fromisoformat(x["date"]); mon = str(dt - d.timedelta(days=dt.weekday()))
    weeks.setdefault(mon, []).append(x)
print(json.dumps({"phases": [{"name": "base", "start": min(weeks), "end": str(t), "focus": "aerobic base"}],
  "weeks": [{"week_of": k, "target_km": 20, "focus": "base", "sessions": v} for k, v in sorted(weeks.items())],
  "rules": ["max +10% weekly km"]}))
PY
)
check "get_goal empty at start" 'null' "$(tool get_goal '{}')"
check "save_plan needs a goal" 'Save a goal first' "$(tool save_plan "$PLAN")"
check "set_goal" 'created_at' "$(tool set_goal '{"type":"race","distance_km":21.1,"target_date":"2027-04-18","days_per_week":4,"injuries":[{"area":"IT band","status":"past"}]}')"
check "get_goal round trip" 'IT band' "$(tool get_goal '{}')"
check "set_goal rejects bad type" '"isError":true' "$(tool set_goal '{"type":"swim","days_per_week":4}')"
check "save_plan v1" 'version\":1' "$(tool save_plan "$PLAN")"
check "save_plan v2 increments" 'version\":2' "$(tool save_plan "$PLAN")"
check "zod rejects malformed plan" '"isError":true' "$(tool save_plan '{"phases":[],"weeks":[],"rules":[]}')"
check "non-Monday week rejected" 'not a Monday' "$(tool save_plan "$(echo "$PLAN" | python3 -c 'import sys,json,datetime as d; p=json.load(sys.stdin); w=p["weeks"][0]; w["week_of"]=str(d.date.fromisoformat(w["week_of"])+d.timedelta(days=1)); print(json.dumps(p))')")"
check "get_plan one week" 'Easy 6 km' "$(tool get_plan "{\"week\":\"$(echo "$PLAN" | python3 -c 'import sys,json; print(json.load(sys.stdin)["weeks"][0]["week_of"])')\"}")"
Y2=$(python3 -c 'import datetime as d; print(d.datetime.now(d.timezone.utc).date()-d.timedelta(days=2))')
Y1=$(python3 -c 'import datetime as d; print(d.datetime.now(d.timezone.utc).date()-d.timedelta(days=1))')
R=$(tool get_today "{\"date\":\"$Y1\"}")
check "get_today matches done session" 'done\":true' "$R"
R=$(tool get_today "{\"date\":\"$D\"}")
check "get_today: missed session not done" 'done\":false' "$R"
check "get_today includes recovery" 'hrvSummary' "$R"
R=$(tool update_plan "{\"changes\":[{\"date\":\"$D\",\"session\":{\"date\":\"$D\",\"kind\":\"mobility\",\"title\":\"Mobility only\",\"mobility\":[\"itb-hip-mobility\"]}}],\"reason\":\"HRV low\"}")
check "update_plan patches one date" 'Mobility only' "$R"
check "update_plan bumps version" 'version\":3' "$R"
check "update_plan logs reason in history" 'HRV low' "$(tool get_plan '{"history":true}')"
R=$(tool update_plan "{\"changes\":[{\"date\":\"$D\",\"session\":{\"date\":\"$D\",\"kind\":\"mobility\",\"title\":\"x\",\"mobility\":[\"nope\"]}}],\"reason\":\"test\"}")
check "update_plan rejects unknown routine" 'Unknown mobility routine' "$R"
check "plan_progress counts done sessions" 'sessions_done' "$(tool plan_progress '{}')"
check "get_routine by id" 'Figure-4' "$(tool get_routine '{"id":"itb-hip-mobility"}')"
R=$(tool athlete_baseline '{"weeks":6}')
check "athlete_baseline longest run" 'longest_run\":{\"km\":15' "$R"
check "athlete_baseline weekly km" 'weekly_km' "$R"
check "athlete_baseline best efforts" '10k' "$R"
check "garmin_today declares its widget" 'ui://garmin/today' "$(rpc '{"jsonrpc":"2.0","id":8,"method":"tools/list"}')"
R=$(rpc '{"jsonrpc":"2.0","id":9,"method":"resources/read","params":{"uri":"ui://garmin/today"}}')
check "widget resource has the MCP Apps mime type" 'text/html;profile=mcp-app' "$R"
check "widget resource carries the page" 'ui/initialize' "$R"
R=$(tool garmin_today '{}')
check "garmin_today returns structuredContent" 'structuredContent' "$R"
check "garmin_today says what Garmin does not expose" 'Training Readiness' "$R"
check "garmin_today has Body Battery from summaries" 'latest\":77' "$R"
check "garmin_today says when the data was loaded" 'fetched_at' "$R"
check "garmin_today says how far the watch synced" 'synced_until' "$R"
check "garmin_today has live Fitness Age" 'age\":30.1' "$R"
curl -s "http://127.0.0.1:8799/__fail?on=fitness" >/dev/null
R=$(tool garmin_today '{}')
check "Fitness Age falls back to the saved value" 'saved_at' "$R"
check "fallback keeps the number" 'age\":30.1' "$R"
check "only Fitness Age failed, so the page is not marked stale" "whole-page-fresh" "$(echo "$R" | python3 -c 'import sys,json; d=json.loads(json.load(sys.stdin)["result"]["content"][0]["text"]); print("whole-page-stale" if "stale" in d else "whole-page-fresh")')"
curl -s "http://127.0.0.1:8799/__fail?on=0" >/dev/null
curl -s "http://127.0.0.1:8799/__fail?on=sleep" >/dev/null
R=$(tool garmin_today '{}')
check "a section Garmin did not return is filled from the saved snapshot" 'filled_from_saved' "$R"
check "the filled section is Sleep Score" 'score\":78' "$R"
check "partial failure is not marked stale" "whole-page-fresh" "$(echo "$R" | python3 -c 'import sys,json; d=json.loads(json.load(sys.stdin)["result"]["content"][0]["text"]); print("whole-page-stale" if "stale" in d else "whole-page-fresh")')"
curl -s "http://127.0.0.1:8799/__fail?on=0" >/dev/null
check "scheduled refresh runs" "Ran scheduled event" "$(curl -s "http://127.0.0.1:8787/__scheduled?cron=*%2F15+*+*+*+*")"
curl -s "http://127.0.0.1:8799/__fail?on=0" >/dev/null
curl -s "http://127.0.0.1:8799/__fail?on=1" >/dev/null
R=$(tool garmin_today '{}')
check "garmin_today serves the saved snapshot during a Garmin outage" 'stale' "$R"
check "stale snapshot still has the data" 'latest\":77' "$R"
curl -s "http://127.0.0.1:8799/__fail?on=0" >/dev/null
echo "MCP prompts"
check "prompts/list" 'plan_goal' "$(rpc '{"jsonrpc":"2.0","id":4,"method":"prompts/list"}')"
check "prompts/get plan_goal" 'athlete_baseline' "$(rpc '{"jsonrpc":"2.0","id":5,"method":"prompts/get","params":{"name":"plan_goal","arguments":{"goal":"half marathon"}}}')"
check "prompts/get today" 'get_today' "$(rpc '{"jsonrpc":"2.0","id":6,"method":"prompts/get","params":{"name":"today"}}')"
check "resource library://mobility" 'itb-strength' "$(rpc '{"jsonrpc":"2.0","id":7,"method":"resources/read","params":{"uri":"library://mobility"}}')"

echo "REST"
check "GET /api/<secret>/today" '"hrvSummary"' "$(curl -s $B/api/$SECRET/today?date=2026-10-22)"
check "Bearer auth /api/load" '"week_of"' "$(curl -s -H "Authorization: Bearer $SECRET" "$B/api/load?weeks=3")"
check "GET /api/<secret>/tools schemas" '"input_schema"' "$(curl -s $B/api/$SECRET/tools)"
check "query coercion (limit=1)" '"id":"123456789"' "$(curl -s "$B/api/$SECRET/activities?limit=1")"
check "invalid args -> 400" "400" "$(code "$B/api/$SECRET/today?date=nope")"
check "unknown tool -> 404" "404" "$(code "$B/api/$SECRET/nope")"

echo "Token caching"
check "token exchange retried once after 526, then cached" "token_exchanges=2" "$(curl -s http://127.0.0.1:8799/__calls | python3 -c 'import sys,json; c=json.load(sys.stdin); print("token_exchanges=%d" % sum("token" in x for x in c))')"

echo "Free-tier mode (FIT analysis off)"
start false
check "analyze_activity summary mode" '\"mode\":\"summary\"' "$(tool analyze_activity '{}')"

echo; echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
