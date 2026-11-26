// Atlas staff tools. Every route requires a staff role from the caller's Accounts token
// (moderator, admin, superadmin) and the specific permission in src/rbac.ts; actions go to the
// Atlas's audit log. Users, roles, callsign verification and clubs are managed in
// openRMS-Accounts.
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { q } from "../db/pool.js";
import { invalidateDirectory } from "../data.js";
import { importWinlink } from "../winlink/import.js";
import { invalidatePolicy } from "../watch/project.js";
import { requireViewer, type Viewer } from "../lib/identity.js";
import { can, permissionsOf, roleOf } from "../rbac.js";

type Vars = { Variables: { viewer: Viewer; role: string; userId: string } };
export const adminRoutes = new Hono<Vars>();

adminRoutes.use("*", requireViewer, async (c, next) => {
  const v = c.get("viewer");
  if (roleOf(v.role) === "user") return c.json({ error: "staff only" }, 403);
  c.set("role", v.role);
  c.set("userId", v.sub);
  await next();
});

async function audit(c: { get: (k: "userId") => string }, action: string, target: string, detail?: unknown) {
  await q(`INSERT INTO audit_log (actor_sub, action, target, detail) VALUES ($1, $2, $3, $4)`, [
    c.get("userId"), action, target, detail === undefined ? null : JSON.stringify(detail),
  ]);
}

/** Route guard: the caller's role must grant these permissions. */
const need = (perms: Parameters<typeof can>[1]) =>
  createMiddleware<Vars>(async (c, next) => {
    if (!can(c.get("role"), perms)) return c.json({ error: "your role doesn't allow this" }, 403);
    await next();
  });

adminRoutes.get("/me", (c) => c.json({ role: roleOf(c.get("role")), permissions: permissionsOf(c.get("role")) }));


adminRoutes.get("/audit", need({ audit: ["view"] }), async (c) => {
  const { rows } = await q(
    `SELECT a.*, u.callsign AS actor_callsign FROM audit_log a LEFT JOIN account_cache u ON u.sub = a.actor_sub ORDER BY a.id DESC LIMIT 200`,
  );
  return c.json({ entries: rows });
});





