// Image actions (image-port.md IM-3, IM-4, IM-10, IM-12). They run inside the shared dispatcher
// transaction and touch only the database, except the upload check, which asks the store whether
// the bytes the edge wrote are there. The model, the vendor and the wallet are the worker's job.
import {
  approveVariantCommandSchema,
  Conflict,
  failVariantCommandSchema,
  generateVariantCommandSchema,
  MEDIA_LIMITS,
  NotFound,
  stageVariantCommandSchema,
  uploadAssetCommandSchema,
  ValidationFailed,
  mediaObjectKeys,
  type JsonValue,
  type SiteObjectStore,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { parseOrFail } from "../crm/rows.js";
import { findAllowedModel } from "./allowlist.js";
import { imagePrice, type ImageConfig } from "./config.js";
import { assetColumns, assetRecord, findVariant, variantRecord, type AssetRow } from "./records.js";

/** What the upload and generate handlers need from the deploy. Absent means image jobs are off. */
export interface ImageDependencies {
  readonly store: SiteObjectStore;
  readonly config: ImageConfig;
}

const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

function dependencies(config: Readonly<Record<string, unknown>>): ImageDependencies {
  const images = config.images as ImageDependencies | undefined;
  if (!images) throw new ValidationFailed("Image jobs are not turned on");
  return images;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function targetResolver(type: "media_asset" | "media_variant", table: "media_assets" | "image_variants", mustExist: boolean) {
  return async (tx: Transaction, target: Target): Promise<Target | null> => {
    if (target.type !== type) throw new ValidationFailed("Image actions require a media target");
    if (!mustExist) return { tenantId: target.tenantId, type, id: target.id };
    const owned = await tx.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1 AND id=$2`, [target.tenantId, target.id]);
    return owned.rowCount === 1 ? { tenantId: target.tenantId, type, id: target.id } : null;
  };
}

async function loadVariant(tx: Transaction, tenantId: string, id: string) {
  const row = await findVariant(tx, tenantId, id, true);
  if (!row) throw new NotFound("Image variant not found");
  return row;
}

/** IM-3: the edge hashed and stored the bytes; one asset per digest, so a second upload returns the first. */
export const uploadAssetHandler: ActionHandler = {
  resolveTarget: targetResolver("media_asset", "media_assets", false),
  async handle({ tx, command, binding, now, config }) {
    const { payload } = parseOrFail(uploadAssetCommandSchema, command);
    const { store } = dependencies(config);
    const tenantId = binding.tenantId;
    const stored = await store.head(mediaObjectKeys.asset(tenantId, payload.sha256));
    if (stored?.size !== payload.byteLength) throw new Conflict("The uploaded image is not stored", { reason: "upload_missing" });
    if (payload.byteLength > MEDIA_LIMITS.fileBytes) throw new ValidationFailed("Image is too large");
    await tx.query(
      `INSERT INTO media_assets (tenant_id, id, sha256, content_type, byte_length, width, height, origin, variant_id, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'upload',NULL,$8,$9)
       ON CONFLICT (tenant_id, sha256) DO NOTHING`,
      [tenantId, payload.assetId, payload.sha256, payload.contentType, payload.byteLength, payload.width, payload.height, binding.actorId, now],
    );
    const row = (await tx.query<AssetRow>(
      `SELECT ${assetColumns} FROM media_assets WHERE tenant_id=$1 AND sha256=$2`, [tenantId, payload.sha256])).rows[0]!;
    return { result: json(assetRecord(row)) };
  },
};

/** IM-4: queue one job. The price is the server's (IM-7); the wallet is reserved when the worker takes the job. */
export const generateVariantHandler: ActionHandler = {
  resolveTarget: targetResolver("media_variant", "image_variants", false),
  async handle({ tx, command, binding, now, config }) {
    const { payload } = parseOrFail(generateVariantCommandSchema, command);
    const { config: imageConfig } = dependencies(config);
    const tenantId = binding.tenantId;
    const source = (await tx.query<{ sha256: string }>(
      "SELECT sha256 FROM media_assets WHERE tenant_id=$1 AND id=$2", [tenantId, payload.sourceAssetId])).rows[0];
    if (!source) throw new NotFound("Source image not found");
    const { priceMinor, currency } = imagePrice(imageConfig, payload.preset);
    const inserted = await tx.query(
      `INSERT INTO image_variants (tenant_id, id, source_asset_id, source_sha256, preset, params, price_minor, currency, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
       ON CONFLICT (tenant_id, id) DO NOTHING`,
      [tenantId, payload.variantId, payload.sourceAssetId, source.sha256, payload.preset, JSON.stringify(payload.params),
        priceMinor, currency, binding.actorId, now],
    );
    if (inserted.rowCount !== 1) throw new Conflict("Variant ID is already in use", { reason: "id_in_use" });
    const row = (await findVariant(tx, tenantId, payload.variantId))!;
    return {
      result: json(variantRecord(row)),
      event: { type: "media.variant.requested", payload: { variantId: payload.variantId } },
    };
  },
};

/**
 * IM-12: the owner's approval. Runs only through a stored approval (approvals.md): it fixes the
 * digest the owner saw, and it moves no bytes (the promotion worker does, from the outbox event).
 */
export const approveVariantHandler: ActionHandler = {
  resolveTarget: targetResolver("media_variant", "image_variants", true),
  async handle({ tx, command, binding, clock }) {
    const { payload } = parseOrFail(approveVariantCommandSchema, command);
    const tenantId = binding.tenantId;
    const row = await loadVariant(tx, tenantId, payload.variantId);
    // The row lock may have waited: judge expiry and stamp the approval at the instant it is decided.
    const now = clock();
    if (row.status === "approved" || row.status === "promoted") {
      if (row.sha256 !== payload.sha256) throw new Conflict("The image changed since it was shown", { reason: "variant_changed" });
      return { result: json(variantRecord(row)) };
    }
    if (row.status === "expired" || (row.status === "staged" && row.expires_at !== null && now.getTime() >= row.expires_at.getTime()))
      throw new Conflict("The staged image expired", { reason: "variant_expired" });
    if (row.status !== "staged") throw new Conflict("The image is not ready to approve", { reason: "variant_not_staged", status: row.status });
    if (row.sha256 !== payload.sha256) throw new Conflict("The image changed since it was shown", { reason: "variant_changed" });
    await tx.query(
      "UPDATE image_variants SET status='approved', approved_at=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, payload.variantId, now]);
    const updated = (await findVariant(tx, tenantId, payload.variantId))!;
    return {
      result: json(variantRecord(updated)),
      event: { type: "media.variant.approved", payload: { variantId: payload.variantId, sha256: payload.sha256 } },
    };
  },
};

/** IM-10, IM-15: the worker principal records the verified output and every provenance field, once. */
export const stageVariantHandler: ActionHandler = {
  resolveTarget: targetResolver("media_variant", "image_variants", true),
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(stageVariantCommandSchema, command);
    const tenantId = binding.tenantId;
    const allowed = findAllowedModel(payload.adapter, payload.modelId);
    if (!allowed || allowed.license !== payload.modelLicense) throw new ValidationFailed("That model is not allowed");
    const row = await loadVariant(tx, tenantId, payload.variantId);
    if (row.status === "staged" && row.sha256 === payload.sha256) return { result: json(variantRecord(row)) };
    if (row.status !== "running") throw new Conflict("The image job is not running", { reason: "variant_not_running", status: row.status });
    await tx.query(
      `UPDATE image_variants SET status='staged', sha256=$3, matte_sha256=$4, background_sha256=$5, adapter=$6, model_id=$7,
         model_license=$8, workflow_hash=$9, prompt_text=$10, provider_job_id=COALESCE(provider_job_id, $11),
         vendor_cost_micros=$12, staged_at=$13, expires_at=$14
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, payload.variantId, payload.sha256, payload.matteSha256, payload.backgroundSha256, payload.adapter, payload.modelId,
        payload.modelLicense, payload.workflowHash, payload.promptText, payload.providerJobId, payload.vendorCostMicros, now,
        new Date(now.getTime() + MEDIA_LIMITS.stagingDays * DAY_MS)],
    );
    const updated = (await findVariant(tx, tenantId, payload.variantId))!;
    return {
      result: json(variantRecord(updated)),
      event: { type: "media.variant.staged", payload: { variantId: payload.variantId, sha256: payload.sha256 } },
    };
  },
};

/** IM-10: a job that cannot finish says why. Nothing is staged. */
export const failVariantHandler: ActionHandler = {
  resolveTarget: targetResolver("media_variant", "image_variants", true),
  async handle({ tx, command, binding }) {
    const { payload } = parseOrFail(failVariantCommandSchema, command);
    const tenantId = binding.tenantId;
    const row = await loadVariant(tx, tenantId, payload.variantId);
    if (row.status === "failed") return { result: json(variantRecord(row)) };
    if (payload.expectStatus && row.status !== payload.expectStatus)
      throw new Conflict("The image job moved on", { reason: "variant_changed", status: row.status });
    if (row.status !== "queued" && row.status !== "running")
      throw new Conflict("The image job already finished", { reason: "variant_not_running", status: row.status });
    await tx.query(
      `UPDATE image_variants SET status='failed', failure_reason=$3, provider_job_id=COALESCE(provider_job_id, $4)
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, payload.variantId, payload.reason, payload.providerJobId],
    );
    const updated = (await findVariant(tx, tenantId, payload.variantId))!;
    return {
      result: json(variantRecord(updated)),
      event: { type: "media.variant.failed", payload: { variantId: payload.variantId, reason: payload.reason } },
    };
  },
};

export const imageHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  "media.asset.upload": uploadAssetHandler,
  "media.variant.generate": generateVariantHandler,
  "media.variant.approve": approveVariantHandler,
  "media.variant.stage": stageVariantHandler,
  "media.variant.fail": failVariantHandler,
});
