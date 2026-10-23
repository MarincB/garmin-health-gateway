// All configuration. Secrets are set with `wrangler secret put`, vars live in wrangler.toml.
export interface Env {
  // --- secrets ---
  GARMIN_API_KEY: string;
  GATEWAY_SECRET: string; // long random string; part of every private URL
  ANTHROPIC_API_KEY?: string; // enables chat + written reports
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALLOWED_USER_ID?: string; // only this Telegram user can talk to the bot

  // --- vars ---
  TIMEZONE?: string; // IANA, e.g. Europe/Ljubljana
  LLM_MODEL?: string; // e.g. claude-sonnet-5-5 or claude-haiku-5-5
  ATHLETE_CONTEXT?: string; // free text: goals, race, injuries, preferences
  HR_ZONES?: string; // upper bounds of zones 1-4, e.g. "130,145,160,172"
  ENABLE_FIT_ANALYSIS?: string; // "true" needs Workers Paid (FIT parsing exceeds the free 10 ms CPU)
  REPORT_ENABLED?: string; // "true" | "false"
  REPORT_FROM?: string; // "06:00" local: start checking for synced sleep
  REPORT_BY?: string; // "08:00" local: send even if sleep is missing
  REPORT_CHANNELS?: string; // "telegram,imessage"

  // --- bindings ---
  STATE?: KVNamespace; // used by the chat channels (Telegram, iMessage)

  // --- testing overrides only ---
  GARMIN_BASE_URL?: string;
  ANTHROPIC_BASE_URL?: string;
  TELEGRAM_API_BASE?: string;
}

export const flag = (v?: string) => /^(1|true|yes|on)$/i.test(v ?? "");
export const tzOf = (env: Env) => env.TIMEZONE || "UTC";
export const modelOf = (env: Env) => env.LLM_MODEL || "claude-sonnet-5-5";
export const hrZonesOf = (env: Env) =>
  (env.HR_ZONES || "").split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
