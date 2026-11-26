// Database migrations, run at startup and by `pnpm migrate`: Drizzle applies the versioned SQL
// migrations in ./drizzle, then idempotent seed rows. Identity tables live in openRMS-Accounts.
// A database created before Drizzle was adopted is marked as at the baseline (0000).
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { pool } from "./db/pool.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

async function adoptBaseline() {
  const { rows } = await pool.query(
    `SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS tracked, to_regclass('public.gateway') IS NOT NULL AS existing`,
  );
  if (rows[0].tracked || !rows[0].existing) return;
  const [baseline] = readMigrationFiles({ migrationsFolder });
  if (!baseline) return;
  await pool.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await pool.query(`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
  await pool.query(`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`, [baseline.hash, baseline.folderMillis]);
  console.log("[migrate] existing database marked as at the Drizzle baseline");
}

export async function migrate() {
  await adoptBaseline();
  await drizzleMigrate(drizzle(pool), { migrationsFolder });
  await pool.query(`INSERT INTO site_setting (key, value) VALUES ('publish_client_callsigns', 'false') ON CONFLICT DO NOTHING`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => { console.log("migrations applied"); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
