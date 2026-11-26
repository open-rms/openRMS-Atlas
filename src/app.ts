import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestLogger } from "./lib/reqlog.js";
import { swaggerUI } from "@hono/swagger-ui";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";
import { publicRoutes } from "./routes/public.js";
import { compatRoutes } from "./routes/compat.js";
import { ownerRoutes } from "./routes/owner.js";
import { adminRoutes } from "./routes/admin.js";
import { dumpRoutes } from "./routes/dumps.js";
import { hookRoutes } from "./routes/hooks.js";
import { watcherRoutes, watchRoutes } from "./routes/watch.js";
import { KEY_SCOPES } from "./lib/apikeys.js";

const specPath = fileURLToPath(new URL("../../openRMS-Spec/atlas/openapi.yaml", import.meta.url));

export function createApp() {
  const app = new Hono();
  if (process.env.NODE_ENV !== "test") app.use("*", requestLogger());

  const origins = env.TRUSTED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  app.use("/api/v1/*", cors({
    origin: (o) => (origins.includes(o) ? o : "*"),
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization", "x-api-key"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }));


  app.route("/api/v1", publicRoutes);
  app.route("/api/v1", ownerRoutes);
  app.route("/api/v1/hooks", hookRoutes);
  app.route("/api/v1/me/watchers", watcherRoutes);
  app.route("/api/v1/watch", watchRoutes);
  app.route("/api/v1/admin", adminRoutes);
  app.route("/api/v1/dumps", dumpRoutes);
  app.route("/", compatRoutes);

  app.get("/api/v1/openapi.yaml", (c) => {
    if (!existsSync(specPath)) return c.text("spec not found", 404);
    return c.body(readFileSync(specPath, "utf8"), 200, { "Content-Type": "application/yaml", "Access-Control-Allow-Origin": "*" });
  });
  app.get("/docs", swaggerUI({ url: "/api/v1/openapi.yaml" }));
  // OAuth Protected Resource Metadata (RFC 9728): Accounts reads openrms_key_scopes to offer
  // the scopes an Atlas key may carry (identity.md §5.2).
  app.get("/.well-known/oauth-protected-resource", (c) => {
    const issuers = env.OPENRMS_ISSUER.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
    return c.json({
      resource: env.OPENRMS_AUDIENCE.replace(/\/+$/, ""),
      resource_name: "openRMS Atlas",
      authorization_servers: issuers,
      bearer_methods_supported: ["header"],
      scopes_supported: KEY_SCOPES.map((s) => s.scope),
      openrms_key_scopes: KEY_SCOPES,
      resource_documentation: `${env.PUBLIC_URL.replace(/\/+$/, "")}/docs`,
    }, 200, { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" });
  });
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/", (c) => c.json({
    name: "openRMS Atlas",
    docs: "/docs",
    openapi: "/api/v1/openapi.yaml",
    identity: "openRMS Accounts (OPENRMS_ISSUER); send Authorization: Bearer <access token or ormk_ API key>",
    keyScopes: "/.well-known/oauth-protected-resource",
    winlinkCompatible: "/gateway/status.json",
    patCacheFile: "/export/pat/rmslist.json",
  }));
  return app;
}
