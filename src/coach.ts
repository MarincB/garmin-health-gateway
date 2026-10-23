// Goal coach: goal and plan stored in KV, athlete baseline from Garmin, today's session.
// Spec: docs/goal-coach-spec.md. Tools are registered through tools.ts (single registry).
import { z } from "zod";
import { hrZonesOf } from "./env";
import { ROUTINES, routineById } from "./library";
import { compactActivity, dailyWellness, isRun, listOf } from "./tools";
import type { Ctx, Tool } from "./tools";
import { addDays, daysBetween, localDate, mondayOf, r1, trim } from "./util";
import { pace } from "./fit";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const DAY = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const KINDS = ["easy", "long", "tempo", "intervals", "hills", "race", "rest", "strength", "mobility", "cross"] as const;
const RUN_KINDS = new Set<string>(["easy", "long", "tempo", "intervals", "hills", "race"]);

// ---------- schemas ----------
export const GoalInput = z.object({
  type: z.enum(["race", "distance", "time", "general_fitness"]),
  distance_km: z.number().positive().max(250).optional(),
  target_date: DATE.optional(),
  race_name: z.string().optional(),
  target_time: z.string().optional().describe('"1:35:00" or "finish"'),
  days_per_week: z.number().int().min(1).max(7),
  preferred_days: z.array(DAY).optional(),
  long_run_day: DAY.optional(),
  max_session_min: z.number().int().positive().optional(),
  injuries: z.array(z.object({
    area: z.string(), status: z.enum(["current", "past"]), notes: z.string().optional(),
  })).optional(),
  constraints: z.string().optional(),
  preferences: z.object({
    intensity_by: z.enum(["hr", "pace", "rpe"]).optional(),
    strength: z.boolean().optional(),
    cross_training: z.array(z.string()).optional(),
  }).optional(),
});
const Goal = GoalInput.extend({ created_at: z.string() });
export type Goal = z.infer<typeof Goal>;

const SessionShape = {
  date: DATE,
  kind: z.enum(KINDS),
  title: z.string().describe('e.g. "6 x 800 m @ 4:10"'),
  duration_min: z.number().positive().optional(),
  distance_km: z.number().nonnegative().optional(),
  target: z.object({ pace: z.string().optional(), hr_zone: z.number().int().min(1).max(5).optional(), rpe: z.number().min(1).max(10).optional() }).optional(),
  structure: z.object({ warmup: z.string().optional(), main: z.string(), cooldown: z.string().optional() }).optional(),
  mobility: z.array(z.string()).optional().describe("Routine ids from get_routine"),
  notes: z.string().optional(),
};
const Session = z.object(SessionShape);
export type Session = z.infer<typeof Session>;

const PhaseShape = z.object({ name: z.enum(["base", "build", "peak", "taper"]), start: DATE, end: DATE, focus: z.string() });
const WeekShape = z.object({ week_of: DATE, target_km: z.number().nonnegative(), focus: z.string(), sessions: z.array(Session) });
const PlanBody = {
  goal_ref: z.string().optional().describe("goal.created_at; defaults to the stored goal"),
  phases: z.array(PhaseShape).min(1),
  weeks: z.array(WeekShape).min(1).max(60),
  rules: z.array(z.string()),
};
const Plan = z.object({ ...PlanBody, goal_ref: z.string(), version: z.number().int(), updated_at: z.string() });
export type Plan = z.infer<typeof Plan>;
interface HistoryEntry { version: number; saved_at: string; reason?: string; plan: Plan }

// ---------- storage ----------
function kv(ctx: Ctx): KVNamespace {
  if (!ctx.env.STATE) throw new Error("The goal coach needs the STATE KV namespace. See README: npx wrangler kv namespace create STATE");
  return ctx.env.STATE;
}
const getGoal = async (ctx: Ctx) => (await kv(ctx).get<Goal>("goal", "json")) ?? null;
const getPlan = async (ctx: Ctx) => (await kv(ctx).get<Plan>("plan", "json")) ?? null;
const getHistory = async (ctx: Ctx) => (await kv(ctx).get<HistoryEntry[]>("plan:history", "json")) ?? [];

async function putPlan(ctx: Ctx, next: Omit<Plan, "version" | "updated_at">, reason?: string): Promise<Plan> {
  const prev = await getPlan(ctx);
  const plan: Plan = { ...next, version: (prev?.version ?? 0) + 1, updated_at: new Date().toISOString() };
  const store = kv(ctx);
  if (prev) {
    const history = [{ version: prev.version, saved_at: prev.updated_at, reason, plan: prev }, ...(await getHistory(ctx))].slice(0, 20);
    await store.put("plan:history", JSON.stringify(history));
  }
  await store.put("plan", JSON.stringify(plan));
  return plan;
}

