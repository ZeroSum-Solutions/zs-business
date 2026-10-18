/**
 * Environments for the processes e2e:live starts. Nothing is inherited by default: a child
 * gets the few variables node and pnpm need to run, plus exactly what the harness sets. So a
 * RUNTIME_DATABASE_URL, PGHOST or token in the developer's shell can never reach the seed,
 * the API or the dashboard. Every database URL a child gets must name this run's throwaway
 * zs_e2e_* database on loopback.
 */

export type Env = Record<string, string | undefined>;

/** Variables a child may inherit: where things are, who runs them, locale and terminal. */
const INHERIT = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "TERM", "TZ", "CI"]);
const INHERIT_PREFIXES = ["LC_"];

/** Names that point a process at a database: libpq's PG*, and *DATABASE*, *_DB_*, POSTGRES*, SUPABASE*. */
export function isDatabaseVariable(name: string): boolean {
  return /^PG[A-Z]/.test(name) || /DATABASE|(^|_)DB(_|$)|POSTGRES|SUPABASE/i.test(name);
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const THROWAWAY_DATABASE = /^zs_e2e_[a-z0-9_]+$/;

export function childEnv(set: Record<string, string>, parent: Env = process.env): Env {
  const env: Env = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && (INHERIT.has(name) || INHERIT_PREFIXES.some((prefix) => name.startsWith(prefix)))) env[name] = value;
  }
  return { ...env, FORCE_COLOR: "0", ...set };
}

/**
 * Throw unless every database variable in `env` is a plain postgres URL on loopback whose
 * database is `database`, and `database` is a zs_e2e_* name. libpq PG* variables are
 * refused outright: `pg` reads them as defaults behind the URL.
 */
export function assertThrowawayDatabaseEnv(env: Env, database: string): void {
  if (!THROWAWAY_DATABASE.test(database)) throw new Error(`e2e:live database must be a zs_e2e_* name, not ${database}`);
  for (const [name, value] of Object.entries(env)) {
    if (!isDatabaseVariable(name)) continue;
    if (/^PG[A-Z]/.test(name)) throw new Error(`e2e:live children must not get ${name}`);
    let url: URL;
    try {
      url = new URL(value ?? "");
    } catch {
      throw new Error(`${name} is not a database URL`);
    }
    if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error(`${name} is not a postgres:// URL`);
    if (!LOOPBACK.has(url.hostname.toLowerCase())) throw new Error(`${name} must point at loopback, not ${url.hostname}`);
    if (url.search || url.hash) throw new Error(`${name} must not carry query parameters`);
    if (decodeURIComponent(url.pathname.slice(1)) !== database) throw new Error(`${name} must name ${database}, not ${url.pathname.slice(1) || "(none)"}`);
  }
}
