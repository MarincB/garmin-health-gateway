# Garmin Health Gateway

Your Garmin data, in any AI app. A small self-hosted gateway that turns your
[Garmin Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api/)
key into:

- **an MCP connector** for Claude (web, desktop, mobile), ChatGPT, Cursor and other MCP clients
- **a REST API** for iOS Shortcuts, scripts, bots and dashboards

It runs on your own Cloudflare account, on the free tier. Your key stays in Cloudflare's
encrypted secrets, and your health data goes from Garmin to your Worker to your AI app.
Nothing is stored, and no third party sits in between.

> Unofficial project, not affiliated with Garmin. Endpoint routes follow Garmin's official
> [`garmin-connect-personal-api-python`](https://github.com/garmin/connect-personal-api-python) client.

## What you can ask

- "How did this morning's run go?" (splits, HR drift, cadence, running dynamics)
- "Am I recovered enough for intervals today?" (sleep, HRV vs baseline, Body Battery, resting HR)
- "Is my weekly mileage ramping too fast?" (weekly km, long run, ramp %)

## Tools

| Tool | What it returns |
|---|---|
| `list_activities` | Recent activities: distance, pace, HR, cadence, training effect and load, dynamics |
| `analyze_activity` | One activity in depth. With FIT analysis on: per-km splits, laps, aerobic decoupling, running dynamics, time in HR zones |
| `training_load` | Weekly running km, hours, long run, week-over-week ramp % |
| `daily_wellness` | Sleep, HRV, Body Battery, resting HR, stress for one day |
| `wellness_trend` | The same as a daily trend over a range (handles Garmin's per-request limits) |
| `profile_and_zones` | Profile settings and Garmin HR zones |
| `get_activity`, `garmin_raw_get` | Raw activity JSON, and an allowlisted read-only escape hatch |

## Costs

| What | Cost |
|---|---|
| Hosting on Cloudflare Workers free tier | **Free** |
| FIT-file analysis (splits, decoupling, zone times) | Workers Paid, **$5/month**. Parsing a 50-minute run takes about 70 ms CPU; the free plan allows 10 ms per request. Without it you get Garmin's summary data. |
| Using the connector in Claude, including a daily scheduled report | **Included in your Claude plan.** No API key needed; counts toward your plan's usage limits. |
| Using it in ChatGPT or other apps | Whatever that app's plan includes |

## Setup (about 10 minutes)

You need Node 20+, a free [Cloudflare](https://dash.cloudflare.com/sign-up) account, and a
Garmin Personal API key (Garmin Connect web → Personal API → Create Key; it's shown once).

```bash
git clone https://github.com/<you>/garmin-health-gateway
cd garmin-health-gateway
npm install
npx wrangler login

npx wrangler secret put GARMIN_API_KEY   # paste your Garmin key
openssl rand -hex 24                     # copy the output
npx wrangler secret put GATEWAY_SECRET   # paste that random string

npx wrangler deploy
```

`deploy` prints your Worker URL, e.g. `https://garmin-health-gateway.<you>.workers.dev`.

**Treat every URL that contains `GATEWAY_SECRET` like a password.** If one leaks, set a new
secret with `npx wrangler secret put GATEWAY_SECRET`; old URLs stop working immediately.

### Configure (optional)

Edit `[vars]` in `wrangler.toml`, then `npx wrangler deploy`:

| Var | Default | Meaning |
|---|---|---|
| `TIMEZONE` | `Europe/Ljubljana` | Your IANA time zone; decides what "today" means |
| `HR_ZONES` | empty | Upper HR bound of zones 1-4, e.g. `130,145,160,172`, for time in zones |
| `ENABLE_FIT_ANALYSIS` | `false` | `true` on Workers Paid for FIT-level analysis |

## Connect it

### Claude

Settings → Connectors → Add custom connector, and paste:

```
https://garmin-health-gateway.<you>.workers.dev/mcp/<GATEWAY_SECRET>
```

No OAuth step. It now works in every Claude chat, on mobile too.

### ChatGPT

Add the same URL as a custom MCP connector (available with developer mode enabled in ChatGPT's connector settings).

### REST

```bash
# today's recovery
curl https://<worker>/api/<GATEWAY_SECRET>/today

# or keep the secret out of the URL
curl -H "Authorization: Bearer <GATEWAY_SECRET>" "https://<worker>/api/load?weeks=8"
```

Routes: `/api/tools` (list with JSON schemas), `/api/<tool_name>`, and the aliases
`today`, `latest-run`, `load`, `trend`, `activities`. Arguments go in the query string
(`?date=2026-10-22&limit=5`) or as a JSON body with POST.

## Daily morning report in Claude (free with your plan)

Ask Claude in any chat with the connector enabled:

> Every morning at 7:30, check my Garmin data and send me a recovery report: last night's
> sleep, HRV against my baseline, Body Battery, resting HR, yesterday's training and this
> week's load, and a clear verdict on whether today should be hard, easy or rest.

Claude creates a scheduled task and sends you a push notification when each report is ready.
If your watch hasn't synced last night's sleep by then, the report says so.

## Roadmap

- Telegram bot: chat with Claude about your data and get the morning report in Telegram (uses your own Anthropic API key, a cent or two per message)
- iMessage relay for an always-on Mac
- Template report with no AI at all (free, numbers only)

## Development

```bash
npm test         # runs the Worker locally against a mock Garmin API (synthetic 10 km FIT run)
npm run typecheck
```

## License

MIT
