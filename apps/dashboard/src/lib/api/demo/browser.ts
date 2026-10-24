/**
 * The demo adapter's website tasks (browser-tasks.md BT-3, BT-9, BT-12). It keeps the rules the
 * API enforces: owners change settings and targets, resume and request runs; anyone who drafts may
 * read and stop; a save names its revision; a run checks the switches and daily caps first. A
 * requested run finishes at once with a fixed set of steps and two invoice files. It reads nothing.
 */
import {
  killBrowserRequestSchema,
  requestBrowserRunRequestSchema,
  saveBrowserTargetRequestSchema,
  updateBrowserSettingsRequestSchema,
  uuidSchema,
  type BrowserArtifact,
  type BrowserRun,
  type BrowserRunDetail,
  type BrowserRunEvent,
  type BrowserStatus,
  type BrowserTarget,
} from "@zs/contracts";
import type { z } from "zod";
import { demoError, runNotFound } from "../errors";
import type { BrowserApi, WriteOptions } from "../types";
import type { DemoActor } from "./agents";

export interface DemoBrowserContext {
  now(): Date;
  newId(): string;
  wait(): Promise<void>;
  idempotent<T>(operation: string, payload: unknown, options: WriteOptions, run: () => T): Promise<T>;
  parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T>;
  actor(): DemoActor;
}

export interface DemoBrowserControls {
  /** The operator's switch that stops website tasks for every business. */
  setGlobalBrowserKill(killed: boolean): void;
}

const STEP_PRICE_MICROS = 10;
const DAY_MS = 86_400_000;
const clone = <T>(value: T): T => structuredClone(value);

