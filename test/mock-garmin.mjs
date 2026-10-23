// Fake Garmin Personal API for local testing. Serves a synthetic 10 km run as FIT.
import http from "node:http";
import { Encoder, Profile } from "@garmin/fitsdk";
import { zipSync } from "fflate";

const MS = (d) => d.getTime();
function buildFit() {
  const enc = new Encoder();
  const start = new Date("2026-10-22T06:30:00Z");
  enc.onMesg(Profile.MesgNum.FILE_ID, { type: "activity", manufacturer: "garmin", product: 0, timeCreated: start, serialNumber: 1 });
  let dist = 0;
  const N = 3000; // ~50 min, 1 Hz
  for (let i = 0; i < N; i++) {
    const v = 3.33 + Math.sin(i / 300) * 0.1; // ~5:00/km
    dist += v;
    enc.onMesg(Profile.MesgNum.RECORD, {
      timestamp: new Date(MS(start) + i * 1000),
      distance: dist,
      enhancedSpeed: v,
      heartRate: Math.round(140 + (i / N) * 12), // drifts up 140 -> 152
      cadence: 85, fractionalCadence: 0.5, // 171 spm
      enhancedAltitude: 300 + Math.sin(i / 200) * 8,
      stanceTime: 245, verticalOscillation: 85, stepLength: 1170,
    });
  }
  enc.onMesg(Profile.MesgNum.LAP, { timestamp: new Date(MS(start) + N * 1000), startTime: start, totalDistance: dist / 2, totalTimerTime: N / 2, avgHeartRate: 143 });
  enc.onMesg(Profile.MesgNum.LAP, { timestamp: new Date(MS(start) + N * 1000), startTime: start, totalDistance: dist / 2, totalTimerTime: N / 2, avgHeartRate: 149 });
  enc.onMesg(Profile.MesgNum.SESSION, {
    timestamp: new Date(MS(start) + N * 1000), startTime: start, sport: "running", subSport: "road",
    totalDistance: dist, totalTimerTime: N, totalElapsedTime: N + 30, avgHeartRate: 146, maxHeartRate: 155,
    avgRunningCadence: 85, avgFractionalCadence: 0.5, totalAscent: 60, totalDescent: 58,
  });
  return enc.close();
}
const zip = zipSync({ "123456789_ACTIVITY.fit": buildFit() });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = `${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;

const runs = [];
for (let w = 0; w < 6; w++) for (let r = 0; r < 4; r++) {
  const d = new Date(Date.now() - (w * 7 + r * 2) * 86400000);
  const km = 6 + r * 2 + (w === 0 ? 3 : 0);
  runs.push({
    activityId: 123456789 - w * 10 - r, activityName: `Run ${w}-${r}`, activityType: { typeKey: "running" },
    startTimeLocal: d.toISOString().slice(0, 10) + " 07:00:00", distance: km * 1000, movingDuration: km * 300,
    averageHR: 145, maxHR: 160, averageRunningCadenceInStepsPerMinute: 171, elevationGain: 50,
    aerobicTrainingEffect: 3.1, activityTrainingLoad: km * 10,
  });
}

let calls = [];
let dataFailures = 1; // first data request also answers 526
let failMode = ""; // /__fail?on=1: every data request answers 526; on=fitness: only Fitness Age does
let tokenFailures = 1; // first token exchange answers 526 like the real host sometimes does
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  calls.push(`${req.method} ${u.pathname}`);
  if (u.pathname === "/__fail") { const on = u.searchParams.get("on"); failMode = on === "1" ? "all" : on === "fitness" ? "fitness" : ""; res.end("ok"); return; }
  if (u.pathname === "/__calls") { res.end(JSON.stringify(calls)); return; }
  if (req.method === "POST" && u.pathname.endsWith("/personal-api-key/token")) {
    if (req.headers.authorization !== "ApiKey test-key") { res.writeHead(401).end("bad key"); return; }
    if (tokenFailures-- > 0) { res.writeHead(526).end("flaky"); return; }
    res.end(fakeJwt); return;
  }
  if (req.headers.authorization !== `Bearer ${fakeJwt}`) { res.writeHead(401).end("no token"); return; }
  if (failMode === "all" || (failMode === "fitness" && u.pathname.startsWith("/fitnessage-service/")) || dataFailures-- > 0) { res.writeHead(526).end("flaky"); return; }
  if (u.pathname.startsWith("/download-service/files/activity/")) {
    res.writeHead(200, { "content-type": "application/zip" }).end(Buffer.from(zip)); return;
  }
  if (u.pathname === "/activitylist-service/activities/search/activities") {
    const start = +u.searchParams.get("start"), limit = +u.searchParams.get("limit");
    res.end(JSON.stringify(runs.slice(start, start + limit))); return;
  }
  if (u.pathname.startsWith("/hrv-service/hrv/")) {
    res.end(JSON.stringify({ hrvSummary: { lastNightAvg: 52, weeklyAvg: 55, status: "BALANCED" }, hrvReadings: Array.from({ length: 80 }, () => 50) })); return;
  }
  if (u.pathname === "/sleep-service/sleep/dailySleep") {
    res.end(JSON.stringify({ dailySleepDTO: { sleepScores: { overall: { value: 78 } }, deepSleepSeconds: 5400 } })); return;
  }
  if (u.pathname.startsWith("/fitnessage-service/fitnessage/v2/")) {
    res.end(JSON.stringify({ chronologicalAge: 36, fitnessAge: 30.1, previousFitnessAge: 30.4, components: { rhr: { value: 41 } }, lastUpdated: "2026-10-22T00:00:00.0" })); return;
  }
  if (u.pathname === "/usersummary-service/v2/dailysummaries") {
    const day = new Date().toISOString().slice(0, 10);
    res.end(JSON.stringify({ data: [{ calendarDate: day, wellnessChronology: { endTimestampLocal: day + "T04:00:00.0" }, heartRate: { restingValue: 41, minValue: 38, maxValue: 90 }, bodyBattery: { latestValue: 77, minValue: 30, maxValue: 90 }, stress: { avgLevel: 22, maxLevel: 60 } }] })); return;
  }
  res.end(JSON.stringify({ path: u.pathname, ok: true }));
}).listen(8799, () => console.log("mock garmin on 8799"));
