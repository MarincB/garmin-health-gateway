// Thin client for Garmin's Personal API.
// Routes mirror Garmin's official client (garmin-connect-personal-api-python 1.0.0).

import type { Env } from "./env";

const DEFAULT_BASE = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const REFRESH_WINDOW_S = 60 * 60;

// Per-isolate cache. A cold start simply exchanges the key again.
let cached: { token: string; exp: number; keyHash: string } | null = null;
let inflight: Promise<string> | null = null;

export class GarminError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function jwtExp(token: string): number {
  try {
    const p = token.split(".")[1];
    const json = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (p.length % 4)) % 4)));
    return Number(json.exp);
  } catch {
    // Garmin documents 24h validity; assume less to be safe.
    return Date.now() / 1000 + 20 * 3600;
  }
}

export class Garmin {
  base: string;
  constructor(private env: Env) {
    this.base = (env.GARMIN_BASE_URL || DEFAULT_BASE).replace(/\/$/, "");
  }

  // Parallel calls on a cold isolate share one exchange instead of each doing their own
  // (every attempt counts toward the 50-subrequest limit on the free plan).
  private token(force = false): Promise<string> {
    if (force) return this.exchange(true);
    return (inflight ??= this.exchange(false).finally(() => { inflight = null; }));
  }

  private async exchange(force: boolean): Promise<string> {
    const keyHash = await sha(this.base + "\0" + this.env.GARMIN_API_KEY);
    const now = Date.now() / 1000;
    if (!force && cached && cached.keyHash === keyHash && cached.exp - now > REFRESH_WINDOW_S) {
      return cached.token;
    }
    // Shared across isolates through the user's own KV: the token endpoint is flaky from Workers
    // (526), so one successful exchange per day beats one per cold start.
    if (!force && this.env.STATE) {
      const hit = await this.env.STATE.get<{ token: string; exp: number; keyHash: string }>("garmin:token", "json").catch(() => null);
      if (hit && hit.keyHash === keyHash && hit.exp - now > REFRESH_WINDOW_S) {
        cached = hit;
        return hit.token;
      }
    }
    // Cloudflare sometimes answers 526 for this host from a Worker; it clears on retry.
    let res!: Response;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 250 * attempt));
      try {
        res = await fetch(this.base + TOKEN_PATH, { method: "POST", headers: { Accept: "*/*", Authorization: `ApiKey ${this.env.GARMIN_API_KEY}` } });
      } catch (e) {
        if (attempt === 5) throw e;
        continue;
      }
      if (res.status < 500) break;
    }
    if (!res.ok) {
      throw new GarminError(res.status, `Token exchange failed (${res.status}). ${res.status < 500 ? "Is the Garmin API key valid and not expired?" : "Garmin or Cloudflare error, try again."}`);
    }
    const token = (await res.text()).trim();
    cached = { token, exp: jwtExp(token), keyHash };
    if (this.env.STATE) {
      const ttl = Math.floor(cached.exp - now - REFRESH_WINDOW_S);
      if (ttl >= 60) await this.env.STATE.put("garmin:token", JSON.stringify(cached), { expirationTtl: ttl }).catch(() => {});
    }
    return token;
  }

  private async request(path: string, params?: Record<string, string | number | boolean | undefined>, accept = "application/json"): Promise<Response> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    let fresh = false; // 401: token revoked early, retry once with a fresh one
    // About 8 in 10 single attempts hit Cloudflare 526 from Workers, independently, so many quick
    // attempts beat a few slow ones. Worst case stays well under the 50 subrequests per call.
    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 120 * attempt));
      let res: Response;
      try {
        res = await fetch(url, { headers: { Accept: accept, Authorization: `Bearer ${await this.token(fresh)}` } });
      } catch (e) {
        if (attempt === 7) throw e;
        continue;
      }
      if (res.status === 401 && !fresh) { fresh = true; continue; }
      if (res.status >= 500 && attempt < 7) continue; // Cloudflare 526 in front of Garmin clears on retry
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new GarminError(res.status, `Garmin GET ${path} failed (${res.status}): ${body}`);
      }
      return res;
    }
    throw new GarminError(401, "Unauthorized after token refresh");
  }

  async get(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<any> {
    const res = await this.request(path, params);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async download(activityId: string): Promise<Uint8Array> {
    if (!/^\d+$/.test(activityId)) throw new GarminError(400, "activity_id must be numeric");
    const res = await this.request(`/download-service/files/activity/${activityId}`, undefined,
      "application/zip, application/x-zip-compressed, application/octet-stream");
    return new Uint8Array(await res.arrayBuffer());
  }

  // --- Endpoints (official routes) ---
  searchActivities(p: { start?: number; limit?: number; startDate?: string; endDate?: string; activityType?: string }) {
    return this.get("/activitylist-service/activities/search/activities", {
      start: p.start ?? 0, limit: p.limit ?? 20, startDate: p.startDate, endDate: p.endDate, activityType: p.activityType,
    });
  }
  activity(id: string) { return this.get(`/activity-service/activity/${id}`); }
  activityWorkouts(id: string) { return this.get(`/activity-service/activity/${id}/workouts`); }
  sleep(date: string) { return this.get("/sleep-service/sleep/dailySleep", { date }); }
  sleepSummaries(s: string, e: string) { return this.get("/sleep-service/sleep/dailySleepSummariesByDate", { startDate: s, endDate: e }); }
  hrv(date: string) { return this.get(`/hrv-service/hrv/${date}`); }
  hrvSummaries(s: string, e: string) { return this.get(`/hrv-service/hrv/daily/${s}/${e}`); }
  bodyBattery(s: string, e: string, chunks?: number) {
    return this.get("/wellness-service/wellness/bodyBattery/reports/daily", { startDate: s, endDate: e, chunks });
  }
  dailySummaries(s: string, e: string) { return this.get("/usersummary-service/v2/dailysummaries", { startDate: s, endDate: e }); }
  stress(s: string, e: string) { return this.get(`/usersummary-service/stats/stress/daily/${s}/${e}`); }
  dailyHeartRate(date: string) { return this.get("/wellness-service/wellness/dailyHeartRate", { date }); }
  fitnessAge(date: string) { return this.get(`/fitnessage-service/fitnessage/v2/${date}`); }
  hrZones() { return this.get("/biometric-service/heartRateZones/v2"); }
  profile() { return this.get("/userprofile-service/userprofile/settings"); }
  weight(s: string, e: string) { return this.get(`/weight-service/weight/range/${s}/${e}`, { includeAll: "true" }); }
}

// Read-only path prefixes the raw tool may call.
export const RAW_ALLOWED_PREFIXES = [
  "/activitylist-service/", "/activity-service/", "/sleep-service/", "/hrv-service/", "/wellness-service/",
  "/usersummary-service/", "/biometric-service/", "/userprofile-service/", "/fitnessage-service/",
  "/weight-service/", "/metrics-service/", "/wellnessactivity-service/", "/goal-service/", "/nutrition-service/",
];
