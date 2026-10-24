import { z } from "zod";
import { actionCommandSchema, actionResultSchema, targetSchema, uuidSchema } from "./index.js";
import { isPostgresText } from "./json.js";
import { SITE_LIMITS, sha256HexSchema } from "./sites.js";

// Image port (docs/requirements/image-port.md IM-1..IM-16). Root re-exports this module, so
// shared root schemas are reached lazily, as in business.ts and approvals.ts.
const idSchema = z.lazy(() => uuidSchema);
const instantSchema = z.iso.datetime({ precision: 3 });

/** IM-3: what an upload may be. The byte limit is a site file's. */
export const MEDIA_LIMITS = Object.freeze({
  fileBytes: SITE_LIMITS.fileBytes,
  maxSide: 8192,
  maxPixels: 40_000_000,
  /** IM-11: a staged variant waits this long for an approval. */
  stagingDays: 14,
});
export const MEDIA_CONTENT_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp"] as const);
export const mediaContentTypeSchema = z.enum(MEDIA_CONTENT_TYPES);
export type MediaContentType = z.infer<typeof mediaContentTypeSchema>;

/** IM-4: the fixed presets. A caller picks one; it never names a model or a workflow. */
export const IMAGE_PRESETS = Object.freeze(["background_remove", "studio_background_swap", "upscale_2k"] as const);
export const imagePresetSchema = z.enum(IMAGE_PRESETS);
export type ImagePreset = z.infer<typeof imagePresetSchema>;

/** IM-2 */
export const IMAGE_STATUSES = Object.freeze(["queued", "running", "staged", "approved", "promoted", "failed", "expired"] as const);
export const imageStatusSchema = z.enum(IMAGE_STATUSES);
export type ImageStatus = z.infer<typeof imageStatusSchema>;

/** IM-2, IM-5, IM-7..IM-9: why a variant failed. */
export const IMAGE_FAILURE_REASONS = Object.freeze([
  "model_not_allowed", "insufficient_funds", "adapter_error", "digest_mismatch", "matte_invalid",
  "product_pixels_changed", "size_changed", "outcome_unknown", "source_undecodable", "output_invalid",
] as const);
export const imageFailureReasonSchema = z.enum(IMAGE_FAILURE_REASONS);
export type ImageFailureReason = z.infer<typeof imageFailureReasonSchema>;

export const IMAGE_ADAPTERS = Object.freeze(["kie", "fal", "higgsfield", "comfyui", "fake"] as const);
export const imageAdapterSchema = z.enum(IMAGE_ADAPTERS);
export type ImageAdapter = z.infer<typeof imageAdapterSchema>;

/**
 * Object keys. Every key starts with the server-derived tenant, never with a request value.
 * Assets are what a site may publish; staging holds a finished variant until an owner approves it;
 * the matte and the generated background of a job sit beside it (IM-9, IM-11).
 */
export const mediaObjectKeys = Object.freeze({
  asset: (tenantId: string, sha256: string) => `t/${tenantId}/media/assets/${sha256}`,
  staging: (tenantId: string, variantId: string, sha256: string) => `t/${tenantId}/media/staging/${variantId}/${sha256}`,
  matte: (tenantId: string, variantId: string, sha256: string) => `t/${tenantId}/media/work/${variantId}/matte/${sha256}`,
  background: (tenantId: string, variantId: string, sha256: string) => `t/${tenantId}/media/work/${variantId}/background/${sha256}`,
  stagingPrefix: (tenantId: string, variantId: string) => `t/${tenantId}/media/staging/${variantId}/`,
});

/** IM-4: an aspect ratio from a fixed list. Only `source` is built: other ratios would move the product. */
export const ASPECT_RATIOS = Object.freeze(["source", "1:1", "4:5", "3:2", "16:9"] as const);
const aspectRatioSchema = z.enum(ASPECT_RATIOS).default("source").refine(
  (ratio) => ratio === "source", "Only the source aspect ratio is available yet");

/** IM-4: strict per-preset params; an unknown field (a model, a node, a weights file) is refused. */
export const backgroundRemoveParamsSchema = z.strictObject({ aspectRatio: aspectRatioSchema });
export const studioBackgroundSwapParamsSchema = z.strictObject({
  aspectRatio: aspectRatioSchema,
  backgroundDescription: z.string().min(1).max(300).refine(isPostgresText, "Text is not valid in Postgres")
    .refine((text) => text.trim().length > 0, "Describe the background"),
});
export const upscale2kParamsSchema = z.strictObject({ aspectRatio: aspectRatioSchema });
export const imageParamsSchemas = Object.freeze({
  background_remove: backgroundRemoveParamsSchema,
  studio_background_swap: studioBackgroundSwapParamsSchema,
  upscale_2k: upscale2kParamsSchema,
});
export type ImageParams = z.infer<typeof backgroundRemoveParamsSchema> | z.infer<typeof studioBackgroundSwapParamsSchema> | z.infer<typeof upscale2kParamsSchema>;

/** IM-4: `{variantId, sourceAssetId, preset, params}`, params checked against the preset. */
export const generateVariantInputSchema = z.strictObject({
  variantId: idSchema,
  sourceAssetId: idSchema,
  preset: imagePresetSchema,
  params: z.record(z.string(), z.unknown()),
}).superRefine((input, ctx) => {
  const parsed = imageParamsSchemas[input.preset].safeParse(input.params);
  if (!parsed.success)
    for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", path: ["params", ...issue.path], message: issue.message });
});
/** HTTP and MCP body: the edge mints variantId from the idempotency key; params defaults are filled in. */
export const generateVariantRequestSchema = z.strictObject({
  sourceAssetId: idSchema,
  preset: imagePresetSchema,
  params: z.record(z.string(), z.unknown()).default({}),
}).transform((request, ctx) => {
  const parsed = imageParamsSchemas[request.preset].safeParse(request.params);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", path: ["params", ...issue.path], message: issue.message });
    return z.NEVER;
  }
  return { sourceAssetId: request.sourceAssetId, preset: request.preset, params: parsed.data as Record<string, string> };
});
export type GenerateVariantRequest = z.input<typeof generateVariantRequestSchema>;

