// Runtime-agnostic Hono app. Works on both Bun (env on process.env) and Cloudflare
// Workers (env/secrets on the per-request `env` binding, exposed as `c.env`).

import { Hono } from "hono";
import { cors } from "hono/cors";
import { StreamableHTTPTransport } from "@hono/mcp";
import { ensureConfig, type EnvSource } from "./config.ts";
import { authApp } from "./auth/routes.ts";
import { requireBearer } from "./auth/middleware.ts";
import { buildMcpServer } from "./mcp/server.ts";
import { hevyRequest } from "./hevy/client.ts";

// Picks the right environment source for the current runtime. On Workers the
// bindings arrive as `c.env`; on Bun/Node they live on process.env.
function envSource(c: { env?: unknown }): EnvSource {
  const e = c.env as Record<string, string | undefined> | undefined;
  if (e && typeof e.HEVY_API_KEY === "string") return e; // Cloudflare Workers
  return process.env as EnvSource; // Bun / Node
}

export const app = new Hono();

// Initialize config from the request's environment before anything else runs.
app.use("*", async (c, next) => {
  ensureConfig(envSource(c));
  await next();
});

// Allow browser-based MCP clients (e.g. MCP Inspector) and expose the auth header.
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id", "mcp-protocol-version"],
    exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id"],
    maxAge: 86400,
  }),
);

// Unauthenticated health check for Coolify/Traefik/uptime probes.
app.get("/health", (c) => c.json({ status: "ok", service: "hevy-mcp" }));

// Read-only export for plain-GET clients, gated by EXPORT_TOKEN.
const EXPORT_PATHS: Record<string, string> = {
  workouts: "/v1/workouts",
  routines: "/v1/routines",
  templates: "/v1/exercise_templates",
};
app.get("/export/:kind", async (c) => {
  const expected = envSource(c).EXPORT_TOKEN;
  const given = c.req.query("token");
  if (!expected || !given || given !== expected) return c.text("unauthorized", 401);
  const path = EXPORT_PATHS[c.req.param("kind")];
  if (!path) return c.text("unknown export", 404);
  const data = await hevyRequest("GET", path, {
    query: { page: c.req.query("page") ?? 1, pageSize: c.req.query("pageSize") ?? 10 },
  });
  return c.json(data);
});

// OAuth: /authorize, /token, /register, /.well-known/*
app.route("/", authApp);

// The MCP endpoint, gated by bearer auth. Runs statelessly: a fresh MCP server +
// transport per request.
app.use("/mcp", requireBearer);
app.all("/mcp", async (c) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const res = await transport.handleRequest(c);
  return res ?? c.body(null, 204);
});
