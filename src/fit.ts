// Turns an original activity download (ZIP containing a .fit) into a compact running analysis.
import { unzipSync } from "fflate";
// @ts-ignore - package ships JS with loose types
import { Decoder, Stream } from "@garmin/fitsdk";

type Rec = {
  t: number; // seconds since start
  d?: number; // metres
  hr?: number;
  spm?: number; // steps per minute
  v?: number; // m/s
  alt?: number;
  pw?: number;
  gct?: number; // ms
  vo?: number; // mm
  sl?: number; // mm
};

export function extractFit(bytes: Uint8Array): Uint8Array {
  // Already a raw FIT file?
  if (bytes.length > 12 && String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === ".FIT") return bytes;
  const files = unzipSync(bytes);
  const name = Object.keys(files).find((n) => n.toLowerCase().endsWith(".fit"));
  if (!name) throw new Error(`No .fit file in download (contains: ${Object.keys(files).join(", ") || "nothing"})`);
  return files[name];
}

const r1 = (n: number | undefined, p = 1) => (n === undefined || !isFinite(n) ? undefined : Math.round(n * 10 ** p) / 10 ** p);
const avg = (xs: (number | undefined)[]) => {
  const v = xs.filter((x): x is number => typeof x === "number" && isFinite(x) && x > 0);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
};
export const pace = (mps?: number) => {
  if (!mps || mps <= 0) return undefined;
  const s = 1000 / mps;
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}/km`;
};
const hms = (s?: number) => {
  if (s === undefined) return undefined;
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(sec).padStart(2, "0")}`;
};

export interface AnalyzeOptions {
  split_m?: number;
  hr_zones?: number[]; // upper bounds of zones 1..n-1, e.g. [130,145,160,172]
}

