// The image worker (image-port.md IM-5, IM-7..IM-11, IM-15). It runs as the service role and
// writes the variant's outcome only through the media.variant.* actions, as its own principal.
// The vendor call never happens inside a database transaction, and no transaction here dispatches
// an action on a row it holds: each step is a short transaction, a call, then a dispatch.
import {
  Conflict,
  MEDIA_LIMITS,
  mediaObjectKeys,
  TenantDenied,
  type ActionCommand,
  type ImageFailureReason,
  type SiteObjectStore,
  type Target,
} from "@zs/contracts";
import type { ScopedDatabase, Transaction } from "@zs/db";
import { readClock } from "../booking/slots.js";
import { derivedId } from "../edge/ids.js";
import { directDispatch, type Authorize, type EdgeDependencies } from "../edge/session.js";
import { captureReservation, heldReservationForJob, releaseReservation, reserveForJob } from "../wallet/index.js";
import { findAllowedModel } from "./allowlist.js";
import { checkMatte, checkProductPixels, composite, effectiveAlpha, MATTE_PRESETS } from "./compose.js";
import type { ImageConfig } from "./config.js";
import {
  ImageAdapterRefused,
  ImageOutcomeUnknown,
  sha256Hex,
  type ImageWorkflowPort,
  type PresetInput,
  type PresetOutput,
} from "./port.js";
import { decodePng, encodeRgbaPng, readImageInfo, sizeAllowed } from "./png.js";
import type { VariantRow } from "./records.js";

export const IMAGE_WORKER_ACTIONS: readonly string[] = Object.freeze(["media.variant.stage", "media.variant.fail"]);
export const imageActorId = (tenantId: string) => derivedId(tenantId, "image-worker", "actor");
/** IM-15: the worker principal may stage and fail a variant and do nothing else. */
export const imageWorkerAuthorize: Authorize = async (_tx, binding) => {
  if (!IMAGE_WORKER_ACTIONS.includes(binding.actionType)) throw new TenantDenied();
};

export type ImageReport =
  | { readonly kind: "staged"; readonly tenantId: string; readonly variantId: string }
  | { readonly kind: "failed"; readonly tenantId: string; readonly variantId: string; readonly reason: ImageFailureReason }
  | { readonly kind: "promoted"; readonly tenantId: string; readonly variantId: string }
  | { readonly kind: "expired"; readonly tenantId: string; readonly variantId: string }
  | { readonly kind: "error"; readonly tenantId: string; readonly variantId: string; readonly error: string };

export interface ImageWorkerDeps {
  /** A service-role transaction: `(work) => asService(servicePool, work)`. */
  readonly service: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
  /** The runtime-role database the worker's actions dispatch through. */
  readonly db: ScopedDatabase;
  readonly store: SiteObjectStore;
  readonly port: ImageWorkflowPort;
  readonly config: ImageConfig;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  readonly report?: (event: ImageReport) => void;
}

export interface ImageRunSummary {
  readonly started: number;
  readonly staged: number;
  readonly failed: number;
  readonly promoted: number;
  readonly expired: number;
  readonly captured: number;
  readonly released: number;
}

const BATCH = 10;
const PNG = "image/png";

type Verdict =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly contentType: "image/png" | "image/webp"; readonly matte: Uint8Array | null; readonly background: Uint8Array | null }
  | { readonly ok: false; readonly reason: ImageFailureReason };

const refuse = (reason: ImageFailureReason): Verdict => ({ ok: false, reason });