// Cross-field checks that a flat zod shape can't express.
function checkWeeks(weeks: z.infer<typeof WeekShape>[]) {
  for (const w of weeks) {
    if (mondayOf(w.week_of) !== w.week_of) throw new Error(`week_of ${w.week_of} is not a Monday`);
    for (const s of w.sessions) {
      const off = daysBetween(w.week_of, s.date);
      if (off < 0 || off > 6) throw new Error(`Session "${s.title}" on ${s.date} is outside the week of ${w.week_of}`);
      for (const id of s.mobility ?? []) if (!routineById(id)) throw new Error(`Unknown mobility routine "${id}"; see get_routine`);
    }
  }
}

// ---------- activities ----------
async function activitiesBetween(ctx: Ctx, start: string, end: string) {
  const acts: any[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = listOf(await ctx.g.searchActivities({ start: offset, limit: 100, startDate: start, endDate: end }));
    acts.push(...page);
    if (page.length < 100) break;
  }
  return acts;
}
const dateOf = (c: { start_local?: string }) => (c.start_local || "").slice(0, 10);
const median = (xs: number[]) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// Numbers stored under `key` anywhere in a Garmin JSON blob (field layout isn't fully documented).
const collect = (v: any, key: string, out: number[] = []): number[] => {
  if (Array.isArray(v)) v.forEach((x) => collect(x, key, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === key && typeof x === "number" && x > 0) out.push(x);
      else collect(x, key, out);
    }
  }
  return out;
};
const fmtTime = (sec: number) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
  return `${h ? h + ":" + String(m).padStart(2, "0") : m}:${String(s).padStart(2, "0")}`;
};

type Compact = Omit<ReturnType<typeof compactActivity>, "distance_km"> & { distance_km: number };
const compact = (a: any): Compact => { const c = compactActivity(a); return { ...c, distance_km: c.distance_km ?? 0 }; };
function activityMatches(kind: string, c: Compact) {
  const t = c.type || "";
  if (RUN_KINDS.has(kind)) return /running/.test(t);
  if (kind === "strength") return /strength|training/.test(t);
  if (kind === "mobility") return /yoga|pilates|stretch|mobility/.test(t);
  if (kind === "cross") return !/running/.test(t);
  return false;
}

// ---------- tools ----------
export async function athleteBaseline(ctx: Ctx, a: { weeks?: number } = {}) {
  const weeks = a.weeks ?? 12;
  const today = localDate(ctx.tz);
  const start = mondayOf(addDays(today, -7 * (weeks - 1)));
  const runs = (await activitiesBetween(ctx, start, today)).filter(isRun).map(compact);

  const perWeek = new Map<string, { km: number; runs: number }>();
  for (let w = 0; w < weeks; w++) perWeek.set(addDays(start, 7 * w), { km: 0, runs: 0 });
  for (const r of runs) {
    const wk = perWeek.get(mondayOf(dateOf(r)));
    if (wk) { wk.km += r.distance_km || 0; wk.runs += 1; }
  }
  // The running week is partial, so it stays out of the averages when there is a full week to use.
  const thisWeek = mondayOf(today);
  const done = [...perWeek.entries()].filter(([w]) => w !== thisWeek || weeks === 1).map(([, v]) => v);
  const kms = done.map((v) => v.km);
  const longest = runs.reduce<Compact | undefined>((m, r) => (!m || r.distance_km > m.distance_km ? r : m), undefined);

  // "Easy" = runs in zone 1-2 when HR zones are configured, else the lower half by average HR.
  const withHr = runs.filter((r) => r.avg_hr && r.distance_km > 1);
  const z2 = hrZonesOf(ctx.env)[1];
  const hrCut = z2 ?? median(withHr.map((r) => r.avg_hr as number));
  const easy = hrCut ? withHr.filter((r) => (r.avg_hr as number) <= hrCut) : [];
  const speed = (r: Compact) => (r.moving_time_min ? (r.distance_km * 1000) / (r.moving_time_min * 60) : 0);
  const easySpeed = median(easy.map(speed).filter(Boolean));

  const efforts: Record<string, unknown> = {};
  for (const [name, km] of [["5k", 5], ["10k", 10], ["half", 21.0975]] as const) {
    const cand = runs.filter((r) => r.distance_km >= km * 0.97 && r.distance_km <= km * 1.25 && speed(r) > 0);
    const best = cand.sort((x, y) => speed(y) - speed(x))[0];
    if (best) efforts[name] = { avg_pace: pace(speed(best)), time_for_distance: fmtTime((km * 1000) / speed(best)), run_km: best.distance_km, date: dateOf(best), activity_id: best.id };
  }

  const wStart = addDays(today, -13);
  const [summaries, hrv, zones] = await Promise.all([
    ctx.g.dailySummaries(wStart, today).catch(() => null),
    ctx.g.hrvSummaries(wStart, today).catch(() => null),
    ctx.g.hrZones().catch(() => null),
  ]);
  const rhr = median(collect(summaries, "restingHeartRate"));
  return trim({
    range: [start, today],
    weeks_analyzed: done.length,
    weekly_km: { avg: r1(kms.reduce((s, x) => s + x, 0) / Math.max(kms.length, 1)), max: r1(Math.max(0, ...kms)), by_week: [...perWeek.entries()].map(([w, v]) => ({ week_of: w, km: r1(v.km), runs: v.runs })) },
    runs_per_week: r1(done.reduce((s, v) => s + v.runs, 0) / Math.max(done.length, 1)),
    longest_run: longest && { km: longest.distance_km, date: dateOf(longest), activity_id: longest.id },
    easy_run: easySpeed ? { pace: pace(easySpeed), avg_hr: Math.round(median(easy.map((r) => r.avg_hr as number)) ?? 0) || undefined, n: easy.length } : undefined,
    best_efforts: { note: "Whole runs of about that distance, not segments inside longer runs; treat as approximate.", ...efforts },
    vo2max: runs.find((r) => r.vo2max)?.vo2max,
    resting_hr: r1(rhr, 0),
    hrv: { baseline: r1(median(collect(hrv, "weeklyAvg")), 0), last_night: r1(median(collect(hrv, "lastNightAvg")), 0), note: "Median over the last 14 days" },
    hr_zones: zones,
  });
}