adminRoutes.post("/gateways/:id/hide", need({ gateway: ["hide"] }), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { hidden?: boolean; reason?: string };
  const { rowCount } = await q(`UPDATE gateway SET hidden = $2, hidden_reason = $3 WHERE id = $1`, [
    c.req.param("id"), body.hidden ?? true, body.reason ?? null,
  ]);
  if (rowCount) await audit(c, "gateway.hide", c.req.param("id"), { hidden: body.hidden ?? true, reason: body.reason });
  invalidateDirectory();
  return rowCount ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

adminRoutes.get("/reports", need({ report: ["list"] }), async (c) => {
  const { rows } = await q(
    `SELECT r.*, g.callsign FROM abuse_report r LEFT JOIN gateway g ON g.id = r.gateway_id WHERE r.resolved_at IS NULL ORDER BY r.created_at`,
  );
  return c.json({ reports: rows });
});

adminRoutes.post("/reports/:id/resolve", need({ report: ["resolve"] }), async (c) => {
  await q(`UPDATE abuse_report SET resolved_at = now() WHERE id = $1`, [c.req.param("id")]);
  await audit(c, "report.resolve", c.req.param("id"));
  return c.json({ ok: true });
});

adminRoutes.get("/imports", need({ import: ["view"] }), async (c) => {
  const { rows } = await q(`SELECT * FROM import_run ORDER BY id DESC LIMIT 50`);
  return c.json({ imports: rows });
});

adminRoutes.post("/imports/winlink", need({ import: ["run"] }), async (c) => {
  try {
    const r = await importWinlink({ force: c.req.query("force") === "true" });
    await audit(c, "import.winlink", "winlink", r);
    return c.json(r);
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// ── Watchers, site settings, opt-outs ──────────────────────────────────────────────────

adminRoutes.get("/watchers", need({ watcher: ["list"] }), async (c) => {
  const { rows } = await q(
    `SELECT w.id, w.name, w.gridsquare, w.public, w.disabled, w.disabled_reason AS "disabledReason", w.last_seen_at AS "lastSeenAt",
            w.last_status AS "lastStatus", w.created_at AS "createdAt", u.callsign, COALESCE(u.callsign_verified, false) AS "ownerVerified",
            (SELECT count(*)::int FROM watch_event e WHERE e.watcher_id = w.id) AS events
       FROM watcher w LEFT JOIN account_cache u ON u.sub = w.owner_sub ORDER BY w.last_seen_at DESC NULLS LAST LIMIT 500`,
  );
  return c.json({ watchers: rows });
});

adminRoutes.post("/watchers/:id/disable", need({ watcher: ["disable"] }), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { disabled?: boolean; reason?: string };
  const disabled = body.disabled ?? true;
  const { rowCount } = await q(`UPDATE watcher SET disabled = $2, disabled_reason = $3 WHERE id = $1`, [
    c.req.param("id"), disabled, disabled ? (body.reason ?? null) : null,
  ]);
  if (rowCount) await audit(c, disabled ? "watcher.disable" : "watcher.enable", c.req.param("id"), { reason: body.reason });
  return rowCount ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

adminRoutes.post("/watchers/:id/purge", need({ watcher: ["purge"] }), async (c) => {
  const r = await q(`DELETE FROM watch_event WHERE watcher_id = $1`, [c.req.param("id")]);
  await audit(c, "watcher.purge", c.req.param("id"), { events: r.rowCount });
  return c.json({ ok: true, deleted: r.rowCount });
});

const SETTINGS: Record<string, "boolean"> = { publish_client_callsigns: "boolean" };

adminRoutes.get("/settings", need({ watcher: ["list"] }), async (c) => {
  const { rows } = await q(`SELECT key, value, updated_at AS "updatedAt" FROM site_setting ORDER BY key`);
  return c.json({ settings: rows });
});

adminRoutes.put("/settings/:key", need({ setting: ["edit"] }), async (c) => {
  const key = c.req.param("key");
  if (!SETTINGS[key]) return c.json({ error: "unknown setting" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { value?: unknown };
  if (typeof body.value !== SETTINGS[key]) return c.json({ error: `value must be a ${SETTINGS[key]}` }, 400);
  await q(
    `INSERT INTO site_setting (key, value, updated_by_sub, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_sub = EXCLUDED.updated_by_sub, updated_at = now()`,
    [key, JSON.stringify(body.value), c.get("userId")],
  );
  invalidatePolicy();
  await audit(c, "setting.set", key, { value: body.value });
  return c.json({ ok: true });
});

adminRoutes.get("/optouts", need({ optout: ["manage"] }), async (c) => {
  const { rows } = await q(`SELECT callsign, reason, created_at AS "createdAt" FROM callsign_optout ORDER BY callsign`);
  return c.json({ optouts: rows });
});

adminRoutes.post("/optouts", need({ optout: ["manage"] }), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { callsign?: string; reason?: string };
  const callsign = String(body.callsign ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9/-]{3,16}$/.test(callsign)) return c.json({ error: "callsign required" }, 400);
  await q(`INSERT INTO callsign_optout (callsign, reason, created_by_sub) VALUES ($1,$2,$3) ON CONFLICT (callsign) DO UPDATE SET reason = EXCLUDED.reason`, [
    callsign, body.reason ?? null, c.get("userId"),
  ]);
  invalidatePolicy();
  await audit(c, "optout.add", callsign, { reason: body.reason });
  return c.json({ ok: true }, 201);
});

adminRoutes.delete("/optouts/:callsign", need({ optout: ["manage"] }), async (c) => {
  await q(`DELETE FROM callsign_optout WHERE callsign = $1`, [c.req.param("callsign").toUpperCase()]);
  invalidatePolicy();
  await audit(c, "optout.remove", c.req.param("callsign").toUpperCase());
  return c.body(null, 204);
});
