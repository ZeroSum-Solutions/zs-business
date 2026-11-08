import { execFileSync } from "node:child_process";
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
  /** The major version of the program on PATH, or null when it is missing or unreadable. */
  readonly pathMajor?: (tool: PgTool) => number | null;
}

const pathMajorOf = (tool: PgTool): number | null => {
  try {
    const text = execFileSync(tool, ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    const major = Number(/\(PostgreSQL\) (\d+)/.exec(text)?.[1] ?? NaN);
    return Number.isInteger(major) ? major : null;
  } catch {
    return null;
  }
};

const majorOf = (path: string) => Number(/(?:postgresql@|postgresql\/)(\d+)\//.exec(path)?.[1] ?? 0);

/**
 * The newest copy of a PostgreSQL client program: the highest major across the versioned
 * installs and the program on PATH (on a tie the versioned install wins), else its bare name.
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
  const candidates: { path: string; major: number }[] = [];
  for (const { root, dir } of VERSIONED_ROOTS) {
    for (const name of listDir(root)) {
      const bin = dir(name);
      if (bin === null) continue;
      const path = join(root, bin, tool);
      if (fileExists(path)) candidates.push({ path, major: majorOf(path) });
    }
  }
  const onPath = (options.pathMajor ?? pathMajorOf)(tool);
  if (onPath !== null) candidates.push({ path: tool, major: onPath });
  candidates.sort((a, b) => b.major - a.major);
  return candidates[0]?.path ?? tool;
}
