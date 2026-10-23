// Data for the "Today" widget: one compact snapshot in Garmin's own terms.
// Field paths verified against real Personal API responses (Oct 2026). Anything Garmin does not
// return stays absent; nothing here is estimated under a Garmin name.
import { plannedSessions } from "./coach";
import type { Ctx } from "./tools";
import { addDays, localDate, localTime, r1, trim } from "./util";

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);

export async function garminToday(ctx: Ctx, a: { date?: string } = {}) {
  const date = a.date ?? localDate(ctx.tz);
  const warnings: string[] = [];
  const soft = <T,>(label: string, p: Promise<T>) => p.catch((e: Error) => { warnings.push(`${label}: ${e.message}`); return null as T | null; });
  const [sleep, hrv, sums, fitness, planned] = await Promise.all([
    soft("sleep", ctx.g.sleep(date)),
    soft("hrv", ctx.g.hrv(date)),
    soft("daily summaries", ctx.g.dailySummaries(addDays(date, -6), date)),
    soft("fitness age", ctx.g.fitnessAge(date)),
    soft("plan", plannedSessions(ctx, date)),
  ]);

  // Fitness Age changes about once a day and its endpoint fails often (Cloudflare 526), so it is always
  // fetched live and the last good value (kept 7 days) only fills in when that call fails.
  let fitnessData: any = fitness;
  let fitnessSavedAt: string | undefined;
  if (ctx.env.STATE) {
    const saved = await ctx.env.STATE.get<{ saved_at: string; data: any }>("garmin:fitnessage", "json").catch(() => null);
    if ((fitness as any)?.fitnessAge != null) {
      if (!saved || Date.now() - Date.parse(saved.saved_at) > 6 * 3600_000) {
        await ctx.env.STATE.put("garmin:fitnessage", JSON.stringify({ saved_at: new Date().toISOString(), data: fitness }), { expirationTtl: 7 * 86400 }).catch(() => {});
      }
    } else if (saved?.data) {
      fitnessData = saved.data;
      fitnessSavedAt = saved.saved_at;
      const i = warnings.findIndex((w) => w.startsWith("fitness age"));
      if (i >= 0) warnings.splice(i, 1);
    }
  }

  const days: any[] = (sums as any)?.data ?? [];
  const today: any = days.find((d) => d.calendarDate === date) ?? days[days.length - 1] ?? {};
  const rhrs = days.map((d) => d.heartRate?.restingValue).filter((x): x is number => typeof x === "number");
  const s: any = sleep ?? {};
  const scores = s.sleepScores ?? {};
  const hs: any = (hrv as any)?.hrvSummary ?? {};
  const fa: any = fitnessData ?? {};
  const comp = fa.components ?? {};

  // How current the numbers are: Garmin's daily summary only covers up to the watch's last sync.
  const syncedUntil: string | undefined = today.wellnessChronology?.endTimestampLocal;
  const nowWall = Date.parse(`${localDate(ctx.tz)}T${localTime(ctx.tz)}:00Z`);
  const syncedAgeMin = syncedUntil && date === localDate(ctx.tz)
    ? Math.max(0, Math.round((nowWall - Date.parse(syncedUntil.slice(0, 19) + "Z")) / 60000)) : undefined;

  const snap = trim({
    date,
    fetched_at: new Date().toISOString(),
    synced_until: syncedUntil,
    synced_age_min: syncedAgeMin,
    sleep: s.sleepTimeSeconds && {
      score: scores.overall?.value, qualifier: scores.overall?.qualifierKey,
      total_s: s.sleepTimeSeconds, deep_s: s.deepSleepSeconds, light_s: s.lightSleepSeconds, rem_s: s.remSleepSeconds, awake_s: s.awakeSleepSeconds,
      start_local: s.sleepStartTimestampLocal, end_local: s.sleepEndTimestampLocal,
      need_min: s.sleepNeed?.actual, feedback: s.sleepScoreFeedback,
      stages: { deep_pct: scores.deepPercentage?.value, light_pct: scores.lightPercentage?.value, rem_pct: scores.remPercentage?.value },
    },
    body_battery: today.bodyBattery && {
      latest: today.bodyBattery.latestValue, min: today.bodyBattery.minValue, max: today.bodyBattery.maxValue,
      charged: today.bodyBattery.chargedValue, drained: today.bodyBattery.drainedValue,
      level: today.bodyBattery.dynamicFeedbackEvent?.bodyBatteryLevel,
    },
    stress: today.stress && { avg: today.stress.avgLevel, max: today.stress.maxLevel },
    hrv_status: hs.status && {
      status: hs.status, last_night: hs.lastNightAvg, weekly_avg: hs.weeklyAvg, high_5min: hs.lastNight5MinHigh,
      balanced_low: hs.baseline?.balancedLow, balanced_upper: hs.baseline?.balancedUpper,
    },
    resting_heart_rate: today.heartRate?.restingValue != null ? {
      value: today.heartRate.restingValue, avg_7d: r1(avg(rhrs), 0), min: today.heartRate.minValue, max: today.heartRate.maxValue,
    } : undefined,
    spo2: today.pulseOx && { avg: today.pulseOx.avgValue, lowest: today.pulseOx.minValue },
    respiration: today.respiration && { avg: today.respiration.avgValue, low: today.respiration.minValue, high: today.respiration.maxValue },
    steps: today.movement?.steps && { value: today.movement.steps.value, goal: today.movement.steps.goal },
    intensity_minutes: today.intensityMinutes,
    fitness_age: fa.fitnessAge != null ? {
      age: r1(fa.fitnessAge, 1), chronological: fa.chronologicalAge, previous: r1(fa.previousFitnessAge, 1),
      saved_at: fitnessSavedAt, updated: fa.lastUpdated,
      resting_hr: comp.rhr?.value, vigorous_minutes_avg: comp.vigorousMinutesAvg?.value, vigorous_days_avg: comp.vigorousDaysAvg?.value, bmi: comp.bmi?.value,
    } : undefined,
    trend_7d: days.map((d) => ({
      date: d.calendarDate, resting_hr: d.heartRate?.restingValue, stress_avg: d.stress?.avgLevel,
      body_battery_max: d.bodyBattery?.maxValue, steps: d.movement?.steps?.value,
    })),
    planned_today: (planned as any[] | null)?.map((p) => ({ kind: p.kind, title: p.title, duration_min: p.duration_min, distance_km: p.distance_km })),
    not_available: "Training Readiness, Training Status and Endurance Score are not exposed by Garmin's Personal API.",
    warnings: warnings.length ? warnings : undefined,
  });

  // Garmin sits behind Cloudflare and answers 526 from Workers for hours at a time. Keep the last good
  // snapshot (3 days, own KV) and show it, labelled, instead of an empty dashboard.
  const store = ctx.env.STATE;
  const fresh = !!(today.bodyBattery || s.sleepTimeSeconds || hs.status);
  if (!store) return snap;
  const saved = await store.get<{ saved_at: string; data: Record<string, unknown> }>("garmin:today", "json").catch(() => null);
  if (fresh) {
    if (!saved || Date.now() - Date.parse(saved.saved_at) > 10 * 60_000) {
      await store.put("garmin:today", JSON.stringify({ saved_at: new Date().toISOString(), data: { ...snap, warnings: undefined } }), { expirationTtl: 3 * 86400 }).catch(() => {});
    }
    return snap;
  }
  return saved?.data ? { ...saved.data, stale: { saved_at: saved.saved_at }, warnings: snap.warnings } : snap;
}
