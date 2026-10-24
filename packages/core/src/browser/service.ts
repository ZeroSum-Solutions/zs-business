// The runner's side of browser tasks (BT-7, BT-9, BT-12). The runner principal can do exactly five
// things: claim a queued job, ask whether to stop, append events, upload artifacts and report the
// result. Anything else is TenantDenied: a lease names one run, and the tenant, target and profile
// come from that row, never from a payload. Claim and finish run in service-role transactions like
// the delivery worker's (delivery.md D-10), because wallet writes need the service role (D-4).
import { createHash, timingSafeEqual } from "node:crypto";
import {
  BROWSER_LIMITS, Conflict, TenantDenied, ValidationFailed,
  type BrowserClaim, type BrowserEventInput, type BrowserFinishInput, type BrowserRun, type BrowserStopReason,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { readGlobalKilled } from "../agents/controls.js";
import { priceUsage } from "../agents/cost.js";
import { derivedId } from "../edge/ids.js";
import { captureReservation, heldReservationForJob, releaseReservation, reserveForJob, DEFAULT_JOB_REGISTRY } from "../wallet/index.js";
import type { BrowserConfig, BrowserCredentialResolver } from "./config.js";
import { eventLocation } from "./policy.js";
import { artifactKey } from "./profile.js";
import { getBrowserRun, loadSettings, mapRun, RUN_COLUMNS, type RunRow } from "./rows.js";
import type { BrowserArtifactStore } from "./store.js";

export interface BrowserRunnerServiceDeps {
  /** Runs `work` in a service-role transaction. The API process has no such pool; the runner's entry script does. */
  readonly service: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  /** A fresh secret for each lease. Injected; core has no ambient randomness. */
  readonly newToken: () => string;
  readonly config: BrowserConfig;
  readonly credentials: BrowserCredentialResolver;
  readonly artifacts: BrowserArtifactStore;
}

export interface Lease {
  readonly runId: string;
  readonly token: string;
}

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** A file name that cannot carry a path, markup or a secret-looking run of text. */
export function safeArtifactName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^\.+/, "").slice(0, 100).trim();
  return cleaned.length > 0 ? cleaned : "download.pdf";
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const startsWith = (bytes: Uint8Array, magic: readonly number[]) => magic.every((byte, index) => bytes[index] === byte);

