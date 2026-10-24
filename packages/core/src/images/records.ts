// Image rows as records (image-port.md IM-1). Runs as the runtime role inside ScopedDatabase.tenant:
// RLS limits every read to the tenant.
import type { ImageAdapter, ImageFailureReason, ImagePreset, ImageStatus, ImageVariant, MediaAsset, MediaContentType } from "@zs/contracts";
import type { Transaction } from "@zs/db";

export interface AssetRow {
  id: string;
  sha256: string;
  content_type: MediaContentType;
  byte_length: number;
  width: number;
  height: number;
  origin: "upload" | "variant";
  variant_id: string | null;
  created_by: string;
  created_at: Date;
}
export const assetColumns = "id, sha256, content_type, byte_length, width, height, origin, variant_id, created_by, created_at";

export const assetRecord = (row: AssetRow): MediaAsset => ({
  id: row.id, sha256: row.sha256, contentType: row.content_type, byteLength: row.byte_length, width: row.width,
  height: row.height, origin: row.origin, variantId: row.variant_id, createdBy: row.created_by, createdAt: row.created_at.toISOString(),
});

export interface VariantRow {
  id: string;
  source_asset_id: string;
  source_sha256: string;
  preset: ImagePreset;
  params: Record<string, unknown>;
  status: ImageStatus;
  failure_reason: ImageFailureReason | null;
  sha256: string | null;
  matte_sha256: string | null;
  background_sha256: string | null;
  adapter: ImageAdapter | null;
  model_id: string | null;
  model_license: string | null;
  workflow_hash: string | null;
  prompt_text: string | null;
  provider_job_id: string | null;
  price_minor: number;
  currency: string;
  vendor_cost_micros: string | null;
  created_by: string;
  created_at: Date;
  staged_at: Date | null;
  expires_at: Date | null;
  approved_at: Date | null;
  promoted_at: Date | null;
}
export const variantColumns =
  `id, source_asset_id, source_sha256, preset, params, status, failure_reason, sha256, matte_sha256, background_sha256,
   adapter, model_id, model_license, workflow_hash, prompt_text, provider_job_id, price_minor, currency,
   vendor_cost_micros::text AS vendor_cost_micros, created_by, created_at, staged_at, expires_at, approved_at, promoted_at`;

const iso = (value: Date | null) => value?.toISOString() ?? null;

export const variantRecord = (row: VariantRow): ImageVariant => ({
  id: row.id, sourceAssetId: row.source_asset_id, sourceSha256: row.source_sha256, preset: row.preset, params: row.params,
  status: row.status, failureReason: row.failure_reason, sha256: row.sha256, matteSha256: row.matte_sha256,
  backgroundSha256: row.background_sha256, adapter: row.adapter, modelId: row.model_id, modelLicense: row.model_license,
  workflowHash: row.workflow_hash, promptText: row.prompt_text, providerJobId: row.provider_job_id,
  priceMinor: row.price_minor, currency: row.currency,
  vendorCostMicros: row.vendor_cost_micros === null ? null : Number(row.vendor_cost_micros),
  createdBy: row.created_by, createdAt: row.created_at.toISOString(), stagedAt: iso(row.staged_at),
  expiresAt: iso(row.expires_at), approvedAt: iso(row.approved_at), promotedAt: iso(row.promoted_at),
});

export async function findVariant(tx: Transaction, tenantId: string, id: string, lock = false): Promise<VariantRow | null> {
  return (await tx.query<VariantRow>(
    `SELECT ${variantColumns} FROM image_variants WHERE tenant_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`, [tenantId, id])).rows[0] ?? null;
}

export async function listVariants(tx: Transaction, tenantId: string): Promise<ImageVariant[]> {
  return (await tx.query<VariantRow>(
    `SELECT ${variantColumns} FROM image_variants WHERE tenant_id=$1 ORDER BY created_at DESC, id LIMIT 200`, [tenantId])).rows.map(variantRecord);
}

export async function listAssets(tx: Transaction, tenantId: string): Promise<MediaAsset[]> {
  return (await tx.query<AssetRow>(
    `SELECT ${assetColumns} FROM media_assets WHERE tenant_id=$1 ORDER BY created_at DESC, id LIMIT 200`, [tenantId])).rows.map(assetRecord);
}
