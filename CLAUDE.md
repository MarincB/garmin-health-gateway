# Garmin Health Gateway

Open-source, self-hosted gateway that turns a Garmin Personal API key into an MCP connector
(Claude, ChatGPT, Cursor) and a REST API. Runs as one Cloudflare Worker. Owner: Blaž; built
first for his own running (half marathon goal, IT band history), published for others.

## Architecture

- `src/index.ts`: router. `/mcp/<GATEWAY_SECRET>`, `/api/<GATEWAY_SECRET>/<route>` or Bearer auth, `/health`
- `src/tools.ts`: **single tool registry** used by MCP and REST. Add new capabilities here, not in transports
- `src/mcp.ts`: stateless MCP over Streamable HTTP (`WebStandardStreamableHTTPServerTransport`, JSON responses)
- `src/rest.ts`: REST wrapper over the same tools, plus aliases
- `src/garmin.ts`: Personal API client. Routes copied from Garmin's official Python client
  (`garmin-connect-personal-api-python`). Token: POST key, get JWT, cache per isolate and in KV (`garmin:token`, the token endpoint often answers 526 from Workers), refresh 1h before expiry
- `src/fit.ts`: FIT parsing (`@garmin/fitsdk`, `fflate`) for splits, decoupling, zones, dynamics
- `src/env.ts`: all config; `src/util.ts`: dates, trimming, crypto helpers

## Constraints that shape decisions

- **Free tier CPU limit is 10 ms per request.** FIT parsing is ~70 ms for a 50-min run, so it sits
  behind `ENABLE_FIT_ANALYSIS` (Workers Paid). Keep everything else light: no heavy parsing, trim payloads
- Garmin Personal API is **pull only and read-only**. No workout upload. Some endpoints have range
  limits (sleep 31 d, steps/stress 28 d, summaries 365 d); use `windows()` in util
- Response field names come from Garmin Connect JSON and are not fully documented; mappers use
  `pick()` with fallbacks and a `raw` escape hatch. Verify against real responses before relying on new fields
- Single user per deployment. Never build multi-tenant storage of other people's health data
- Secrets only via `wrangler secret put`. Never log keys or tokens

## Commands

```bash
npm test           # local e2e: wrangler dev + mock Garmin (test/mock-garmin.mjs), synthetic FIT run
npm run typecheck
npx wrangler deploy
```

Tests must pass before committing. Extend `test/mock-garmin.mjs` when adding endpoints.

## Status

- Done: core connector + REST, 17 tools, goal coach (`src/coach.ts`, `prompts.ts`, `library.ts`, KV `STATE`), e2e suite (48 checks)
- Next: deploy with the KV namespace and try the `plan_goal` prompt in Claude; verify `athlete_baseline` against real Garmin responses
- Then: Recovery dashboard and morning report as a Claude scheduled task (free in Claude plan);
  Telegram bot with user's own Anthropic API key; iMessage relay for an always-on Mac

## Style

- Writing for users: concise, plain, no em dashes, no "100%"-style phrasing
- Coaching content: evidence-based, conservative progression, no medical diagnosis