/** IM-9: the vendor's files are checked against our own composite; what is staged is our composite. */
function verify(variant: VariantRow, source: { bytes: Uint8Array; sha256: string }, output: PresetOutput): Verdict {
  if (sha256Hex(output.bytes) !== output.sha256) return refuse("digest_mismatch");
  if (output.matte && sha256Hex(output.matte.bytes) !== output.matte.sha256) return refuse("digest_mismatch");
  if (output.background && sha256Hex(output.background.bytes) !== output.background.sha256) return refuse("digest_mismatch");
  if (output.bytes.byteLength > MEDIA_LIMITS.fileBytes) return refuse("output_invalid");

  if (!MATTE_PRESETS.has(variant.preset)) {
    const sourceInfo = readImageInfo(source.bytes);
    const info = readImageInfo(output.bytes);
    if (!sourceInfo || !info || !sizeAllowed(info.width, info.height) || info.width !== output.width || info.height !== output.height) return refuse("output_invalid");
    // The upscale keeps the picture's proportions: width x source height may differ from height x source width by one source pixel row.
    if (Math.abs(info.width * sourceInfo.height - info.height * sourceInfo.width) > Math.max(sourceInfo.width, sourceInfo.height)) return refuse("size_changed");
    return { ok: true, bytes: output.bytes, contentType: output.contentType, matte: null, background: null };
  }

  let sourceImage;
  try { sourceImage = decodePng(source.bytes); } catch { return refuse("source_undecodable"); }
  if (!output.matte) return refuse("matte_invalid");
  const matte = checkMatte(output.matte.bytes, sourceImage);
  if (!matte.ok) return refuse("matte_invalid");
  let background = null;
  if (variant.preset === "studio_background_swap") {
    if (!output.background) return refuse("output_invalid");
    try { background = decodePng(output.background.bytes); } catch { return refuse("output_invalid"); }
    if (background.width !== sourceImage.width || background.height !== sourceImage.height) return refuse("output_invalid");
  }
  const expected = composite(sourceImage, matte.alpha, background);
  let produced;
  try { produced = decodePng(output.bytes); } catch { return refuse("output_invalid"); }
  const lock = checkProductPixels(expected, effectiveAlpha(sourceImage, matte.alpha), produced);
  if (!lock.ok) return refuse(lock.reason);
  const staged = encodeRgbaPng(expected);
  // Our composite is re-encoded, so its size is checked too: it must fit what an asset may hold.
  if (staged.byteLength > MEDIA_LIMITS.fileBytes) return refuse("output_invalid");
  return {
    ok: true, bytes: staged, contentType: PNG,
    matte: output.matte.bytes, background: background ? output.background!.bytes : null,
  };
}

