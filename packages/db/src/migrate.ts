import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { Pool } from "pg";

export async function migrate(
  pool: Pool,
  directory = new URL("../../../supabase/migrations/", import.meta.url),
): Promise<void> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('zs-business:migrations', 0))",
    );
    await client.query("CREATE SCHEMA IF NOT EXISTS zs_internal");
    await client.query("REVOKE ALL ON SCHEMA zs_internal FROM PUBLIC");
    await client.query(
      "CREATE TABLE IF NOT EXISTS zs_internal.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL)",
    );
    for (const name of (await readdir(directory))
      .filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name))
      .sort()) {
      const source = await readFile(new URL(name, directory), "utf8");
      const checksum = createHash("sha256").update(source).digest("hex");
      const previous = (
        await client.query<{ checksum: string }>(
          "SELECT checksum FROM zs_internal.schema_migrations WHERE name=$1",
          [name],
        )
      ).rows[0];
      if (previous) {
        if (previous.checksum !== checksum)
          throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query(source);
      await client.query(
        "INSERT INTO zs_internal.schema_migrations (name,checksum) VALUES ($1,$2)",
        [name, checksum],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