export function createDemoBrowser(ctx: DemoBrowserContext): BrowserApi & DemoBrowserControls {
  let settings = { enabled: true, maxRunsPerDay: 5, maxCostMicrosPerDay: 5_000_000 };
  let revision = 1;
  let updatedAt: string | null = null;
  let killed: BrowserStatus["killed"] = null;
  let globalKilled = false;
  const targets = new Map<string, BrowserTarget>();
  const runs = new Map<string, BrowserRun>();
  const details = new Map<string, { events: BrowserRunEvent[]; artifacts: BrowserArtifact[] }>();

  // A supplier site the owner already set up, so the screen has something to run.
  const seededAt = ctx.now().toISOString();
  const seededId = "5b7d9f1a-2c4e-4a6b-8d0f-1a2b3c4d5e6f";
  targets.set(seededId, {
    id: seededId, name: "Cascade Dental Supply", taskKind: "supplier_invoice_download", allowedOrigins: ["https://portal.cascadesupply.example"],
    allowedPaths: ["/invoices"], assetPaths: [], signInPath: "/login", enabled: true, attestedBy: null, attestedAt: seededAt,
    revision: 1, updatedAt: seededAt, hasCredentials: true,
  });

  const requireOwner = () => {
    if (ctx.actor().role !== "owner") throw demoError("Forbidden");
  };
  const since = (now: Date) => [...runs.values()].filter((run) => Date.parse(run.requestedAt) > now.getTime() - DAY_MS);
  const costToday = (now: Date) => since(now).reduce((sum, run) => sum + run.costMicros, 0);

  function blockedBy(now: Date): BrowserStatus["blockedBy"] {
    if (globalKilled) return "global_killed";
    if (!settings.enabled) return "disabled";
    if (killed) return "tenant_killed";
    if (since(now).length >= settings.maxRunsPerDay) return "daily_cap";
    if (costToday(now) >= settings.maxCostMicrosPerDay) return "cost_cap";
    return null;
  }

  function status(): BrowserStatus {
    const now = ctx.now();
    return {
      settings: { ...settings }, revision, updatedAt, killed: killed && { ...killed }, globalKilled, blockedBy: blockedBy(now),
      runsToday: since(now).length, costTodayMicros: costToday(now), targets: clone([...targets.values()]),
    };
  }

  const byNewest = (a: BrowserRun, b: BrowserRun) => b.requestedAt.localeCompare(a.requestedAt) || b.id.localeCompare(a.id);

  return {
    async getBrowserStatus() {
      await ctx.wait();
      return status();
    },

    updateBrowserSettings(input, options) {
      return ctx.idempotent("browser.settings.update", input, options, () => {
        const request = ctx.parse(updateBrowserSettingsRequestSchema, input);
        requireOwner();
        if (request.expectedRevision !== revision) throw demoError("Conflict", { reason: "stale_revision", currentRevision: revision });
        settings = { enabled: request.enabled, maxRunsPerDay: request.maxRunsPerDay, maxCostMicrosPerDay: request.maxCostMicrosPerDay };
        revision += 1;
        updatedAt = ctx.now().toISOString();
        return status();
      });
    },

    killBrowser(input, options) {
      return ctx.idempotent("browser.kill", input, options, () => {
        const request = ctx.parse(killBrowserRequestSchema, input);
        // A switch already engaged keeps its first time and note.
        if (!killed) killed = { at: ctx.now().toISOString(), by: ctx.actor().userId, note: request.note ?? null };
        return status();
      });
    },

    resumeBrowser(options) {
      return ctx.idempotent("browser.resume", {}, options, () => {
        requireOwner();
        killed = null;
        return status();
      });
    },

    saveBrowserTarget(input, options) {
      return ctx.idempotent("browser.target.save", input, options, () => {
        const request = ctx.parse(saveBrowserTargetRequestSchema, input);
        requireOwner();
        const now = ctx.now().toISOString();
        const existing = request.targetId ? targets.get(request.targetId) : undefined;
        if (request.targetId && !existing) throw demoError("Conflict", { reason: "stale_revision", currentRevision: 0 });
        if (existing && existing.revision !== request.expectedRevision) {
          throw demoError("Conflict", { reason: "stale_revision", currentRevision: existing.revision });
        }
        const target: BrowserTarget = {
          id: existing?.id ?? ctx.newId(), name: request.name, taskKind: request.taskKind, allowedOrigins: request.allowedOrigins,
          allowedPaths: request.allowedPaths, assetPaths: request.assetPaths, signInPath: request.signInPath,
          enabled: request.enabled, attestedBy: request.attestation ? ctx.actor().userId : existing?.attestedBy ?? null,
          attestedAt: request.attestation ? now : existing?.attestedAt ?? null, revision: (existing?.revision ?? 0) + 1,
          updatedAt: now, hasCredentials: Boolean(request.secretRef) || (existing?.hasCredentials ?? false),
        };
        targets.set(target.id, target);
        return clone(target);
      });
    },

    requestBrowserRun(input, options) {
      return ctx.idempotent("browser.run.request", input, options, () => {
        const request = ctx.parse(requestBrowserRunRequestSchema, input);
        requireOwner();
        const now = ctx.now();
        const target = targets.get(request.targetId);
        const reason = blockedBy(now) ?? (!target || !target.enabled ? "target_disabled" : null);
        if (reason || !target) throw demoError("Conflict", { reason: reason ?? "target_disabled" });
        const at = now.toISOString();
        const id = ctx.newId();
        const artifacts: BrowserArtifact[] = [`${request.month}-001.pdf`, `${request.month}-002.pdf`].map((name) => ({
          id: ctx.newId(), kind: "invoice_pdf", name, bytes: 48_000, sha256: "0".repeat(64), createdAt: at,
        }));
        const origin = target.allowedOrigins[0] ?? null;
        const path = target.allowedPaths[0] ?? "/";
        const step = (seq: number, action: BrowserRunEvent["action"], pathOf: string | null): BrowserRunEvent => ({
          seq, origin, path: pathOf, action, screenshotRef: null, model: null, inputTokens: 0, outputTokens: 0, costMicros: 0, createdAt: at,
        });
        const events = [
          step(1, "sign_in", target.signInPath), step(2, "open", path), step(3, "set_date_filter", path),
          step(4, "download", path), step(5, "stop", null),
        ];
        const run: BrowserRun = {
          id, targetId: request.targetId, taskKind: target.taskKind, status: "completed", stopReason: null,
          requestedBy: ctx.actor().userId, requestedAt: at, startedAt: at, finishedAt: at, month: request.month,
          maxSteps: request.maxSteps, deadlineMs: request.deadlineMs, maxCostMicros: request.maxCostMicros,
          steps: events.length, costMicros: events.length * STEP_PRICE_MICROS, attempt: 1, artifactCount: artifacts.length,
        };
        runs.set(id, run);
        details.set(id, { events, artifacts });
        return clone(run);
      });
    },

    async listBrowserRuns() {
      await ctx.wait();
      return clone([...runs.values()].sort(byNewest));
    },

    async getBrowserRun(id): Promise<BrowserRunDetail> {
      await ctx.wait();
      const run = uuidSchema.safeParse(id).success ? runs.get(id) : undefined;
      if (!run) throw runNotFound();
      const found = details.get(id)!;
      return clone({ run, events: found.events, artifacts: found.artifacts });
    },

    setGlobalBrowserKill(value) {
      globalKilled = value;
    },
  };
}
