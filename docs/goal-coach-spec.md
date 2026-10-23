# Spec: Goal coach

Let a user say "I want to run a half marathon next year" and get an interview, a plan,
workouts and mobility work, grounded in their real Garmin data and kept up to date.

## Principle

The AI client (Claude, ChatGPT) does the talking. The gateway supplies three things it
can't do alone:

1. **Facts:** an athlete baseline computed from Garmin, so the plan starts from real fitness
2. **Memory:** goal, interview answers and plan stored in the gateway, so they survive across
   chats, apps and devices
3. **Structure:** an MCP prompt that drives the interview, and a fixed plan schema so plans
   are consistent and machine-readable (dashboard, morning report, future Telegram bot)

## User flow

1. User picks the `plan_goal` prompt (shows as a slash command or "Add from Garmin Health Gateway"
   in Claude), or just says "I want to run 21 km next year".
2. Claude calls `athlete_baseline` and shows what it sees ("you run ~32 km/week, recent 10 km pace...").
3. Claude interviews, **one or two questions at a time**, skipping anything Garmin already answers:
   - Goal: distance, target date or race, target time or "just finish"
   - Availability: days per week, which days, max session length, long-run day
   - History: years running, recent races and times, longest run in last 3 months
   - Injuries and niggles: current and past, what helps (e.g. IT band, mobility work helps)
   - Constraints: terrain, treadmill, gym access, family or work schedule
   - Preferences: HR or pace based, strength training appetite, cross-training
4. Claude summarizes answers, user confirms, Claude calls `set_goal`.
5. Claude builds the plan (periodized: base, build, peak, taper), calls `save_plan`.
6. Ongoing: `get_today` returns today's session plus recovery data; Claude adapts
   ("HRV low, swap intervals for easy 40 min") and records changes with `update_plan`.

## Storage

Cloudflare KV binding `STATE` (free tier: 1k writes/day, plenty).

| Key | Value |
|---|---|
| `goal` | Goal JSON (schema below) |
| `plan` | Plan JSON (schema below) |
| `plan:history` | Last 20 plan versions, for "what changed?" |

Single user per deployment, so no user ids. Add KV to `wrangler.toml`; README step:
`npx wrangler kv namespace create STATE`.

## Tools (add to `src/tools.ts`)

| Tool | Args | Returns |
|---|---|---|
| `athlete_baseline` | `weeks?` (default 12) | Weekly km avg and max, runs/week, longest run, easy pace and HR, best recent efforts (fastest 5k/10k/half within runs, from activity list), VO2max if present, resting HR and HRV baseline, HR zones |
| `get_goal` | none | Stored goal or `null` |
| `set_goal` | Goal JSON | Saved goal; validates with zod |
| `get_plan` | `week?` (ISO Monday) | Whole plan, or one week |
| `save_plan` | Plan JSON | Saved plan; keeps previous version in history |
| `update_plan` | `changes`: list of `{date, session}` plus `reason` | Patched plan; logs reason |
| `get_today` | `date?` | Today's planned session, mobility block, recovery snapshot (`daily_wellness`), last activity, and whether yesterday's session was done (matched against activities by date and type) |
| `plan_progress` | none | Planned vs done km per week, sessions completed, adherence |

## Schemas (zod, in `src/coach.ts`)

```ts
Goal = {
  type: "race" | "distance" | "time" | "general_fitness",
  distance_km?: number,          // 21.1
  target_date?: string,          // YYYY-MM-DD
  race_name?: string,
  target_time?: string,          // "1:35:00" or "finish"
  days_per_week: number,
  preferred_days?: string[],     // ["tue","thu","sat","sun"]
  long_run_day?: string,
  max_session_min?: number,
  injuries?: { area: string, status: "current" | "past", notes?: string }[],
  constraints?: string,
  preferences?: { intensity_by?: "hr" | "pace" | "rpe", strength?: boolean, cross_training?: string[] },
  created_at: string
}

Session = {
  date: string,
  kind: "easy" | "long" | "tempo" | "intervals" | "hills" | "race" | "rest" | "strength" | "mobility" | "cross",
  title: string,                 // "6 x 800 m @ 4:10"
  duration_min?: number,
  distance_km?: number,
  target?: { pace?: string, hr_zone?: number, rpe?: number },
  structure?: { warmup?: string, main: string, cooldown?: string },
  mobility?: string[],           // routine ids from the mobility library
  notes?: string
}

Plan = {
  goal_ref: string,              // goal.created_at
  phases: { name: "base" | "build" | "peak" | "taper", start: string, end: string, focus: string }[],
  weeks: { week_of: string, target_km: number, focus: string, sessions: Session[] }[],
  rules: string[],               // e.g. "max +10% weekly km", "skip intervals if HRV status LOW"
  version: number,
  updated_at: string
}
```

## Mobility and strength library

Static data in `src/library.ts`, also exposed as an MCP **resource** (`library://mobility`)
and via a tool `get_routine(id)`. Each routine: id, name, duration, when to use,
exercises with sets, reps or hold time, and a short cue.

Starter set (evidence-based, conservative, no medical claims):
- `itb-hip-mobility`: hip flexor stretch, figure-4, glute bridge, clamshells, side-lying leg raise
- `itb-strength`: single-leg glute bridge, lateral band walk, side plank, single-leg RDL, step-down
- `pre-run-dynamic`: leg swings, walking lunges, A-skips, high knees
- `post-run`: calf, hamstring, quad, hip flexor holds
- `runner-core`: dead bug, bird dog, plank, side plank
- `foam-roll`: quads, glutes, TFL, calves (around the IT band, not on it)

Plans reference routines by id; the AI picks them based on injuries in the goal
(an IT band history means `itb-*` twice a week by default).

## MCP prompt

Register with `server.registerPrompt("plan_goal", ...)` in `src/mcp.ts`. Argument:
optional `goal` text. The prompt body tells the model to:

1. Call `get_goal` and `athlete_baseline` first.
2. Interview with one or two questions per turn, never a questionnaire dump; skip what
   the data answers; confirm a summary before saving.
3. Respect safe progression: about 10% weekly km increase at most, a cutback week every 3-4 weeks,
   80/20 easy/hard, a taper of 1-3 weeks by distance.
4. Be honest about unrealistic targets and offer a realistic range from the baseline.
5. Save with `set_goal` and `save_plan`, then show week 1 and explain the structure.
6. Never diagnose injuries; for pain that changes gait or worsens, recommend a physio.

Add a second prompt `today` that calls `get_today` and gives a go/adjust/rest verdict.

## Workouts on the watch

The Personal API is read-only, so the gateway can't push workouts to Garmin. Options to
document, not build now:
- Pair with a connector that can (e.g. Running Workout), using our plan as the source
- Export a session as a `.fit` workout file via a REST route, for manual import

## Morning report integration

When a plan exists, the Claude scheduled-task report (README) should call `get_today` and
include the planned session plus a verdict. Update the README prompt text.

## Tests (extend `test/e2e.sh`)

- KV round trip: `set_goal` → `get_goal`, `save_plan` → `get_plan`, version increments
- `update_plan` patches one date and keeps history
- `get_today` matches a done session against a mock activity
- `athlete_baseline` numbers from mock activities (known averages)
- Prompt listed by `prompts/list` and returns text via `prompts/get`
- Zod rejects a malformed plan