export function createImageWorker(deps: ImageWorkerDeps) {
  // A configured adapter and a wired port must be the same one, or the allowlist checks prove nothing.
  if (deps.port.adapter !== deps.config.adapter) throw new Error("The image port does not match the configured adapter");
  const now = () => new Date(readClock(deps.clock));
  const edge: EdgeDependencies = { db: deps.db, clock: deps.clock, generateId: deps.generateId };
  const report = (event: ImageReport) => { try { deps.report?.(event); } catch { /* a reporter never stops the worker */ } };

  const command = (tenantId: string, variantId: string, step: string, actionType: string, payload: ActionCommand["payload"]): ActionCommand => {
    const idempotencyKey = `image-job:${variantId}:${step}`;
    const target: Target = { tenantId, type: "media_variant", id: variantId };
    return { actionType, target, payload, approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") }, idempotencyKey } as ActionCommand;
  };
  const dispatchFor = (tenantId: string) => directDispatch(edge, tenantId, imageActorId(tenantId), imageWorkerAuthorize);

  async function fail(
    tenantId: string, variantId: string, reason: ImageFailureReason, providerJobId: string | null = null,
    expectStatus: "queued" | "running" = "running",
  ): Promise<void> {
    try {
      await dispatchFor(tenantId)(command(tenantId, variantId, "fail", "media.variant.fail", { variantId, reason, providerJobId, expectStatus }));
    } catch (error) {
      // Another pass moved this job on first: its answer stands, and a job that runs keeps its hold.
      if (error instanceof Conflict && (error.details as { reason?: string } | undefined)?.reason === "variant_changed") return;
      throw error;
    }
    report({ kind: "failed", tenantId, variantId, reason });
  }

  /** IM-13: a name taken by other bytes is an error; the same bytes are fine (a retry). */
  async function putOnce(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const written = await deps.store.put(key, bytes, { contentType, onlyIf: { absent: true } });
    if (written) return;
    const existing = await deps.store.get(key);
    if (!existing || sha256Hex(existing.body) !== sha256Hex(bytes)) throw new Error("A stored image does not match its digest");
  }

  /** IM-10: verify a vendor output, write the staged files, then record the variant as staged. */
  async function finish(variant: VariantRow, tenantId: string, source: { bytes: Uint8Array; sha256: string }, output: PresetOutput, providerJobId: string | null): Promise<"staged" | "failed"> {
    const jobId = output.provenance.providerJobId ?? providerJobId;
    const entry = findAllowedModel(output.provenance.adapter, output.provenance.modelId);
    if (!entry) { await fail(tenantId, variant.id, "model_not_allowed", jobId); return "failed"; }
    const verdict = verify(variant, source, output);
    if (!verdict.ok) { await fail(tenantId, variant.id, verdict.reason, jobId); return "failed"; }
    const sha256 = sha256Hex(verdict.bytes);
    const matteSha = verdict.matte ? sha256Hex(verdict.matte) : null;
    const backgroundSha = verdict.background ? sha256Hex(verdict.background) : null;
    // Keep the vendor's job ID first: if a file write fails, a later pass can still ask about the job.
    await rememberJob(tenantId, variant.id, jobId);
    await putOnce(mediaObjectKeys.staging(tenantId, variant.id, sha256), verdict.bytes, verdict.contentType);
    if (verdict.matte && matteSha) await putOnce(mediaObjectKeys.matte(tenantId, variant.id, matteSha), verdict.matte, PNG);
    if (verdict.background && backgroundSha) await putOnce(mediaObjectKeys.background(tenantId, variant.id, backgroundSha), verdict.background, PNG);
    await dispatchFor(tenantId)(command(tenantId, variant.id, "stage", "media.variant.stage", {
      variantId: variant.id, sha256, matteSha256: matteSha, backgroundSha256: backgroundSha,
      adapter: output.provenance.adapter, modelId: output.provenance.modelId, modelLicense: entry.license,
      workflowHash: output.provenance.workflowHash, promptText: output.provenance.promptText,
      providerJobId: jobId, vendorCostMicros: output.provenance.vendorCostMicros,
    }));
    report({ kind: "staged", tenantId, variantId: variant.id });
    return "staged";
  }

  async function loadSource(tenantId: string, variant: VariantRow): Promise<{ bytes: Uint8Array; sha256: string } | null> {
    const object = await deps.store.get(mediaObjectKeys.asset(tenantId, variant.source_sha256));
    if (!object || sha256Hex(object.body) !== variant.source_sha256) return null;
    return { bytes: object.body, sha256: variant.source_sha256 };
  }

  type Claim =
    | { readonly kind: "none" }
    | { readonly kind: "fail"; readonly tenantId: string; readonly variant: VariantRow; readonly reason: ImageFailureReason }
    | { readonly kind: "run"; readonly tenantId: string; readonly variant: VariantRow };

  /** IM-7: take the next queued job, check its model, reserve its price and mark it running. */
  async function claim(skip: readonly string[]): Promise<Claim> {
    return deps.service(async (tx) => {
      const at = now();
      const row = (await tx.query<VariantRow & { tenant_id: string }>(
        `SELECT tenant_id, id, source_asset_id, source_sha256, preset, params, status, price_minor, currency, created_by, created_at
           FROM image_variants WHERE status='queued' AND id <> ALL($1::uuid[])
          ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`, [skip])).rows[0];
      if (!row) return { kind: "none" } as const;
      const variant = row as VariantRow;
      if (!findAllowedModel(deps.port.adapter, deps.port.modelId(variant.preset)))
        return { kind: "fail", tenantId: row.tenant_id, variant, reason: "model_not_allowed" } as const;
      const held = await reserveForJob(tx, {
        tenantId: row.tenant_id, jobKind: "image_job", jobId: variant.id,
        reservationId: derivedId(row.tenant_id, variant.id, "image-reservation"),
        amount: variant.price_minor, currency: variant.currency, now: at,
      });
      if (!held) return { kind: "fail", tenantId: row.tenant_id, variant, reason: "insufficient_funds" } as const;
      await tx.query("UPDATE image_variants SET status='running' WHERE tenant_id=$1 AND id=$2 AND status='queued'", [row.tenant_id, variant.id]);
      return { kind: "run", tenantId: row.tenant_id, variant } as const;
    });
  }

  async function rememberJob(tenantId: string, variantId: string, providerJobId: string | null): Promise<void> {
    if (!providerJobId) return;
    await deps.service((tx) => tx.query(
      "UPDATE image_variants SET provider_job_id=$3 WHERE tenant_id=$1 AND id=$2 AND status='running' AND provider_job_id IS NULL",
      [tenantId, variantId, providerJobId]));
  }

  type SourceInfo = { content_type: string; width: number; height: number };
  async function sourceInfo(tenantId: string, variant: VariantRow): Promise<SourceInfo | undefined> {
    return (await deps.service((tx) => tx.query<SourceInfo>(
      "SELECT content_type, width, height FROM media_assets WHERE tenant_id=$1 AND id=$2", [tenantId, variant.source_asset_id]))).rows[0];
  }
  const presetInput = (tenantId: string, variant: VariantRow, source: { bytes: Uint8Array; sha256: string }, info: SourceInfo): PresetInput => ({
    tenantId, variantId: variant.id, preset: variant.preset, params: variant.params,
    source: { bytes: source.bytes, contentType: info.content_type, sha256: source.sha256, width: info.width, height: info.height },
    idempotencyKey: variant.id,
  });

  /** The vendor call for one claimed job; the outcome is staged, failed or left running (unknown). */
  async function execute(variant: VariantRow, tenantId: string): Promise<"staged" | "failed" | "unknown"> {
    const info = await sourceInfo(tenantId, variant);
    const source = info ? await loadSource(tenantId, variant) : null;
    if (!info || !source) { await fail(tenantId, variant.id, "digest_mismatch"); return "failed"; }
    if (MATTE_PRESETS.has(variant.preset)) {
      try { decodePng(source.bytes); } catch { await fail(tenantId, variant.id, "source_undecodable"); return "failed"; }
    } else if (!readImageInfo(source.bytes)) { await fail(tenantId, variant.id, "source_undecodable"); return "failed"; }
    let output: PresetOutput;
    try {
      output = await deps.port.runPreset(presetInput(tenantId, variant, source, info));
    } catch (error) {
      if (error instanceof ImageAdapterRefused) { await fail(tenantId, variant.id, "adapter_error"); return "failed"; }
      // Any other error may have left a job running at the vendor: never send it again.
      if (error instanceof ImageOutcomeUnknown) await rememberJob(tenantId, variant.id, error.providerJobId);
      return "unknown";
    }
    return finish(variant, tenantId, source, output, null);
  }

  /** IM-7: a running job whose answer never came is asked about, then failed after the wait. */
  async function resolveUnknown(skip: ReadonlySet<string>, summary: { staged: number; failed: number }): Promise<void> {
    const rows = await deps.service(async (tx) => (await tx.query<VariantRow & { tenant_id: string; held_at: Date | null }>(
      `SELECT v.tenant_id, v.id, v.source_asset_id, v.source_sha256, v.preset, v.params, v.provider_job_id,
              (SELECT r.created_at FROM wallet_reservations r WHERE r.tenant_id=v.tenant_id AND r.job_kind='image_job' AND r.job_id=v.id
                ORDER BY r.created_at LIMIT 1) AS held_at
         FROM image_variants v WHERE v.status='running' ORDER BY v.created_at, v.id LIMIT $1`, [BATCH * 5])).rows);
    for (const row of rows) {
      if (skip.has(row.id)) continue;
      const tenantId = row.tenant_id;
      try {
        const variant = row as VariantRow;
        const waited = row.held_at ? now().getTime() - row.held_at.getTime() : Infinity;
        if (row.provider_job_id) {
          // IM-18: the lookup gets the job's input again, so a vendor adapter can rebuild the composite.
          const info = await sourceInfo(tenantId, variant);
          const source = info ? await loadSource(tenantId, variant) : null;
          if (!info || !source) { await fail(tenantId, row.id, "digest_mismatch", row.provider_job_id); summary.failed += 1; continue; }
          // A lookup that throws is no answer: report it and let the wait below still run out.
          let answer: Awaited<ReturnType<ImageWorkflowPort["lookup"]>> = { state: "pending" };
          try { answer = await deps.port.lookup(row.provider_job_id, presetInput(tenantId, variant, source, info)); } catch (error) {
            report({ kind: "error", tenantId, variantId: row.id, error: error instanceof Error ? error.message.slice(0, 300) : "lookup failed" });
          }
          if (answer.state === "done") {
            if ((await finish(variant, tenantId, source, answer.output, row.provider_job_id)) === "staged") summary.staged += 1; else summary.failed += 1;
            continue;
          }
          if (answer.state === "failed") { await fail(tenantId, row.id, "adapter_error", row.provider_job_id); summary.failed += 1; continue; }
        }
        if (waited >= deps.config.outcomeWaitMs) { await fail(tenantId, row.id, "outcome_unknown", row.provider_job_id); summary.failed += 1; }
      } catch (error) {
        report({ kind: "error", tenantId, variantId: row.id, error: error instanceof Error ? error.message.slice(0, 300) : "unknown" });
      }
    }
  }

  /** IM-7: capture once a variant is staged; release when it failed (an unknown outcome keeps its hold). */
  async function settle(): Promise<{ captured: number; released: number }> {
    const rows = await deps.service(async (tx) => (await tx.query<{ tenant_id: string; job_id: string; status: string; failure_reason: string | null }>(
      `SELECT r.tenant_id, r.job_id, v.status, v.failure_reason
         FROM wallet_reservations r JOIN image_variants v ON v.tenant_id=r.tenant_id AND v.id=r.job_id
        WHERE r.job_kind='image_job' AND r.status='held'
          AND (v.status IN ('staged','approved','promoted','expired') OR (v.status='failed' AND v.failure_reason <> 'outcome_unknown'))
        ORDER BY r.created_at LIMIT 200`)).rows);
    let captured = 0;
    let released = 0;
    for (const row of rows) {
      await deps.service(async (tx) => {
        const held = await heldReservationForJob(tx, row.tenant_id, "image_job", row.job_id);
        if (!held) return;
        const at = now();
        if (row.status === "failed") {
          if ((await releaseReservation(tx, { tenantId: row.tenant_id, reservationId: held.id, now: at })) === "released") released += 1;
        } else if ((await captureReservation(tx, {
          tenantId: row.tenant_id, reservationId: held.id, ledgerId: derivedId(row.tenant_id, held.id, "image-capture"), now: at,
        })) === "captured") captured += 1;
      });
    }
    return { captured, released };
  }

  /** IM-11: past its 14 days a staged image expires and its staging file goes. */
  async function expire(): Promise<number> {
    const expired = await deps.service(async (tx) => (await tx.query<{ tenant_id: string; id: string; sha256: string }>(
      `UPDATE image_variants SET status='expired'
        WHERE (tenant_id, id) IN (SELECT tenant_id, id FROM image_variants WHERE status='staged' AND expires_at <= $1
                                   ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)
        RETURNING tenant_id, id, sha256`, [now()])).rows);
    for (const row of expired) report({ kind: "expired", tenantId: row.tenant_id, variantId: row.id });
    // Deleting is idempotent, so each pass also retries the recent expiries: a failed delete is not lost.
    const recent = await deps.service(async (tx) => (await tx.query<{ tenant_id: string; id: string; sha256: string }>(
      `SELECT tenant_id, id, sha256 FROM image_variants WHERE status='expired' AND expires_at > $1 ORDER BY expires_at DESC LIMIT 100`,
      [new Date(now().getTime() - 7 * 24 * 60 * 60 * 1000)])).rows);
    for (const row of recent) {
      await deps.store.delete(mediaObjectKeys.staging(row.tenant_id, row.id, row.sha256)).catch((error: unknown) =>
        report({ kind: "error", tenantId: row.tenant_id, variantId: row.id, error: error instanceof Error ? error.message.slice(0, 300) : "delete failed" }));
    }
    return expired.length;
  }

  /** IM-12, IM-15: an approved variant becomes an asset the sites may publish, and a source record says where it came from. */
  async function promote(): Promise<number> {
    const skip: string[] = [];
    let promoted = 0;
    for (let count = 0; count < BATCH; count += 1) {
      let done: { tenantId: string; id: string } | null | "skipped";
      try {
        done = await deps.service(async (tx) => {
          const row = (await tx.query<VariantRow & { tenant_id: string }>(
            `SELECT tenant_id, id, sha256, approved_at FROM image_variants
              WHERE status='approved' AND id <> ALL($1::uuid[]) ORDER BY approved_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`, [skip])).rows[0];
          if (!row) return null;
          skip.push(row.id);
          const tenantId = row.tenant_id;
          const staged = await deps.store.get(mediaObjectKeys.staging(tenantId, row.id, row.sha256!));
          const info = staged ? readImageInfo(staged.body) : null;
          if (!staged || !info || sha256Hex(staged.body) !== row.sha256) {
            report({ kind: "error", tenantId, variantId: row.id, error: "The staged image is missing or changed" });
            return "skipped" as const;
          }
          await putOnce(mediaObjectKeys.asset(tenantId, row.sha256!), staged.body, info.contentType);
          const at = now();
          await tx.query(
            `INSERT INTO media_assets (tenant_id, id, sha256, content_type, byte_length, width, height, origin, variant_id, created_by, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'variant',$8,$9,$10) ON CONFLICT (tenant_id, sha256) DO NOTHING`,
            [tenantId, derivedId(tenantId, row.id, "media-asset"), row.sha256, info.contentType, staged.body.byteLength,
              info.width, info.height, row.id, imageActorId(tenantId), at]);
          const asset = (await tx.query<{ id: string }>("SELECT id FROM media_assets WHERE tenant_id=$1 AND sha256=$2", [tenantId, row.sha256]))
            .rows[0]!;
          await tx.query(
            `INSERT INTO source_records (tenant_id, id, subject_type, subject_id, source, source_ref, observed_at, fresh_until, revision,
               recorded_by, recorded_at, updated_at)
             VALUES ($1,$2,'media_asset',$3,'image_variant',$4,$5,NULL,1,$6,$5,$5)
             ON CONFLICT (tenant_id, subject_type, subject_id, source) DO NOTHING`,
            [tenantId, derivedId(tenantId, row.id, "source-record"), asset.id, row.id, at, imageActorId(tenantId)]);
          await tx.query("UPDATE image_variants SET status='promoted', promoted_at=$3 WHERE tenant_id=$1 AND id=$2 AND status='approved'",
            [tenantId, row.id, at]);
          return { tenantId, id: row.id };
        });
      } catch (error) {
        report({ kind: "error", tenantId: "", variantId: skip.at(-1) ?? "", error: error instanceof Error ? error.message.slice(0, 300) : "unknown" });
        continue;
      }
      if (done === null) break;
      if (done !== "skipped") { promoted += 1; report({ kind: "promoted", tenantId: done.tenantId, variantId: done.id }); }
    }
    return promoted;
  }

  return {
    /** One pass: start queued jobs, ask about unknown ones, promote and expire, then settle the wallet. */
    async runOnce(): Promise<ImageRunSummary> {
      const summary = { started: 0, staged: 0, failed: 0, promoted: 0, expired: 0, captured: 0, released: 0 };
      const handled = new Set<string>();
      const skip: string[] = [];
      for (let count = 0; count < BATCH; count += 1) {
        const claimed = await claim(skip);
        if (claimed.kind === "none") break;
        const tenantId = claimed.tenantId;
        skip.push(claimed.variant.id);
        handled.add(claimed.variant.id);
        try {
          if (claimed.kind === "fail") { await fail(tenantId, claimed.variant.id, claimed.reason, null, "queued"); summary.failed += 1; continue; }
          summary.started += 1;
          const outcome = await execute(claimed.variant, tenantId);
          if (outcome === "staged") summary.staged += 1;
          else if (outcome === "failed") summary.failed += 1;
        } catch (error) {
          report({ kind: "error", tenantId, variantId: claimed.variant.id, error: error instanceof Error ? error.message.slice(0, 300) : "unknown" });
        }
      }
      await resolveUnknown(handled, summary);
      summary.promoted = await promote();
      summary.expired = await expire();
      const settled = await settle();
      return { ...summary, captured: settled.captured, released: settled.released };
    },
    settle,
  };
}
export type ImageWorker = ReturnType<typeof createImageWorker>;
