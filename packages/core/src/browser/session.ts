// The owner's browser task API (BT-3, BT-9, BT-12): writes go through the dispatcher as the member,
// reads re-check the member's permission in the same transaction. Kept out of edge/session.ts so
// the shared file only gains the handlers and permissions.
import {
  NotFound, idempotencyKeySchema, uuidSchema,
  browserRunOutputSchema, browserStatusOutputSchema, browserTargetOutputSchema,
  killBrowserRequestSchema, requestBrowserRunRequestSchema, resumeBrowserRequestSchema, saveBrowserTargetRequestSchema,
  updateBrowserSettingsRequestSchema,
  type BrowserRunDetail, type BrowserRunList, type BrowserRunOutput, type BrowserStatus, type BrowserStatusOutput, type BrowserTargetOutput,
  type JsonValue, type Permission,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { readClock } from "../booking/slots.js";
import { derivedId } from "../edge/ids.js";
import { directDispatch, memberAuthorize, parseInput, type EdgeDependencies, type Principal } from "../edge/session.js";
import { requireMember } from "../members/access.js";
import type { BrowserConfig } from "./config.js";
import {
  BROWSER_KILL_ACTION, BROWSER_RESUME_ACTION, BROWSER_RUN_REQUEST_ACTION, BROWSER_SETTINGS_ACTION, BROWSER_TARGET_SAVE_ACTION,
} from "./handlers.js";
import { browserStatus, getArtifactKey, getBrowserRunDetail, listBrowserRuns } from "./rows.js";
import type { BrowserArtifactStore } from "./store.js";

const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

export interface BrowserSessionOptions {
  readonly config: BrowserConfig;
  readonly artifacts: BrowserArtifactStore;
}

export function createBrowserSession(deps: EdgeDependencies, principal: Principal, options: BrowserSessionOptions) {
  const tenantId = uuidSchema.parse(principal.tenantId);
  const actorId = uuidSchema.parse(principal.actorId);
  const run = directDispatch(deps, tenantId, actorId, memberAuthorize(tenantId, actorId), { browser: options.config });
  const read = <T>(permission: Permission, work: (tx: Transaction) => Promise<T>) =>
    deps.db.tenant(tenantId, async (tx) => { await requireMember(tx, tenantId, actorId, permission); return work(tx); });
  const key = (raw: unknown) => parseInput(idempotencyKeySchema, raw, "Idempotency-Key");
  const approval = (idempotencyKey: string) => ({ tenantId, id: derivedId(tenantId, idempotencyKey, "approval") });
  const settingsEnvelope = (raw: unknown) => {
    const idempotencyKey = key(raw);
    return { target: { tenantId, type: "browser_settings", id: tenantId }, approvalReference: approval(idempotencyKey), idempotencyKey };
  };
  const now = () => new Date(readClock(deps.clock));

  return {
    /** BT-12: the kill state and caps. Staff may read it, since they may stop the tasks. */
    getStatus: (): Promise<BrowserStatus> => read("inbox.drafts", (tx) => browserStatus(tx, tenantId, now())),
    async updateSettings(body: unknown, rawKey: unknown): Promise<BrowserStatusOutput> {
      const request = parseInput(updateBrowserSettingsRequestSchema, body);
      return parseInput(browserStatusOutputSchema,
        await run({ actionType: BROWSER_SETTINGS_ACTION, ...settingsEnvelope(rawKey), payload: toJson(request) }), "result");
    },
    /** BT-12: any member who drafts may stop the tasks at once. */
    async kill(body: unknown, rawKey: unknown): Promise<BrowserStatusOutput> {
      const request = parseInput(killBrowserRequestSchema, body);
      return parseInput(browserStatusOutputSchema,
        await run({ actionType: BROWSER_KILL_ACTION, ...settingsEnvelope(rawKey), payload: toJson(request) }), "result");
    },
    async resume(body: unknown, rawKey: unknown): Promise<BrowserStatusOutput> {
      const request = parseInput(resumeBrowserRequestSchema, body);
      return parseInput(browserStatusOutputSchema,
        await run({ actionType: BROWSER_RESUME_ACTION, ...settingsEnvelope(rawKey), payload: toJson(request) }), "result");
    },
    /** BT-3: create (no targetId) or change a target, compare-and-set on its revision. */
    async saveTarget(body: unknown, rawKey: unknown): Promise<BrowserTargetOutput> {
      const request = parseInput(saveBrowserTargetRequestSchema, body);
      const idempotencyKey = key(rawKey);
      const id = request.targetId ?? derivedId(tenantId, idempotencyKey, "browser_target");
      return parseInput(browserTargetOutputSchema, await run({
        actionType: BROWSER_TARGET_SAVE_ACTION, target: { tenantId, type: "browser_target", id },
        approvalReference: approval(idempotencyKey), idempotencyKey, payload: toJson(request),
      }), "result");
    },
    /** BT-9: queue a run. The runner claims it later. */
    async requestRun(body: unknown, rawKey: unknown): Promise<BrowserRunOutput> {
      const request = parseInput(requestBrowserRunRequestSchema, body);
      const idempotencyKey = key(rawKey);
      return parseInput(browserRunOutputSchema, await run({
        actionType: BROWSER_RUN_REQUEST_ACTION, target: { tenantId, type: "browser_run", id: derivedId(tenantId, idempotencyKey, "browser_run") },
        approvalReference: approval(idempotencyKey), idempotencyKey, payload: toJson(request),
      }), "result");
    },
    listRuns: (): Promise<BrowserRunList> => read("agents", async (tx) => ({ items: await listBrowserRuns(tx, tenantId) })),
    getRun: (runId: unknown): Promise<BrowserRunDetail> => {
      const id = parseInput(uuidSchema, runId, "run ID");
      return read("agents", async (tx) => {
        const found = await getBrowserRunDetail(tx, tenantId, id);
        if (!found) throw new NotFound();
        return found;
      });
    },
    /** BT-6, BT-13: one file of a run. The row is read under the tenant's RLS, so another tenant's file is not found. */
    async getArtifact(runId: unknown, artifactId: unknown): Promise<{ name: string; kind: "invoice_pdf" | "screenshot"; bytes: Uint8Array; contentType: string }> {
      const run = parseInput(uuidSchema, runId, "run ID");
      const artifact = parseInput(uuidSchema, artifactId, "artifact ID");
      const found = await read("agents", (tx) => getArtifactKey(tx, tenantId, run, artifact));
      if (!found) throw new NotFound();
      const object = await options.artifacts.get(found.key);
      if (!object) throw new NotFound();
      return { name: found.name, kind: found.kind, bytes: object.bytes, contentType: object.contentType };
    },
  };
}
export type BrowserSession = ReturnType<typeof createBrowserSession>;
