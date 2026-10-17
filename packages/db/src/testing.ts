import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { migrate } from "./migrate.js";
import {
  asService,
  createScopedDatabase,
  type ScopedDatabase,
  type Transaction,
} from "./scoped.js";

const defaultUrl = "postgres://postgres@127.0.0.1:55432/postgres";
export interface TestDatabase {
  name: string;
  url: string;
  pool: Pool;
  runtimePool: Pool;
  servicePool: Pool;
  db: ScopedDatabase;
  close(): Promise<void>;
}
/** Hard boundary: this harness cannot connect outside the dedicated test cluster. */
export function testAdminUrl(
  value = process.env.ZS_TEST_DATABASE_URL ?? defaultUrl,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid test database URL");
  }
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === "localhost" || hostname === "[::1]" || (
    /^127(?:\.(?:\d{1,3})){3}$/.test(hostname) &&
    hostname.split(".").every((part) => Number(part) <= 255)
  );
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !loopback ||
    !url.port ||
    ["5432", "54322"].includes(url.port) ||
    Number(url.port) < 1 || Number(url.port) > 65535 ||
    url.pathname !== "/postgres" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Tests require a dedicated loopback /postgres cluster on a non-production port without URL options",
    );
  }
  return url;
}

export async function createTestDatabase(
  adminUrl?: string,
): Promise<TestDatabase> {
  const base = testAdminUrl(adminUrl);
  const admin = new Pool({ connectionString: base.href, max: 1 });
  const name = `zs_test_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(base);
  databaseUrl.pathname = `/${name}`;
  const pool = new Pool({ connectionString: databaseUrl.href, max: 5 });
  const loginUrl = (username: string) => {
    const url = new URL(databaseUrl);
    url.username = username;
    // Test LOGIN roles use the dedicated cluster's trust authentication.
    url.password = "";
    return url.href;
  };
  const runtimePool = new Pool({ connectionString: loginUrl("zs_runtime"), max: 5 });
  const servicePool = new Pool({ connectionString: loginUrl("zs_service"), max: 5 });
  let created = false;
  let closed = false;
  // DROP DATABASE ... WITH (FORCE) can reach a backend whose idle client is still
  // shutting down; pg-pool re-emits that 57P01 and an unhandled pool error crashes the run.
  const onIdleError = (error: Error & { code?: string }) => {
    if (closed && error.code === "57P01") return;
    throw error;
  };
  for (const p of [pool, runtimePool, servicePool]) p.on("error", onIdleError);
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    try {
      await Promise.all([pool.end(), runtimePool.end(), servicePool.end()]);
    } finally {
      try {
        if (created) {
          // Let ended clients' backends exit before forcing the drop.
          for (let i = 0; i < 50; i += 1) {
            const { rows } = await admin.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
              [name],
            );
            if (rows[0]?.n === 0) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        }
      } finally {
        await admin.end();
      }
    }
  }
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(pool);
    // Serialize cluster-wide login setup in the shared admin database, across runs.
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('zs-business:test-logins',0))");
      for (const [login, membership] of [["zs_runtime", "authenticated"], ["zs_service", "service_role"]] as const) {
        await client.query(`DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${login}') THEN
            CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
          END IF;
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${login}' AND
            (NOT rolcanlogin OR NOT rolinherit OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication))
            OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member='${login}'::regrole AND roleid <> '${membership}'::regrole) THEN
            RAISE EXCEPTION 'Unsafe test login role ${login}';
          END IF;
        END $$; GRANT ${membership} TO ${login};`);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
    return {
      name,
      url: databaseUrl.href,
      pool,
      runtimePool,
      servicePool,
      db: createScopedDatabase(runtimePool),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The finally block also handles rejected test callbacks. Test suites may use afterAll(close). */
export async function withTestDatabase<T>(
  work: (database: TestDatabase) => Promise<T>,
  adminUrl?: string,
): Promise<T> {
  const database = await createTestDatabase(adminUrl);
  try {
    return await work(database);
  } finally {
    await database.close();
  }
}
export interface TenantFixture {
  tenantId: string;
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}
export interface TwoTenantFixture {
  a: TenantFixture;
  b: TenantFixture;
  service<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}
export async function createTwoTenantFixture(
  database: TestDatabase,
): Promise<TwoTenantFixture> {
  const a = randomUUID();
  const b = randomUUID();
  await asService(database.servicePool, (tx) =>
    tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,$2),($3,$4)", [
      a,
      "Tenant A",
      b,
      "Tenant B",
    ]),
  );
  const tenant = (tenantId: string): TenantFixture => ({
    tenantId,
    run: (work) => database.db.tenant(tenantId, work),
  });
  return {
    a: tenant(a),
    b: tenant(b),
    service: (work) => asService(database.servicePool, work),
  };
}
