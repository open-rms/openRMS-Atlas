// Operator commands for the Directory. Account administration (roles, callsigns, clubs)
// lives in openRMS-Accounts.
import { pool } from "./db/pool.js";
import { migrate } from "./migrate.js";
import { importWinlink } from "./winlink/import.js";

const [cmd, ...args] = process.argv.slice(2);
await migrate();
switch (cmd) {
  case "import-winlink":
    console.log(await importWinlink({ force: args.includes("--force") }));
    break;
  default:
    console.log("usage: pnpm cli import-winlink [--force]   (roles and callsigns: openRMS-Accounts)");
}
await pool.end();
