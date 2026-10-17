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
  db: ScopedDatabase;
  close(): Promise<void>;
}
/** Hard boundary: this harness cannot connect outside the dedicated test cluster. */
export function testAdminUrl(
  value = process.env.ZS_TEST_DATABASE_URL ?? defaultUrl,
): URL {
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "55432" ||
    url.pathname !== "/postgres" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Tests require the dedicated 127.0.0.1:55432/postgres cluster without URL options",
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
  let created = false;
  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    try {
      await pool.end();
    } finally {
      try {
        if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(pool);
    return {
      name,
      url: databaseUrl.href,
      pool,
      db: createScopedDatabase(pool),
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
  await asService(database.pool, (tx) =>
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
    service: (work) => asService(database.pool, work),
  };
}
