// Date, formatting and payload-size helpers shared across the gateway.

export function localDate(tz: string, offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
export function localTime(tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}
export function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string) {
  return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000);
}
export function mondayOf(date: string) {
  const d = new Date(date.slice(0, 10) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
// Split [s,e] into windows of maxDays and run fn on each, in order.
export async function windows<T>(s: string, e: string, maxDays: number, fn: (a: string, b: string) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let a = s; daysBetween(a, e) >= 0; a = addDays(a, maxDays)) {
    const b = daysBetween(addDays(a, maxDays - 1), e) >= 0 ? addDays(a, maxDays - 1) : e;
    out.push(await fn(a, b));
  }
  return out;
}
// Drop long time series so responses stay small enough for an LLM.
export function trim(v: any, depth = 0): any {
  if (Array.isArray(v)) {
    if (v.length > 30 && v.every((x) => typeof x === "number" || Array.isArray(x) || x === null)) return `[${v.length} samples omitted]`;
    if (depth > 0 && v.length > 100) return `[${v.length} entries omitted; query a shorter range]`;
    return v.map((x) => trim(x, depth + 1));
  }
  if (v && typeof v === "object") {
    const o: any = {};
    for (const [k, x] of Object.entries(v)) if (x !== null && x !== undefined) o[k] = trim(x, depth + 1);
    return o;
  }
  return v;
}
export const r1 = (n: any, p = 1) => (typeof n === "number" && isFinite(n) ? Math.round(n * 10 ** p) / 10 ** p : undefined);
export const pick = (o: any, ...keys: string[]) => {
  for (const k of keys) if (o?.[k] !== undefined && o?.[k] !== null) return o[k];
  return undefined;
};
export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
