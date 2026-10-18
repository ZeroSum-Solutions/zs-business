import { describe, expect, it } from "vitest";
import { assertThrowawayDatabaseEnv, childEnv, isDatabaseVariable } from "../e2e/live/child-env";

const DB = "zs_e2e_mf2abc_1a2b3c";
const local = (user: string, database = DB) => `postgres://${user}@127.0.0.1:55432/${database}`;

const developerShell = {
  PATH: "/usr/bin",
  HOME: "/Users/dev",
  LC_ALL: "en_US.UTF-8",
  DATABASE_URL: "postgres://postgres@127.0.0.1:55432/zs_dev",
  RUNTIME_DATABASE_URL: "postgres://zs_runtime@db.abcd.supabase.co:5432/postgres",
  ZS_TEST_DATABASE_URL: "postgres://postgres@127.0.0.1:55432/postgres",
  PGHOST: "db.abcd.supabase.co",
  PGPASSWORD: "hunter2",
  SUPABASE_DB_URL: "postgres://postgres@db.abcd.supabase.co:5432/postgres",
  JWT_SECRET: "a-long-local-secret-from-the-shell-000000",
  ZS_API_TOKEN: "eyJ.shell.token",
  NEXT_PUBLIC_API_TOKEN: "eyJ.old.token",
  NODE_OPTIONS: "--require ./evil.js",
};

describe("e2e:live child env", () => {
  it("passes only what node and pnpm need, plus what the harness sets", () => {
    const env = childEnv({ DATABASE_URL: local("postgres") }, developerShell);
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/dev", LC_ALL: "en_US.UTF-8", FORCE_COLOR: "0", DATABASE_URL: local("postgres") });
  });

  it("accepts every database URL that names the throwaway database on loopback", () => {
    expect(() => assertThrowawayDatabaseEnv(childEnv({ DATABASE_URL: local("postgres"), RUNTIME_DATABASE_URL: local("zs_runtime") }, developerShell), DB)).not.toThrow();
    expect(() => assertThrowawayDatabaseEnv(childEnv({}, developerShell), DB)).not.toThrow();
  });

  it("refuses the inherited database settings, had they been passed", () => {
    for (const name of ["DATABASE_URL", "RUNTIME_DATABASE_URL", "ZS_TEST_DATABASE_URL", "SUPABASE_DB_URL", "PGHOST", "PGPASSWORD"] as const) {
      expect(() => assertThrowawayDatabaseEnv({ [name]: developerShell[name] }, DB), name).toThrow();
    }
  });

  it("refuses a remote host, another database, query parameters and a non-throwaway name", () => {
    const check = (value: string, database = DB) => () => assertThrowawayDatabaseEnv({ DATABASE_URL: value }, database);
    expect(check(`postgres://postgres@10.0.0.5:55432/${DB}`)).toThrow(/loopback/);
    expect(check(local("postgres", "postgres"))).toThrow(/must name/);
    expect(check(`${local("postgres")}?host=db.example.com`)).toThrow(/query/);
    expect(check(`mysql://root@127.0.0.1/${DB}`)).toThrow(/postgres/);
    expect(check(local("postgres", "zs_dev"), "zs_dev")).toThrow(/zs_e2e_/);
  });

  it("treats database-looking names as database variables", () => {
    for (const name of ["DATABASE_URL", "RUNTIME_DATABASE_URL", "DIRECT_DB_URL", "POSTGRES_URL", "SUPABASE_URL", "PGDATABASE"]) {
      expect(isDatabaseVariable(name), name).toBe(true);
    }
    for (const name of ["PATH", "JWT_SECRET", "PORT", "DEBUG"]) expect(isDatabaseVariable(name), name).toBe(false);
  });
});
