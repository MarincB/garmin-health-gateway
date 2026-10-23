// Garmin Health Gateway: one Cloudflare Worker that turns your Garmin Personal API key into
// an MCP connector (Claude, ChatGPT, ...) and a REST API.
//
//   /mcp/<GATEWAY_SECRET>         MCP endpoint (paste into Claude as a custom connector)
//   /api/<GATEWAY_SECRET>/<tool>  REST (or /api/<tool> with "Authorization: Bearer <GATEWAY_SECRET>")
//   /health                       public liveness check, reveals nothing
import type { Env } from "./env";
import { handleMcp } from "./mcp";
import { handleRest } from "./rest";
import { makeCtx } from "./tools";
import { garminToday } from "./dashboard";
import { safeEqual } from "./util";

const notFound = () => new Response("Not found", { status: 404 });

function secretOk(env: Env, candidate: string | undefined) {
  return !!candidate && !!env.GATEWAY_SECRET && env.GATEWAY_SECRET.length >= 24 && safeEqual(candidate, env.GATEWAY_SECRET);
}
const bearer = (req: Request) => req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return new Response("ok");

    if (!env.GATEWAY_SECRET || env.GATEWAY_SECRET.length < 24) {
      return new Response("GATEWAY_SECRET is not set or shorter than 24 characters", { status: 500 });
    }
    if (!env.GARMIN_API_KEY) return new Response("GARMIN_API_KEY is not set", { status: 500 });

    let m = pathname.match(/^\/mcp\/([^/]+)\/?$/);
    if (m) return secretOk(env, m[1]) ? handleMcp(request, env) : notFound();

    // /api/<secret>/<route>  or  /api/<route> + Bearer header
    m = pathname.match(/^\/api\/([^/]+)(?:\/([^/]*))?\/?$/);
    if (m) {
      if (m[2] !== undefined && secretOk(env, m[1])) return handleRest(request, env, m[2]);
      if (secretOk(env, bearer(request))) return handleRest(request, env, m[2] === undefined ? m[1] : `${m[1]}/${m[2]}`);
      return notFound();
    }
    return notFound();
  },

  // Refresh the dashboard snapshot in the background. Garmin answers Cloudflare 526 to most attempts
  // from Workers, so views read a snapshot that is at most one interval old instead of a live fetch.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (!env.STATE || !env.GARMIN_API_KEY) return;
    await garminToday(makeCtx(env), { refresh: true }).catch(() => {});
  },
} satisfies ExportedHandler<Env>;