export function analyzeFit(fitBytes: Uint8Array, opts: AnalyzeOptions = {}) {
  const decoder = new Decoder(Stream.fromByteArray(Array.from(fitBytes)));
  const { messages, errors } = decoder.read({ convertDateTimesToDates: true, includeUnknownData: false, mergeHeartRates: true });
  const raw: any[] = messages.recordMesgs || [];
  if (!raw.length) throw new Error("FIT file has no record data");
  const t0 = new Date(raw[0].timestamp).getTime();

  const recs: Rec[] = raw.map((r) => ({
    t: (new Date(r.timestamp).getTime() - t0) / 1000,
    d: r.distance,
    hr: r.heartRate,
    spm: r.cadence !== undefined ? (r.cadence + (r.fractionalCadence || 0)) * 2 : undefined,
    v: r.enhancedSpeed ?? r.speed,
    alt: r.enhancedAltitude ?? r.altitude,
    pw: r.power,
    gct: r.stanceTime,
    vo: r.verticalOscillation,
    sl: r.stepLength,
  }));

  // --- Splits ---
  const splitM = opts.split_m || 1000;
  const splits: any[] = [];
  let startIdx = 0, next = splitM;
  const pushSplit = (from: number, to: number, label: string) => {
    const seg = recs.slice(from, to + 1);
    const dist = (seg.at(-1)!.d ?? 0) - (seg[0].d ?? 0);
    const time = seg.at(-1)!.t - seg[0].t;
    let gain = 0;
    for (let i = 1; i < seg.length; i++) {
      const a = seg[i - 1].alt, b = seg[i].alt;
      if (a !== undefined && b !== undefined && b > a) gain += b - a;
    }
    if (dist < 50) return;
    splits.push({
      split: label,
      dist_m: Math.round(dist),
      time: hms(time),
      pace: pace(dist / time),
      hr: r1(avg(seg.map((x) => x.hr)), 0),
      spm: r1(avg(seg.map((x) => x.spm)), 0),
      gain_m: Math.round(gain),
      power: r1(avg(seg.map((x) => x.pw)), 0),
      gct_ms: r1(avg(seg.map((x) => x.gct)), 0),
    });
  };
  for (let i = 0; i < recs.length; i++) {
    if ((recs[i].d ?? 0) >= next) {
      pushSplit(startIdx, i, String(splits.length + 1));
      startIdx = i;
      next += splitM;
    }
  }
  if (startIdx < recs.length - 1) pushSplit(startIdx, recs.length - 1, `${splits.length + 1} (partial)`);

  // --- Aerobic decoupling: efficiency (speed/HR) first vs second half of moving time ---
  const moving = recs.filter((r) => (r.v ?? 0) > 1.5 && (r.hr ?? 0) > 60);
  let decoupling: number | undefined;
  if (moving.length > 120) {
    const half = Math.floor(moving.length / 2);
    const ef = (xs: Rec[]) => avg(xs.map((x) => x.v))! / avg(xs.map((x) => x.hr))!;
    const e1 = ef(moving.slice(0, half)), e2 = ef(moving.slice(half));
    decoupling = r1(((e1 - e2) / e1) * 100, 1);
  }

  // --- Time in HR zones ---
  let hrZones: any;
  if (opts.hr_zones?.length) {
    const bounds = [...opts.hr_zones].sort((a, b) => a - b);
    const secs = new Array(bounds.length + 1).fill(0);
    for (let i = 1; i < recs.length; i++) {
      const hr = recs[i].hr;
      if (!hr) continue;
      const dt = Math.min(recs[i].t - recs[i - 1].t, 10);
      let z = bounds.findIndex((b) => hr <= b);
      if (z === -1) z = bounds.length;
      secs[z] += dt;
    }
    const total = secs.reduce((a, b) => a + b, 0) || 1;
    hrZones = secs.map((s, i) => ({ zone: i + 1, time: hms(s), pct: Math.round((s / total) * 100) }));
  }

  const s = (messages.sessionMesgs || [])[0] || {};
  const dist = s.totalDistance ?? recs.at(-1)!.d;
  const timer = s.totalTimerTime ?? recs.at(-1)!.t;
  const dyn = {
    gct_ms: r1(s.avgStanceTime ?? avg(recs.map((r) => r.gct)), 0),
    gct_balance_pct_left: r1(s.avgStanceTimeBalance, 1),
    vertical_osc_mm: r1(s.avgVerticalOscillation ?? avg(recs.map((r) => r.vo)), 0),
    vertical_ratio_pct: r1(s.avgVerticalRatio, 1),
    step_length_mm: r1(s.avgStepLength ?? avg(recs.map((r) => r.sl)), 0),
  };

  return {
    sport: [s.sport, s.subSport].filter(Boolean).join("/") || undefined,
    start: s.startTime ? new Date(s.startTime).toISOString() : new Date(t0).toISOString(),
    summary: {
      distance_km: r1((dist ?? 0) / 1000, 2),
      moving_time: hms(timer),
      elapsed_time: hms(s.totalElapsedTime),
      avg_pace: pace(s.enhancedAvgSpeed ?? s.avgSpeed ?? (dist && timer ? dist / timer : undefined)),
      avg_hr: s.avgHeartRate ?? r1(avg(recs.map((r) => r.hr)), 0),
      max_hr: s.maxHeartRate,
      avg_spm: r1(s.avgRunningCadence !== undefined ? (s.avgRunningCadence + (s.avgFractionalCadence || 0)) * 2 : avg(recs.map((r) => r.spm)), 0),
      avg_power: s.avgPower,
      ascent_m: s.totalAscent,
      descent_m: s.totalDescent,
      calories: s.totalCalories,
      training_effect_aerobic: s.totalTrainingEffect,
      training_effect_anaerobic: s.totalAnaerobicTrainingEffect,
      training_load: r1(s.trainingLoadPeak, 0),
      aerobic_decoupling_pct: decoupling,
    },
    running_dynamics: Object.values(dyn).some((v) => v !== undefined) ? dyn : undefined,
    hr_zones: hrZones,
    splits,
    laps: (messages.lapMesgs || []).length > 1
      ? messages.lapMesgs!.map((l: any, i: number) => ({
          lap: i + 1,
          dist_m: Math.round(l.totalDistance ?? 0),
          time: hms(l.totalTimerTime),
          pace: pace(l.enhancedAvgSpeed ?? l.avgSpeed),
          hr: l.avgHeartRate,
          max_hr: l.maxHeartRate,
          spm: l.avgRunningCadence !== undefined ? Math.round((l.avgRunningCadence + (l.avgFractionalCadence || 0)) * 2) : undefined,
          intensity: l.intensity,
        }))
      : undefined,
    notes: [
      decoupling !== undefined ? "aerobic_decoupling_pct: drop in speed/HR from first to second half of moving time; under ~5% on steady runs is good aerobic durability." : undefined,
      errors?.length ? `FIT decode warnings: ${errors.length}` : undefined,
    ].filter(Boolean),
  };
}
