import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import { checkBackup, manifestPathFor, readLedger, takeBackup, verifyBackupManifest, type LedgerEntry } from "../src/hosted-backup.js";

const PRODUCTION = "prodprodprodprodprod";
const PREVIEW = "previewpreviewprevie";
const NOW = new Date("2026-10-18T12:00:00.000Z");
const hasPgDump = (() => {
  try {
    execFileSync("pg_dump", ["--version"]);
    execFileSync("pg_restore", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "zs-backup-test-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("verifyBackupManifest", () => {
  const ledger: LedgerEntry[] = [{ name: "20261001000000_init.sql", checksum: "a".repeat(64) }];
  const archive = Buffer.from("PGDMP fake archive bytes");
  const sha256 = "4b0d6e6e3c0c1ba2bd0b7a0e1d1b6cc6d0d5d3a8f1a4d0c6a52d3d4b6c1f7f6d";
  async function write(name: string, manifest: Record<string, unknown>) {
    const path = join(dir, name);
    await writeFile(path, archive);
    const { createHash } = await import("node:crypto");
    await writeFile(manifestPathFor(path), JSON.stringify({
      format: "zs-backup-manifest/1", projectRef: PRODUCTION, archive: name, bytes: archive.length,
      sha256: createHash("sha256").update(archive).digest("hex"), createdAt: NOW.toISOString(), ledger, ...manifest,
    }));
    return path;
  }
  const expected = { projectRef: PRODUCTION, ledger, now: NOW };

  it("accepts the manifest of this project, file and ledger", async () => {
    const path = await write("ok.dump", {});
    await expect(verifyBackupManifest(path, archive, expected)).resolves.toMatchObject({ projectRef: PRODUCTION });
  });

  it("refuses an archive without a manifest", async () => {
    const path = join(dir, "bare.dump");
    await writeFile(path, archive);
    await expect(verifyBackupManifest(path, archive, expected)).rejects.toThrow(/no manifest/);
  });

  it("refuses a preview project's backup with the same tables and ledger", async () => {
    const path = await write("preview.dump", { projectRef: PREVIEW });
    await expect(verifyBackupManifest(path, archive, expected)).rejects.toThrow(`taken from project ${PREVIEW}, not ZS_TARGET_REF ${PRODUCTION}`);
  });

  it("refuses an archive whose bytes differ from the manifest", async () => {
    const path = await write("swapped.dump", { sha256: sha256 });
    await expect(verifyBackupManifest(path, archive, expected)).rejects.toThrow(/sha256/);
  });

  it("refuses a manifest written for another file name", async () => {
    const path = await write("renamed.dump", { archive: "other.dump" });
    await expect(verifyBackupManifest(path, archive, expected)).rejects.toThrow(/another archive/);
  });

  it("refuses a ledger that differs by name or checksum", async () => {
    const path = await write("ledger.dump", {});
    await expect(verifyBackupManifest(path, archive, { ...expected, ledger: [{ ...ledger[0]!, checksum: "b".repeat(64) }] }))
      .rejects.toThrow(/ledger does not match/);
    await expect(verifyBackupManifest(path, archive, { ...expected, ledger: [] })).rejects.toThrow(/ledger does not match/);
  });

  it("refuses a manifest older than two hours or from the future", async () => {
    const path = await write("old.dump", {});
    await expect(verifyBackupManifest(path, archive, { ...expected, now: new Date(NOW.getTime() + 2 * 3600_000 + 1) }))
      .rejects.toThrow(/last two hours/);
    await expect(verifyBackupManifest(path, archive, { ...expected, now: new Date(NOW.getTime() - 120_000) }))
      .rejects.toThrow(/last two hours/);
  });

  it("refuses a malformed manifest", async () => {
    const path = await write("bad.dump", { extra: true });
    await expect(verifyBackupManifest(path, archive, expected)).rejects.toThrow(/malformed/);
  });
});

describe.skipIf(!hasPgDump)("takeBackup with pg_dump on the local cluster", () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    await database?.close();
  });

  it("writes a manifest that binds the archive to its project and passes checkBackup only there", async () => {
    const url = new URL(database.url);
    const out = join(dir, "local.dump");
    const clock = { now: () => new Date() };
    const manifest = await takeBackup({
      pool: database.pool,
      connection: { host: url.hostname, port: url.port, user: decodeURIComponent(url.username), password: "", database: url.pathname.slice(1) },
      rootCertFile: null, projectRef: PRODUCTION, out, clock, searchPath: process.env.PATH,
    });
    const ledger = await readLedger(database.pool);
    expect(ledger.length).toBeGreaterThan(0);
    expect(manifest).toMatchObject({ projectRef: PRODUCTION, archive: "local.dump", ledger });
    expect(JSON.parse(await readFile(manifestPathFor(out), "utf8"))).toEqual(manifest);

    const tables = (await database.pool.query<{ table: string }>(
      `SELECT n.nspname || ' ' || c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('public', 'zs_internal') AND c.relkind = 'r' ORDER BY 1`)).rows.map((row) => row.table);
    const facts = await checkBackup(out, { projectRef: PRODUCTION, ledger, tables, now: clock.now() });
    expect(facts).toMatchObject({ sha256: manifest.sha256, manifest: { projectRef: PRODUCTION, ledger: ledger.length } });
    // The same dump presented for another project fails, though its tables and ledger match.
    await expect(checkBackup(out, { projectRef: PREVIEW, ledger, tables, now: clock.now() })).rejects.toThrow(/taken from project/);
    // A copy without its manifest fails too.
    const copy = join(dir, "copy.dump");
    await copyFile(out, copy);
    await expect(checkBackup(copy, { projectRef: PRODUCTION, ledger, tables, now: clock.now() })).rejects.toThrow(/no manifest/);
    // Neither file is ever overwritten.
    await expect(takeBackup({
      pool: database.pool, connection: { host: url.hostname, port: url.port, user: "postgres", password: "", database: url.pathname.slice(1) },
      rootCertFile: null, projectRef: PRODUCTION, out, clock,
    })).rejects.toThrow(/already exists/);
  });

  it("passes the password only through pg_dump's environment", async () => {
    const calls: { args: string[]; env?: Record<string, string> }[] = [];
    const out = join(dir, "env.dump");
    await takeBackup({
      pool: database.pool,
      connection: { host: "127.0.0.1", port: "55432", user: "postgres", password: "s3cret-value", database: "x" },
      rootCertFile: "/ca.crt", projectRef: PRODUCTION, out, clock: { now: () => NOW },
      run: async (_file, args, options) => {
        calls.push({ args, ...(options.env ? { env: options.env } : {}) });
        await writeFile(out, "PGDMP");
        return { stdout: "" };
      },
    });
    expect(calls[0]!.args.join(" ")).not.toContain("s3cret-value");
    expect(calls[0]!.env).toEqual({
      PGHOST: "127.0.0.1", PGPORT: "55432", PGUSER: "postgres", PGPASSWORD: "s3cret-value", PGDATABASE: "x",
      PGSSLMODE: "verify-full", PGSSLROOTCERT: "/ca.crt",
    });
  });
});
