import { createRuntimePool } from "@zs/db";
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
