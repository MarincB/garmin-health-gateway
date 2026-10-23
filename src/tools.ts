// One tool registry, served over MCP, REST and (later) the chat agent.
import { z } from "zod";
import type { Env } from "./env";
import { flag, hrZonesOf, tzOf } from "./env";
import { Garmin, RAW_ALLOWED_PREFIXES } from "./garmin";
import { analyzeFit, extractFit, pace } from "./fit";
// coach.ts imports helpers back from this file. Safe because they are function declarations
// and nothing but tools.ts or index.ts imports coach.ts first.
import { COACH_TOOLS } from "./coach";
import { garminToday } from "./dashboard";
import { addDays, daysBetween, localDate, mondayOf, pick, r1, trim, windows } from "./util";

export interface Ctx { env: Env; g: Garmin; tz: string }
export const makeCtx = (env: Env): Ctx => ({ env, g: new Garmin(env), tz: tzOf(env) });

export interface Tool {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  ui?: string; // ui:// resource this tool renders into (MCP Apps); the tool still returns plain data
  run: (ctx: Ctx, args: any) => Promise<unknown>;
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const ID = z.string().regex(/^\d+$/, "numeric activity id");

// ---------- shaping Garmin responses ----------
export const listOf = (r: any): any[] => (Array.isArray(r) ? r : r?.activityList || r?.activities || r?.data || []);
const typeKey = (a: any): string => a?.activityType?.typeKey ?? a?.activityTypeDTO?.typeKey ?? "";
export const isRun = (a: any) => /running/.test(typeKey(a));

export function compactActivity(a: any) {
  const s = a.summaryDTO || {};
  const dist = pick(a, "distance") ?? s.distance;
  const dur = pick(a, "movingDuration", "duration") ?? pick(s, "movingDuration", "duration");
  const stride = pick(a, "avgStrideLength") ?? s.strideLength;
  return {
    id: String(pick(a, "activityId") ?? ""),
    name: pick(a, "activityName"),
    type: typeKey(a) || undefined,
    start_local: pick(a, "startTimeLocal") ?? s.startTimeLocal,
    distance_km: r1((dist ?? 0) / 1000, 2),
    moving_time_min: r1((dur ?? 0) / 60, 1),
    avg_pace: pace(dist && dur ? dist / dur : undefined),
    avg_hr: pick(a, "averageHR") ?? s.averageHR,
    max_hr: pick(a, "maxHR") ?? s.maxHR,
    avg_spm: r1(pick(a, "averageRunningCadenceInStepsPerMinute", "averageRunCadence") ?? s.averageRunCadence, 0),
    elev_gain_m: r1(pick(a, "elevationGain") ?? s.elevationGain, 0),
    aerobic_te: pick(a, "aerobicTrainingEffect") ?? s.trainingEffect,
    anaerobic_te: pick(a, "anaerobicTrainingEffect") ?? s.anaerobicTrainingEffect,
    training_load: r1(pick(a, "activityTrainingLoad") ?? s.activityTrainingLoad, 0),
    vo2max: pick(a, "vO2MaxValue"),
    gct_ms: r1(pick(a, "avgGroundContactTime") ?? s.groundContactTime, 0),
    vert_osc_cm: r1(pick(a, "avgVerticalOscillation") ?? s.verticalOscillation, 1),
    stride_m: stride ? r1(stride / 100, 2) : undefined,
  };
}

const safe = <T,>(p: Promise<T>) => p.catch((e: Error) => ({ error: e.message }));

// ---------- tool implementations (also used directly by REST and reports) ----------
export async function listActivities(ctx: Ctx, a: { start_date?: string; end_date?: string; limit?: number; activity_type?: string; raw?: boolean } = {}) {
  const res = await ctx.g.searchActivities({
    startDate: a.start_date ?? localDate(ctx.tz, -13), endDate: a.end_date ?? localDate(ctx.tz),
    limit: a.limit ?? 20, activityType: a.activity_type,
  });
  const list = listOf(res);
  return a.raw ? trim(list) : list.map(compactActivity);
}

export async function analyzeActivity(ctx: Ctx, a: { activity_id?: string; split_m?: number; hr_zones?: number[] } = {}) {
  let id = a.activity_id;
  let meta: any;
  if (!id) {
    const latest = listOf(await ctx.g.searchActivities({ limit: 1 }))[0];
    if (!latest) throw new Error("No activities found");
    id = String(latest.activityId);
    meta = compactActivity(latest);
  }
  if (!flag(ctx.env.ENABLE_FIT_ANALYSIS)) {
    // Free-tier mode: Garmin's own summary, no FIT parsing.
    const act = await ctx.g.activity(id);
    return {
      activity_id: id,
      mode: "summary",
      note: "FIT analysis is off (ENABLE_FIT_ANALYSIS). Splits, decoupling and zone times need Workers Paid; see README.",
      summary: meta ?? compactActivity(act),
      detail: trim(act),
    };
  }
  const zones = a.hr_zones?.length ? a.hr_zones : hrZonesOf(ctx.env);
  const fit = extractFit(await ctx.g.download(id));
  return { activity_id: id, mode: "fit", name: meta?.name, ...analyzeFit(fit, { split_m: a.split_m, hr_zones: zones.length ? zones : undefined }) };
}

export async function trainingLoad(ctx: Ctx, a: { weeks?: number } = {}) {
  const weeks = a.weeks ?? 8;
  const end = localDate(ctx.tz);
  const start = mondayOf(addDays(end, -7 * (weeks - 1)));
  const acts: any[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = listOf(await ctx.g.searchActivities({ start: offset, limit: 100, startDate: start, endDate: end }));
    acts.push(...page);
    if (page.length < 100) break;
  }
  const byWeek = new Map<string, { km: number; min: number; runs: number; long_km: number; load: number }>();
  for (let w = 0; w < weeks; w++) byWeek.set(addDays(start, 7 * w), { km: 0, min: 0, runs: 0, long_km: 0, load: 0 });
  for (const act of acts.filter(isRun)) {
    const c = compactActivity(act);
    const wk = byWeek.get(mondayOf(c.start_local || ""));
    if (!wk) continue;
    wk.km += c.distance_km || 0;
    wk.min += c.moving_time_min || 0;
    wk.runs += 1;
    wk.long_km = Math.max(wk.long_km, c.distance_km || 0);
    wk.load += c.training_load || 0;
  }
  let prev: number | undefined;
  return [...byWeek.entries()].map(([week, v]) => {
    const row = {
      week_of: week, km: r1(v.km, 1), hours: r1(v.min / 60, 2), runs: v.runs, long_run_km: r1(v.long_km, 1),
      training_load: Math.round(v.load) || undefined,
      ramp_pct: prev ? Math.round(((v.km - prev) / prev) * 100) : undefined,
      in_progress: week === mondayOf(end) || undefined,
    };
    prev = v.km || prev;
    return row;
  });
}

export async function dailyWellness(ctx: Ctx, a: { date?: string } = {}) {
  const d = a.date ?? localDate(ctx.tz);
  const [sleep, hrv, bb, summary, stress] = await Promise.all([
    safe(ctx.g.sleep(d)), safe(ctx.g.hrv(d)), safe(ctx.g.bodyBattery(d, d, 24)), safe(ctx.g.dailySummaries(d, d)), safe(ctx.g.stress(d, d)),
  ]);
  return trim({ date: d, sleep, hrv, body_battery: bb, daily_summary: summary, stress });
}

export async function wellnessTrend(ctx: Ctx, a: { start_date?: string; end_date?: string } = {}) {
  const e = a.end_date ?? localDate(ctx.tz);
  const s = a.start_date ?? addDays(e, -13);
  if (daysBetween(s, e) < 0) throw new Error("start_date is after end_date");
  if (daysBetween(s, e) > 180) throw new Error("Keep the range to 180 days or less");
  const [hrv, sleep, summaries, bb] = await Promise.all([
    safe(windows(s, e, 28, (x, y) => ctx.g.hrvSummaries(x, y))),
    safe(windows(s, e, 31, (x, y) => ctx.g.sleepSummaries(x, y))),
    safe(windows(s, e, 365, (x, y) => ctx.g.dailySummaries(x, y))),
    safe(windows(s, e, 31, (x, y) => ctx.g.bodyBattery(x, y, 1))),
  ]);
  return trim({ range: [s, e], hrv, sleep, daily_summaries: summaries, body_battery: bb });
}

// ---------- registry ----------
export const TOOLS: Tool[] = [
  {
    name: "list_activities",
    description: "List recent Garmin activities (newest first) with compact running metrics: distance, pace, HR, cadence, training effect/load, dynamics. Default: last 14 days.",
    shape: {
      start_date: DATE.optional(), end_date: DATE.optional(),
      limit: z.number().int().min(1).max(100).optional(),
      activity_type: z.string().optional().describe("Garmin typeKey, e.g. running, trail_running, cycling"),
      raw: z.boolean().optional().describe("Return Garmin's full JSON instead of the compact view"),
    },
    run: listActivities,
  },
  {
    name: "get_activity",
    description: "Garmin's summary/detail JSON for one activity (long numeric series trimmed).",
    shape: { activity_id: ID, include_workouts: z.boolean().optional() },
    run: async (ctx, a) => {
      const [act, wo] = await Promise.all([ctx.g.activity(a.activity_id), a.include_workouts ? ctx.g.activityWorkouts(a.activity_id) : null]);
      return trim({ activity: act, workouts: wo ?? undefined });
    },
  },
  {
    name: "analyze_activity",
    description: "Deep analysis of one activity (default: latest). With FIT analysis on: per-km splits, laps, aerobic decoupling, running dynamics, time in HR zones. Otherwise Garmin's summary.",
    shape: {
      activity_id: ID.optional(),
      split_m: z.number().int().min(100).max(10000).optional().describe("Split length in metres, default 1000"),
      hr_zones: z.array(z.number().int()).optional().describe("Upper HR bound of each zone except the last, e.g. [130,145,160,172]"),
    },
    run: analyzeActivity,
  },
  {
    name: "training_load",
    description: "Weekly running volume for the last N weeks: km, time, runs, longest run, week-over-week ramp %. Use to spot load spikes and injury risk.",
    shape: { weeks: z.number().int().min(1).max(26).optional() },
    run: trainingLoad,
  },
  {
    name: "daily_wellness",
    description: "Recovery snapshot for one day: sleep (score, stages), HRV (overnight avg, baseline, status), Body Battery, resting HR, stress. Default: today.",
    shape: { date: DATE.optional() },
    run: dailyWellness,
  },
  {
    name: "wellness_trend",
    description: "Daily trend over a date range: HRV, sleep, daily summaries (resting HR, steps, stress), Body Battery. Default: last 14 days.",
    shape: { start_date: DATE.optional(), end_date: DATE.optional() },
    run: wellnessTrend,
  },
  {
    name: "garmin_today",
    description: "Today at a glance in Garmin's own terms: Sleep Score, Body Battery, Stress, HRV Status, Resting Heart Rate, SpO2, Respiration, Steps, Fitness Age, 7-day trend and today's planned session. Shows as a dashboard widget in clients that support it.",
    shape: { date: DATE.optional() },
    ui: "ui://garmin/today",
    run: garminToday,
  },
  {
    name: "fitness_age",
    description: "Garmin Fitness Age for a date (default today), with the factors Garmin uses, e.g. VO2 max, resting HR, activity, body composition.",
    shape: { date: DATE.optional() },
    run: async (ctx, a) => trim(await ctx.g.fitnessAge(a.date ?? localDate(ctx.tz))),
  },
  {
    name: "profile_and_zones",
    description: "User profile settings and Garmin heart-rate zones.",
    shape: {},
    run: async (ctx) => trim({ zones: await safe(ctx.g.hrZones()), profile: await safe(ctx.g.profile()) }),
  },
  {
    name: "garmin_raw_get",
    description: `Read-only escape hatch: GET any Garmin Personal API path under ${RAW_ALLOWED_PREFIXES.join(", ")}. Long series are trimmed.`,
    shape: {
      path: z.string().describe("e.g. /hrv-service/hrv/2026-10-22"),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    },
    run: async (ctx, a) => {
      if (!a.path.startsWith("/") || a.path.includes("..") || !RAW_ALLOWED_PREFIXES.some((p) => a.path.startsWith(p))) {
        throw new Error("Path not allowed");
      }
      return trim(await ctx.g.get(a.path, a.params));
    },
  },
  ...COACH_TOOLS,
];

export async function runTool(ctx: Ctx, name: string, rawArgs: unknown) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const args = z.object(tool.shape).parse(rawArgs ?? {});
  return tool.run(ctx, args);
}