export const MEDIA_ASSET_TARGET = "media_asset";
export const MEDIA_VARIANT_TARGET = "media_variant";

/** IM-3 */
export const uploadAssetInputSchema = z.strictObject({
  assetId: idSchema,
  sha256: sha256HexSchema,
  contentType: mediaContentTypeSchema,
  byteLength: z.number().int().min(1).max(MEDIA_LIMITS.fileBytes),
  width: z.number().int().min(1).max(MEDIA_LIMITS.maxSide),
  height: z.number().int().min(1).max(MEDIA_LIMITS.maxSide),
}).refine((input) => input.width * input.height <= MEDIA_LIMITS.maxPixels, "Too many pixels");
export const uploadAssetCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("media.asset.upload"),
  target: targetSchema.extend({ type: z.literal(MEDIA_ASSET_TARGET) }),
  payload: uploadAssetInputSchema,
}).refine((command) => command.target.id === command.payload.assetId, "Target must equal the asset ID"));

export const generateVariantCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("media.variant.generate"),
  target: targetSchema.extend({ type: z.literal(MEDIA_VARIANT_TARGET) }),
  payload: generateVariantInputSchema,
}).refine((command) => command.target.id === command.payload.variantId, "Target must equal the variant ID"));

/** IM-12 */
export const approveVariantInputSchema = z.strictObject({ variantId: idSchema, sha256: sha256HexSchema });
export const approveVariantCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("media.variant.approve"),
  target: targetSchema.extend({ type: z.literal(MEDIA_VARIANT_TARGET) }),
  payload: approveVariantInputSchema,
}).refine((command) => command.target.id === command.payload.variantId, "Target must equal the variant ID"));

/** IM-10, IM-15: the worker principal's two actions. Provenance is written once, here. */
const textField = (max: number) => z.string().min(1).max(max).refine(isPostgresText, "Text is not valid in Postgres");
export const stageVariantInputSchema = z.strictObject({
  variantId: idSchema,
  sha256: sha256HexSchema,
  matteSha256: sha256HexSchema.nullable(),
  backgroundSha256: sha256HexSchema.nullable(),
  adapter: imageAdapterSchema,
  modelId: textField(200),
  modelLicense: textField(200),
  workflowHash: textField(200),
  promptText: textField(2000).nullable(),
  providerJobId: textField(200).nullable(),
  vendorCostMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export const stageVariantCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("media.variant.stage"),
  target: targetSchema.extend({ type: z.literal(MEDIA_VARIANT_TARGET) }),
  payload: stageVariantInputSchema,
}).refine((command) => command.target.id === command.payload.variantId, "Target must equal the variant ID"));

export const failVariantInputSchema = z.strictObject({
  variantId: idSchema,
  reason: imageFailureReasonSchema,
  providerJobId: textField(200).nullable(),
});
export const failVariantCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("media.variant.fail"),
  target: targetSchema.extend({ type: z.literal(MEDIA_VARIANT_TARGET) }),
  payload: failVariantInputSchema,
}).refine((command) => command.target.id === command.payload.variantId, "Target must equal the variant ID"));

/** IM-1 */
export const mediaAssetSchema = z.strictObject({
  id: idSchema,
  sha256: sha256HexSchema,
  contentType: mediaContentTypeSchema,
  byteLength: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  origin: z.enum(["upload", "variant"]),
  variantId: idSchema.nullable(),
  createdBy: idSchema,
  createdAt: instantSchema,
});
export type MediaAsset = z.infer<typeof mediaAssetSchema>;
export const mediaAssetOutputSchema = z.lazy(() => actionResultSchema.extend({ result: mediaAssetSchema }));
export type MediaAssetOutput = z.infer<typeof mediaAssetOutputSchema>;

export const imageVariantSchema = z.strictObject({
  id: idSchema,
  sourceAssetId: idSchema,
  sourceSha256: sha256HexSchema,
  preset: imagePresetSchema,
  params: z.record(z.string(), z.unknown()),
  status: imageStatusSchema,
  failureReason: imageFailureReasonSchema.nullable(),
  sha256: sha256HexSchema.nullable(),
  matteSha256: sha256HexSchema.nullable(),
  backgroundSha256: sha256HexSchema.nullable(),
  adapter: imageAdapterSchema.nullable(),
  modelId: z.string().nullable(),
  modelLicense: z.string().nullable(),
  workflowHash: z.string().nullable(),
  promptText: z.string().nullable(),
  providerJobId: z.string().nullable(),
  priceMinor: z.number().int(),
  currency: z.string(),
  vendorCostMicros: z.number().int().nullable(),
  createdBy: idSchema,
  createdAt: instantSchema,
  stagedAt: instantSchema.nullable(),
  expiresAt: instantSchema.nullable(),
  approvedAt: instantSchema.nullable(),
  promotedAt: instantSchema.nullable(),
});
export type ImageVariant = z.infer<typeof imageVariantSchema>;
export const imageVariantOutputSchema = z.lazy(() => actionResultSchema.extend({ result: imageVariantSchema }));
export type ImageVariantOutput = z.infer<typeof imageVariantOutputSchema>;
