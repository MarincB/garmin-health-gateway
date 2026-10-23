// MCP over Streamable HTTP (stateless): Claude, ChatGPT, Cursor and any MCP client.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Env } from "./env";
import { makeCtx, TOOLS } from "./tools"; // keep before ./prompts and ./library imports (see tools.ts)
import { planGoalPrompt, todayPrompt } from "./prompts";
import { ROUTINES } from "./library";

const INSTRUCTIONS =
  "Read-only access to the user's own Garmin Connect data (activities, sleep, HRV, Body Battery, resting HR, training load). " +
  "Check the data before answering questions about the user's training or recovery. Distances are km, paces min/km. " +
  "Say when a value is your estimate rather than a Garmin measurement.";

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    // Stateless server: no SSE stream or sessions.
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  }
  const ctx = makeCtx(env);
  const server = new McpServer({ name: "garmin-health-gateway", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  for (const t of TOOLS) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.shape }, async (args: any) => {
      try {
        return { content: [{ type: "text" as const, text: JSON.stringify(await t.run(ctx, args)) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] };
      }
    });
  }
  server.registerPrompt("plan_goal", {
    description: "Interview me about a running goal and build a training plan from my Garmin data",
    argsSchema: { goal: z.string().optional().describe('e.g. "half marathon in spring"') },
  }, ({ goal }) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: planGoalPrompt(ctx.tz, goal) } }] }));
  server.registerPrompt("today", {
    description: "Go, adjust or rest: today's session against my recovery data",
  }, () => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: todayPrompt(ctx.tz) } }] }));
  server.registerResource("mobility-library", "library://mobility", {
    description: "Mobility and strength routines referenced by training plans", mimeType: "application/json",
  }, (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(ROUTINES) }] }));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
