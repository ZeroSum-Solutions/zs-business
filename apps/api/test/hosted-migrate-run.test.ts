import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MigrationRecord } from "@zs/db";
import type { BackupFacts, LedgerEntry } from "../src/hosted-backup.js";
import { runHostedMigrate, type HostedMigrateDeps } from "../src/hosted-migrate-run.js";

const OLD: LedgerEntry = { name: "20261001000000_init.sql", checksum: "a".repeat(64) };
const NEW: MigrationRecord = { name: "20261015000000_next.sql", checksum: "b".repeat(64) };
const LOGIN = { session_user: "zs_migrator", rolsuper: false, rolbypassrls: false, rolcreaterole: true, member_of: ["zs_dispatcher"], server_version: "16.4" };
const FACTS: BackupFacts = { bytes: 10, sha256: "c".repeat(64), createdAt: "2026-10-18T11:00:00.000Z", tables: 1,
  manifest: { projectRef: "prodprodprodprodprod", createdAt: "2026-10-18T11:00:00.000Z", ledger: 1 } };
const LEAKY = "connect failed for postgres://zs_migrator.prodprodprodprodprod:hunter2-secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres";

interface Harness {
  ledger: LedgerEntry[];
  calls: string[];
  deps: HostedMigrateDeps;
}

function harness(overrides: {
  login?: Partial<typeof LOGIN>;
  dryRun?: () => Promise<MigrationRecord[]>;
  apply?: (h: Harness) => Promise<MigrationRecord[]>;
  backup?: () => Promise<BackupFacts>;
  ledgerFails?: (h: Harness) => boolean;
} = {}): Harness {
  const h = { ledger: [OLD], calls: [] as string[] } as Harness;
  let applyDone = false;
  h.deps = {
    pool: {
      query: (async (sql: string) => {
        h.calls.push("query");
        if (sql.includes("FROM pg_roles r WHERE r.rolname = session_user")) return { rows: [{ ...LOGIN, ...overrides.login }] };
        if (applyDone && overrides.ledgerFails?.(h)) throw new Error(LEAKY);
        if (sql.includes("to_regclass")) return { rows: [{ ok: h.ledger.length > 0 }] };
        if (sql.includes("FROM zs_internal.schema_migrations")) return { rows: h.ledger };
        if (sql.includes("pg_namespace")) return { rows: [{ table: "public tenants" }] };
        throw new Error(`unexpected query ${sql}`);
      }) as never,
    },
    target: { projectRef: "prodprodprodprodprod", role: "zs_migrator", host: "aws-0-us-east-1.pooler.supabase.com", port: "5432" },
    migrate: async (options) => {
      h.calls.push("dryRun" in options ? "migrate:dry-run" : "migrate:apply");
      if ("dryRun" in options) return (overrides.dryRun ?? (async () => [NEW]))();
      applyDone = true;
      return (overrides.apply ?? (async (state) => {
        state.ledger = [OLD, NEW];
        return [NEW];
      }))(h);
    },
    checkBackup: async () => {
      h.calls.push("checkBackup");
      return (overrides.backup ?? (async () => FACTS))();
    },
    clock: { now: () => new Date("2026-10-18T12:00:00.000Z") },
    log: () => undefined,
    logError: () => undefined,
  };
  return h;
}

let dir: string;
let counter = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "zs-receipt-test-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
const apply = () => ({ mode: "apply" as const, backupPath: "/backups/prod.dump", receiptPath: join(dir, `receipt-${(counter += 1)}.json`) });
const receiptOf = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

describe("runHostedMigrate --apply receipts", () => {
  it("records a backup-check failure, with nothing committed", async () => {
    const h = harness({ backup: async () => { throw new Error("Refusing to apply: the backup was taken from project previewpreviewprevie"); } });
    const mode = apply();
    await expect(runHostedMigrate(mode, h.deps)).rejects.toThrow(/taken from project/);
    expect(await receiptOf(mode.receiptPath)).toMatchObject({
      result: "failed", failedPhase: "backup-check", committed: false, kind: "upgrade",
      error: expect.stringContaining("taken from project"), dryRun: { result: "rolled back", migrations: [NEW.name] },
    });
    expect(h.calls).not.toContain("migrate:apply");
  });

  it("records a dry-run failure and redacts the connection string in the error", async () => {
    const h = harness({ dryRun: async () => { throw new Error(LEAKY); } });
    const mode = apply();
    await expect(runHostedMigrate(mode, h.deps)).rejects.toThrow();
    const text = await readFile(mode.receiptPath, "utf8");
    expect(text).not.toContain("hunter2");
    expect(JSON.parse(text)).toMatchObject({ result: "failed", failedPhase: "dry-run", committed: false, error: expect.stringContaining("postgres://[redacted]") });
  });

  it("records a login-check failure before any migration runs", async () => {
    const h = harness({ login: { rolbypassrls: true } });
    const mode = apply();
    await expect(runHostedMigrate(mode, h.deps)).rejects.toThrow(/BYPASSRLS/);
    expect(await receiptOf(mode.receiptPath)).toMatchObject({ result: "failed", failedPhase: "login-check", committed: false });
    expect(h.calls.filter((call) => call.startsWith("migrate"))).toEqual([]);
  });

  it("records an apply failure that rolled back as not committed", async () => {
    const h = harness({ apply: async () => { throw new Error("checksum changed since the dry run"); } });
    const mode = apply();
    await expect(runHostedMigrate(mode, h.deps)).rejects.toThrow(/checksum/);
    expect(await receiptOf(mode.receiptPath)).toMatchObject({ result: "failed", failedPhase: "apply", committed: false, after: [OLD.name] });
  });

  it("reads the ledger when the COMMIT reply was lost", async () => {
    const h = harness({ apply: async (state) => { state.ledger = [OLD, NEW]; throw new Error("Connection terminated unexpectedly"); } });
    const mode = apply();
    await expect(runHostedMigrate(mode, h.deps)).rejects.toThrow(/terminated/);
    expect(await receiptOf(mode.receiptPath)).toMatchObject({ result: "failed", failedPhase: "apply", committed: true, after: [OLD.name, NEW.name] });
  });

  it("records a ledger-check failure after a successful apply as committed", async () => {
    const h = harness({ ledgerFails: () => true });
    const mode = apply();
    await expect(runHostedMigrate(mode, h.deps)).rejects.toThrow();
    const text = await readFile(mode.receiptPath, "utf8");
    expect(text).not.toContain("hunter2");
    expect(JSON.parse(text)).toMatchObject({ result: "failed", failedPhase: "ledger-check", committed: true, applied: [NEW.name] });
  });

  it("records a successful apply", async () => {
    const h = harness();
    const mode = apply();
    await runHostedMigrate(mode, h.deps);
    const receipt = await receiptOf(mode.receiptPath);
    expect(receipt).toMatchObject({ result: "committed", committed: true, kind: "upgrade", applied: [NEW.name], after: [OLD.name, NEW.name],
      backup: { file: "/backups/prod.dump", sha256: FACTS.sha256 } });
    expect(receipt).not.toHaveProperty("failedPhase");
  });

  it("refuses an existing receipt before it touches the database", async () => {
    const h = harness();
    const mode = apply();
    await writeFile(mode.receiptPath, "earlier run\n");
    await expect(runHostedMigrate(mode, h.deps)).rejects.toThrow(/EEXIST/);
    expect(h.calls).toEqual([]);
    expect(await readFile(mode.receiptPath, "utf8")).toBe("earlier run\n");
  });
});
