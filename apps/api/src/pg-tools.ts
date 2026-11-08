import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The PostgreSQL client programs the owner scripts run. */
export type PgTool = "pg_dump" | "pg_restore" | "psql";

/** Where Homebrew (Apple silicon and Intel) and Debian/Ubuntu install versioned PostgreSQL binaries. */
const VERSIONED_ROOTS: readonly { root: string; dir: (name: string) => string | null }[] = [
  { root: "/opt/homebrew/opt", dir: (name) => (/^postgresql@\d+$/.test(name) ? join(name, "bin") : null) },
  { root: "/usr/local/opt", dir: (name) => (/^postgresql@\d+$/.test(name) ? join(name, "bin") : null) },
  { root: "/usr/lib/postgresql", dir: (name) => (/^\d+$/.test(name) ? join(name, "bin") : null) },
];

export interface ResolvePgToolOptions {
  /** An explicit path (PG_DUMP, PG_RESTORE, PSQL); always wins. */
  readonly explicit?: string | undefined;
  /** Test seams. */
  readonly listDir?: (path: string) => readonly string[];
  readonly fileExists?: (path: string) => boolean;
}

const majorOf = (path: string) => Number(/(?:postgresql@|postgresql\/)(\d+)\//.exec(path)?.[1] ?? 0);

/**
 * The newest installed versioned copy of a PostgreSQL client program, else its bare name (PATH).
 * pg_dump refuses a server newer than itself, and pg_restore refuses an archive written by a
 * newer pg_dump (hosted Supabase is PostgreSQL 17; Homebrew's default PATH may hold 16), while a
 * newer client reads older servers and archives. So the newest copy is always the safe pick.
 */
export function resolvePgTool(tool: PgTool, options: ResolvePgToolOptions = {}): string {
  if (options.explicit) return options.explicit;
  const listDir = options.listDir ?? ((path: string) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  });
  const fileExists = options.fileExists ?? existsSync;
  const candidates: string[] = [];
  for (const { root, dir } of VERSIONED_ROOTS) {
    for (const name of listDir(root)) {
      const bin = dir(name);
      if (bin === null) continue;
      const path = join(root, bin, tool);
      if (fileExists(path)) candidates.push(path);
    }
  }
  candidates.sort((a, b) => majorOf(b) - majorOf(a));
  return candidates[0] ?? tool;
}
