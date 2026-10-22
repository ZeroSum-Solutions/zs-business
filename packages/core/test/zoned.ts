import { createRuntimePool, createScopedDatabase, type ScopedDatabase } from "@zs/db";
import type { TestDatabase } from "@zs/db/testing";

/**
 * A runtime-role pool whose sessions use America/Los_Angeles. Postgres gives instants before
 * 1883 there a local mean time offset with seconds (-07:52:58), which exposes any write that
 * rounds the offset. Close it with `end()`.
 */
export function zonedRuntimePool(database: TestDatabase) {
  const url = new URL(database.url);
  url.username = "zs_runtime";
  url.password = "";
  url.searchParams.set("options", "-c TimeZone=America/Los_Angeles");
  return createRuntimePool({
    connectionString: url.href,
    max: 1,
    onError: (summary) => { throw new Error(`zoned test pool: ${summary.code ?? ""} ${summary.message}`); },
  });
}

/** Run `work` with Node and a runtime-role database both in America/Los_Angeles. */
export async function inLosAngeles<T>(database: TestDatabase, work: (db: ScopedDatabase) => Promise<T>): Promise<T> {
  const zone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  const zoned = zonedRuntimePool(database);
  try {
    return await work(createScopedDatabase(zoned));
  } finally {
    await zoned.end();
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
}
