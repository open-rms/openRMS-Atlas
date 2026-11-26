// Typed Drizzle client over the shared pg pool. New code uses this; older routes still use
// raw SQL through db/pool.ts and move over gradually.
import { drizzle } from "drizzle-orm/node-postgres";
import { pool } from "./pool.js";
import * as schema from "./schema.js";

export const db = drizzle(pool, { schema });
export { schema };
