// Plain JSON API for Shortcuts, scripts, bots and dashboards.
//   GET  /api/tools                      -> tool list with JSON schemas
//   GET  /api/<tool>?arg=value            -> run a tool
//   POST /api/<tool>   {json args}        -> run a tool
//   Aliases: /api/today, /api/latest-run, /api/load, /api/trend
import { z } from "zod";
import type { Env } from "./env";
import { makeCtx, runTool, TOOLS } from "./tools";

const ALIASES: Record<string, string> = {
  today: "daily_wellness",
  "latest-run": "analyze_activity",
  load: "training_load",
  trend: "wellness_trend",
  activities: "list_activities",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

// Query strings are all text; coerce the obvious types.
function coerce(v: string): unknown {
  if (/^(true|false)$/.test(v)) return v === "true";
  if (/^-?\d+(\.\d+)?$/.test(v) && !/^\d{4}-/.test(v)) return Number(v);
  if (v.includes(",") && v.split(",").every((x) => /^\d+$/.test(x.trim()))) return v.split(",").map((x) => Number(x.trim()));
  return v;
}

export async function handleRest(request: Request, env: Env, route: string): Promise<Response> {
  if (route === "tools" || route === "") {
    return json(TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: z.toJSONSchema(z.object(t.shape)) })));
  }
  const name = ALIASES[route] ?? route.replace(/-/g, "_");
  let args: Record<string, unknown> = {};
  if (request.method === "POST") {
    try { args = (await request.json()) as Record<string, unknown>; } catch { return json({ error: "Body must be JSON" }, 400); }
  } else if (request.method === "GET") {
    for (const [k, v] of new URL(request.url).searchParams) if (k !== "key") args[k] = coerce(v);
  } else {
    return json({ error: "Use GET or POST" }, 405);
  }
  try {
    return json(await runTool(makeCtx(env), name, args));
  } catch (e) {
    if (e instanceof z.ZodError) return json({ error: "Invalid arguments", issues: e.issues }, 400);
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, /Unknown tool/.test(msg) ? 404 : 502);
  }
}