export function createBrowserRunnerService(deps: BrowserRunnerServiceDeps) {
  const { config } = deps;
  const now = () => deps.clock.now();

  /** BT-9: close a run once. Captures what the steps cost and releases the rest of the hold (D-11). */
  async function closeRun(
    tx: Transaction, row: RunRow, outcome: { status: "completed" } | { status: "stopped"; reason: BrowserStopReason }, at: Date,
  ): Promise<RunRow> {
    const closed = (await tx.query<RunRow>(
      `UPDATE browser_runs SET status=$3, stop_reason=$4, finished_at=$5 WHERE tenant_id=$1 AND id=$2 AND status IN ('queued','running')
        RETURNING ${RUN_COLUMNS}`,
      [row.tenant_id, row.id, outcome.status, outcome.status === "stopped" ? outcome.reason : null, at])).rows[0];
    if (!closed) return row;
    const held = await heldReservationForJob(tx, row.tenant_id, "browser_run", row.id);
    if (held) {
      const cost = Math.min(held.amount, closed.steps * config.stepPrice);
      if (cost > 0)
        await captureReservation(tx, {
          tenantId: row.tenant_id, reservationId: held.id, ledgerId: derivedId(row.tenant_id, row.id, "browser-capture"), amount: cost, now: at,
        });
      else await releaseReservation(tx, { tenantId: row.tenant_id, reservationId: held.id, now: at });
    }
    return closed;
  }

  /** BT-12: the first reason this run must stop now, from the switches and caps. */
  async function stopReason(tx: Transaction, row: RunRow, at: Date): Promise<BrowserStopReason | null> {
    if (await readGlobalKilled(tx, false)) return "killed";
    const settings = await loadSettings(tx, row.tenant_id, false);
    if (!settings?.enabled) return "disabled";
    if (settings.killed_at) return "killed";
    const target = (await tx.query<{ enabled: boolean; attested_by: string | null }>(
      "SELECT enabled, attested_by FROM browser_targets WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.target_id])).rows[0];
    if (!target?.enabled || !target.attested_by) return "disabled";
    if (row.steps >= row.max_steps) return "step_cap";
    if (row.started_at && at.getTime() > row.started_at.getTime() + row.deadline_ms) return "deadline";
    if (Number(row.cost_micros) >= Number(row.max_cost_micros)) return "cost_cap";
    const day = Number((await tx.query<{ cost: string }>(
      "SELECT coalesce(sum(cost_micros),0)::text AS cost FROM browser_runs WHERE tenant_id=$1 AND requested_at > $2",
      [row.tenant_id, new Date(at.getTime() - 24 * 3_600_000)])).rows[0]!.cost);
    if (day >= Number(settings.max_cost_micros_per_day)) return "cost_cap";
    return null;
  }

  /** The run a lease holds, locked. A wrong token, another run or an expired lease is TenantDenied. */
  async function leasedRun(tx: Transaction, lease: Lease, at: Date, requireOpen: boolean): Promise<RunRow> {
    const row = (await tx.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM browser_runs WHERE id=$1 FOR UPDATE`, [lease.runId])).rows[0];
    if (!row?.lease_hash || !row.lease_until || !sameHash(sha256(lease.token), row.lease_hash)) throw new TenantDenied();
    if (requireOpen && (row.status !== "running" || row.lease_until.getTime() <= at.getTime())) throw new TenantDenied();
    return row;
  }

  async function claimOne(): Promise<BrowserClaim | "closed" | null> {
    return deps.service(async (tx) => {
      const at = now();
      const row = (await tx.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM browser_runs WHERE status='queued' OR (status='running' AND lease_until < $1)
          ORDER BY requested_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`, [at])).rows[0];
      if (!row) return null;
      // A re-claim after an expired lease starts a new attempt; the same gates apply as to a first claim.
      const reason = await stopReason(tx, row, at);
      if (reason) { await closeRun(tx, row, { status: "stopped", reason }, at); return "closed"; }
      let held = await heldReservationForJob(tx, row.tenant_id, "browser_run", row.id);
      if (!held) {
        held = await reserveForJob(tx, {
          tenantId: row.tenant_id, jobKind: "browser_run", jobId: row.id, reservationId: derivedId(row.tenant_id, row.id, "browser-hold"),
          amount: row.max_steps * config.stepPrice, currency: config.currency, now: at,
        }, DEFAULT_JOB_REGISTRY);
        if (!held) { await closeRun(tx, row, { status: "stopped", reason: "insufficient_funds" }, at); return "closed"; }
      }
      const target = (await tx.query<{
        allowed_origins: string[]; allowed_paths: string[]; asset_paths: string[]; sign_in_path: string | null; secret_ref: string | null;
      }>(`SELECT t.allowed_origins, t.allowed_paths, t.asset_paths, t.sign_in_path, c.secret_ref FROM browser_targets t
            LEFT JOIN browser_credentials c ON c.tenant_id = t.tenant_id AND c.target_id = t.id
           WHERE t.tenant_id=$1 AND t.id=$2`, [row.tenant_id, row.target_id])).rows[0];
      if (!target?.sign_in_path) { await closeRun(tx, row, { status: "stopped", reason: "disabled" }, at); return "closed"; }
      const credentials = target.secret_ref
        ? await deps.credentials.resolve(tx, { tenantId: row.tenant_id, targetId: row.target_id, secretRef: target.secret_ref }).catch(() => null)
        : null;
      // BT-12: the owner must supply the sign-in; without it the run is handed back.
      if (!credentials) { await closeRun(tx, row, { status: "stopped", reason: "needs_owner" }, at); return "closed"; }
      const token = deps.newToken();
      const leaseUntil = new Date(at.getTime() + config.leaseMs);
      const started = row.started_at ?? at;
      const updated = (await tx.query<RunRow>(
        `UPDATE browser_runs SET status='running', started_at=$3, attempt=attempt+1, lease_hash=$4, lease_until=$5
          WHERE tenant_id=$1 AND id=$2 RETURNING ${RUN_COLUMNS}`,
        [row.tenant_id, row.id, started, sha256(token), leaseUntil])).rows[0]!;
      return {
        runId: updated.id, tenantId: updated.tenant_id, targetId: updated.target_id, taskKind: updated.task_kind,
        month: updated.params.month ?? "", attempt: updated.attempt, leaseToken: token, leaseUntil: leaseUntil.toISOString(),
        maxSteps: updated.max_steps, stepsDone: updated.steps, deadlineAt: new Date(started.getTime() + updated.deadline_ms).toISOString(),
        target: { allowedOrigins: target.allowed_origins, allowedPaths: target.allowed_paths, assetPaths: target.asset_paths, signInPath: target.sign_in_path },
        credentials: { username: credentials.username, password: credentials.password },
      };
    });
  }

  return {
    /** BT-7, BT-9: claim the next queued job (or one whose lease ran out) as a lease, or null. */
    async claim(): Promise<BrowserClaim | null> {
      // A run closed at the gate (disabled, killed, no funds) is not a claim: look at the next one.
      for (let tries = 0; tries < 25; tries += 1) {
        const claimed = await claimOne();
        if (claimed === null) return null;
        if (claimed !== "closed") return claimed;
      }
      return null;
    },

    /** BT-12: the stop callback. A reason closes the run on the server before the runner reports it. */
    async control(lease: Lease): Promise<{ readonly stop: BrowserStopReason | null }> {
      return deps.service(async (tx) => {
        const at = now();
        const row = await leasedRun(tx, lease, at, false);
        if (row.status === "stopped") return { stop: row.stop_reason };
        if (row.status === "completed") return { stop: null };
        if (row.lease_until!.getTime() <= at.getTime()) throw new TenantDenied();
        const reason = await stopReason(tx, row, at);
        if (reason) { await closeRun(tx, row, { status: "stopped", reason }, at); return { stop: reason }; }
        await tx.query("UPDATE browser_runs SET lease_until=$3 WHERE tenant_id=$1 AND id=$2",
          [row.tenant_id, row.id, new Date(at.getTime() + config.leaseMs)]);
        return { stop: null };
      });
    },

    /** BT-9: append one numbered event. Origin and path are kept; the query string and fragment never are. */
    async appendEvent(lease: Lease, input: BrowserEventInput): Promise<{ readonly seq: number; readonly stop: BrowserStopReason | null }> {
      return deps.service(async (tx) => {
        const at = now();
        const row = await leasedRun(tx, lease, at, true);
        const location = input.url === undefined ? null : eventLocation(input.url);
        if (input.url !== undefined && !location) throw new ValidationFailed("The event URL is not an http(s) URL");
        let cost = 0;
        if (input.usage) {
          // BT-10: the planner reads page text that may hold personal data, so only the personal-data lane may serve it.
          if (input.usage.lane !== "personal_data") throw new ValidationFailed("Browser tasks use the personal-data lane");
          cost = priceUsage(config.modelPrices, input.usage.model, input.usage);
        }
        if (input.screenshotRef) {
          const found = await tx.query("SELECT 1 FROM browser_run_artifacts WHERE tenant_id=$1 AND run_id=$2 AND id=$3",
            [row.tenant_id, row.id, input.screenshotRef]);
          if (found.rowCount !== 1) throw new ValidationFailed("The screenshot is not a file of this run");
        }
        const seq = Number((await tx.query<{ next: number }>(
          "SELECT coalesce(max(seq), 0) + 1 AS next FROM browser_run_events WHERE tenant_id=$1 AND run_id=$2", [row.tenant_id, row.id])).rows[0]!.next);
        await tx.query(
          `INSERT INTO browser_run_events (tenant_id, run_id, seq, origin, path, action, screenshot_ref, lane, model, input_tokens, output_tokens, cost_micros, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [row.tenant_id, row.id, seq, location?.origin ?? null, location?.path ?? null, input.action, input.screenshotRef ?? null,
            input.usage?.lane ?? null, input.usage?.model ?? null, input.usage?.inputTokens ?? 0, input.usage?.outputTokens ?? 0, cost, at]);
        const updated = (await tx.query<RunRow>(
          `UPDATE browser_runs SET steps = steps + $3, cost_micros = cost_micros + $4, lease_until = $5
            WHERE tenant_id=$1 AND id=$2 RETURNING ${RUN_COLUMNS}`,
          [row.tenant_id, row.id, input.action === "stop" ? 0 : 1, cost, new Date(at.getTime() + config.leaseMs)])).rows[0]!;
        // A call that took the run past its cost cap closes it now, so the next step never starts.
        if (Number(updated.cost_micros) > Number(updated.max_cost_micros)) {
          await closeRun(tx, updated, { status: "stopped", reason: "cost_cap" }, at);
          return { seq, stop: "cost_cap" as const };
        }
        return { seq, stop: null };
      });
    },

    /** BT-13, BT-6: store a PDF (or an audit screenshot) under the run's own prefix. */
    async putArtifact(lease: Lease, input: { kind: "invoice_pdf" | "screenshot"; name: string; bytes: Uint8Array }):
      Promise<{ readonly id: string; readonly duplicate: boolean }> {
      const pdf = input.kind === "invoice_pdf";
      const limit = pdf ? BROWSER_LIMITS.maxPdfBytes : BROWSER_LIMITS.maxScreenshotBytes;
      if (input.bytes.byteLength < 1 || input.bytes.byteLength > limit) throw new ValidationFailed("The file is empty or too large");
      if (!startsWith(input.bytes, pdf ? PDF_MAGIC : PNG_MAGIC)) throw new ValidationFailed(pdf ? "Only PDF files are kept" : "Only PNG screenshots are kept");
      const digest = sha256(input.bytes);
      return deps.service(async (tx) => {
        const at = now();
        const row = await leasedRun(tx, lease, at, true);
        const existing = (await tx.query<{ id: string }>(
          "SELECT id FROM browser_run_artifacts WHERE tenant_id=$1 AND run_id=$2 AND sha256=$3", [row.tenant_id, row.id, digest])).rows[0];
        if (existing) return { id: existing.id, duplicate: true };
        if (pdf) {
          const count = Number((await tx.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM browser_run_artifacts WHERE tenant_id=$1 AND run_id=$2 AND kind='invoice_pdf'", [row.tenant_id, row.id])).rows[0]!.n);
          if (count >= BROWSER_LIMITS.maxPdfsPerRun) throw new Conflict("A run keeps at most 50 PDFs", { reason: "artifact_cap" });
        }
        const id = derivedId(row.tenant_id, row.id, digest, "browser-artifact");
        const key = artifactKey(row.tenant_id, row.id, id, pdf ? "pdf" : "png");
        await tx.query(
          `INSERT INTO browser_run_artifacts (tenant_id, id, run_id, kind, name, storage_key, bytes, sha256, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [row.tenant_id, id, row.id, input.kind, safeArtifactName(input.name), key, input.bytes.byteLength, digest, at]);
        await deps.artifacts.put(key, input.bytes, pdf ? "application/pdf" : "image/png");
        return { id, duplicate: false };
      });
    },

    /** BT-9: report the result. A run the server already closed answers with that close. */
    async finish(lease: Lease, input: BrowserFinishInput): Promise<BrowserRun> {
      return deps.service(async (tx) => {
        const at = now();
        const row = await leasedRun(tx, lease, at, false);
        if (row.status === "running" && row.lease_until!.getTime() <= at.getTime()) throw new TenantDenied();
        const closed = row.status === "queued" || row.status === "running"
          ? await closeRun(tx, row, input.outcome === "read_done" ? { status: "completed" } : { status: "stopped", reason: input.reason }, at)
          : row;
        // Reread with the file count: the closing UPDATE does not return it.
        return (await getBrowserRun(tx, closed.tenant_id, closed.id)) ?? mapRun(closed);
      });
    },

    /** BT-12: close every run still `running` past its deadline plus the grace, as `stalled`. */
    async closeStalledRuns(limit = 100): Promise<number> {
      return deps.service(async (tx) => {
        const at = now();
        const rows = (await tx.query<RunRow>(
          `SELECT ${RUN_COLUMNS} FROM browser_runs
            WHERE status='running' AND started_at + make_interval(secs => (deadline_ms + $2) / 1000.0) < $1
            ORDER BY started_at, id LIMIT $3 FOR UPDATE SKIP LOCKED`, [at, config.stallGraceMs, limit])).rows;
        for (const row of rows) await closeRun(tx, row, { status: "stopped", reason: "stalled" }, at);
        return rows.length;
      });
    },

    /** The run as the runner's tests and the owner's screen read it (service role, no RLS). */
    async getRun(tenantId: string, runId: string): Promise<BrowserRun | null> {
      return deps.service((tx) => getBrowserRun(tx, tenantId, runId));
    },
  };
}
export type BrowserRunnerService = ReturnType<typeof createBrowserRunnerService>;