async function today(ctx: Ctx, a: { date?: string } = {}) {
  const date = a.date ?? localDate(ctx.tz);
  const [plan, goal] = await Promise.all([getPlan(ctx), getGoal(ctx)]);
  const sessionsOn = (d: string) => plan?.weeks.flatMap((w) => w.sessions).filter((s) => s.date === d) ?? [];
  const yesterday = addDays(date, -1);
  const [wellness, acts] = await Promise.all([
    dailyWellness(ctx, { date }).catch((e: Error) => ({ error: e.message })),
    activitiesBetween(ctx, addDays(date, -7), date).then((l) => l.map(compact)),
  ]);
  const planned = sessionsOn(date).map((s) => ({ ...s, routines: (s.mobility ?? []).map((id) => routineById(id)).filter(Boolean) }));
  const prev = sessionsOn(yesterday).filter((s) => s.kind !== "rest").map((s) => {
    const m = acts.find((c) => dateOf(c) === yesterday && activityMatches(s.kind, c));
    return { date: s.date, kind: s.kind, title: s.title, done: !!m, activity: m && { id: m.id, distance_km: m.distance_km, avg_pace: m.avg_pace } };
  });
  const last = acts[0];
  return trim({
    date,
    goal: goal && { type: goal.type, distance_km: goal.distance_km, target_date: goal.target_date, target_time: goal.target_time, injuries: goal.injuries },
    plan_week: plan?.weeks.find((w) => daysBetween(w.week_of, date) >= 0 && daysBetween(w.week_of, date) <= 6)?.focus,
    planned: planned.length ? planned : plan ? "No session planned today" : "No plan saved yet; use the plan_goal prompt",
    rules: plan?.rules,
    yesterday: prev.length ? prev : undefined,
    recovery: wellness,
    last_activity: last,
  });
}

async function planProgress(ctx: Ctx) {
  const plan = await getPlan(ctx);
  if (!plan) throw new Error("No plan saved yet");
  const today = localDate(ctx.tz);
  const start = plan.weeks[0].week_of;
  if (daysBetween(start, today) < 0) return { plan_version: plan.version, note: `The plan starts ${start}`, weeks: [] };
  const from = daysBetween(start, today) > 364 ? addDays(today, -364) : start;
  const acts = (await activitiesBetween(ctx, from, today)).map(compact);
  const rows = plan.weeks.filter((w) => daysBetween(w.week_of, today) >= 0).map((w) => {
    const end = addDays(w.week_of, 6);
    const actual = acts.filter((c) => dateOf(c) >= w.week_of && dateOf(c) <= end && /running/.test(c.type || ""));
    const due = w.sessions.filter((s) => s.kind !== "rest" && s.date <= today);
    const used = new Set<string>();
    const completed = due.filter((s) => {
      const m = acts.find((c) => dateOf(c) === s.date && activityMatches(s.kind, c) && !used.has(c.id));
      if (m) used.add(m.id);
      return !!m;
    });
    const plannedKm = w.sessions.reduce((t, s) => t + (s.distance_km ?? 0), 0) || w.target_km;
    return {
      week_of: w.week_of, focus: w.focus, planned_km: r1(plannedKm), target_km: w.target_km,
      done_km: r1(actual.reduce((t, c) => t + (c.distance_km || 0), 0)),
      sessions_due: due.length, sessions_done: completed.length,
      adherence_pct: due.length ? Math.round((completed.length / due.length) * 100) : undefined,
      in_progress: end >= today || undefined,
    };
  });
  const finished = rows.filter((r) => !r.in_progress && r.sessions_due);
  return {
    plan_version: plan.version, weeks: rows,
    overall_adherence_pct: finished.length ? Math.round(finished.reduce((t, r) => t + (r.adherence_pct ?? 0), 0) / finished.length) : undefined,
  };
}

