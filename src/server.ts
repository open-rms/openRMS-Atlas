import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { env } from "./env.js";
import { migrate } from "./migrate.js";
import { startWinlinkPoller } from "./winlink/import.js";
import { startAccountsReconcile } from "./accounts/reconcile.js";

await migrate();
startWinlinkPoller();
startAccountsReconcile();
serve({ fetch: createApp().fetch, port: env.PORT, hostname: env.HOST }, (i) =>
  console.log(`openRMS Atlas listening on ${i.address}:${i.port}`),
);
