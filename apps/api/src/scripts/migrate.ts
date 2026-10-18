// Entry point: apply supabase/migrations to a local database. Refuses non-loopback hosts.
import process from "node:process";
import { Pool } from "pg";
import { migrate } from "@zs/db";
import { assertLocalDatabaseUrl } from "../config.js";

const url = assertLocalDatabaseUrl(process.env.DATABASE_URL ?? "");
const pool = new Pool({ connectionString: url.href, max: 1 });
try {
  await migrate(pool);
  console.log(`Migrations applied to ${url.pathname.slice(1)}`);
} finally {
  await pool.end();
}