export const COACH_TOOLS: Tool[] = [
  {
    name: "athlete_baseline",
    description: "Athlete baseline from Garmin: weekly km (avg, max), runs per week, longest run, easy pace and HR, best recent efforts, VO2max, resting HR, HRV baseline, HR zones. Call this first when planning.",
    shape: { weeks: z.number().int().min(2).max(26).optional().describe("Default 12") },
    run: athleteBaseline,
  },
  {
    name: "get_goal",
    description: "The stored training goal (interview answers), or null if none.",
    shape: {},
    run: getGoal,
  },
  {
    name: "set_goal",
    description: "Save the training goal after the user confirmed the interview summary. Replaces any previous goal.",
    shape: GoalInput.shape,
    run: async (ctx, a) => {
      const goal: Goal = { ...a, created_at: new Date().toISOString() };
      await kv(ctx).put("goal", JSON.stringify(goal));
      return goal;
    },
  },
  {
    name: "get_plan",
    description: "The stored training plan: whole plan, or one week by its Monday. history=true lists earlier versions with reasons.",
    shape: { week: DATE.optional().describe("ISO Monday"), history: z.boolean().optional() },
    run: async (ctx, a) => {
      const plan = await getPlan(ctx);
      if (a.history) return (await getHistory(ctx)).map(({ version, saved_at, reason }) => ({ version, saved_at, reason }));
      if (!plan || !a.week) return plan;
      const week = plan.weeks.find((w) => w.week_of === a.week);
      if (!week) throw new Error(`No week of ${a.week} in the plan`);
      return { version: plan.version, rules: plan.rules, week };
    },
  },
  {
    name: "save_plan",
    description: "Save a full periodized plan (phases, weeks with sessions, rules). Needs a goal first. The previous version is kept in history. Week starts must be Mondays; sessions must fall in their week.",
    shape: PlanBody,
    run: async (ctx, a) => {
      const goal = await getGoal(ctx);
      if (!goal) throw new Error("Save a goal first with set_goal");
      checkWeeks(a.weeks);
      return putPlan(ctx, { ...a, goal_ref: a.goal_ref ?? goal.created_at }, "Full plan saved");
    },
  },
  {
    name: "update_plan",
    description: "Patch the plan: each change replaces all sessions on that date with the given session. Give a reason; it is logged in history.",
    shape: {
      changes: z.array(z.object({ date: DATE, session: z.object(SessionShape).nullable().describe("null removes the day's sessions") })).min(1).max(30),
      reason: z.string().min(3),
    },
    run: async (ctx, a) => {
      const plan = await getPlan(ctx);
      if (!plan) throw new Error("No plan saved yet");
      const weeks = structuredClone(plan.weeks);
      for (const ch of a.changes as { date: string; session: Session | null }[]) {
        const week = weeks.find((w) => daysBetween(w.week_of, ch.date) >= 0 && daysBetween(w.week_of, ch.date) <= 6);
        if (!week) throw new Error(`${ch.date} is outside the plan`);
        week.sessions = week.sessions.filter((s) => s.date !== ch.date);
        if (ch.session) week.sessions.push({ ...ch.session, date: ch.date });
        week.sessions.sort((x, y) => x.date.localeCompare(y.date));
      }
      checkWeeks(weeks);
      const { version: _v, updated_at: _u, ...rest } = plan;
      return putPlan(ctx, { ...rest, weeks, rules: rest.rules }, a.reason);
    },
  },
  {
    name: "get_today",
    description: "Today's planned session with mobility routines, recovery snapshot (sleep, HRV, Body Battery), last activity, and whether yesterday's session was done. Use it for a go/adjust/rest call.",
    shape: { date: DATE.optional() },
    run: today,
  },
  {
    name: "plan_progress",
    description: "Planned vs done km per week, sessions completed and adherence, matched against Garmin activities by date and type.",
    shape: {},
    run: planProgress,
  },
  {
    name: "get_routine",
    description: "Mobility and strength routines (exercises, sets, reps, cues). Without id: list all. Ids are used in Session.mobility.",
    shape: { id: z.string().optional() },
    run: async (_ctx, a) => {
      if (!a.id) return ROUTINES.map(({ id, name, duration_min, when }) => ({ id, name, duration_min, when }));
      const r = routineById(a.id);
      if (!r) throw new Error(`Unknown routine "${a.id}"`);
      return r;
    },
  },
];
