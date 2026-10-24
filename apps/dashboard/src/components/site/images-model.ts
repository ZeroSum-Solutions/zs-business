// What the Site screen's Images section says about a photo's edits (image-port.md IM-24): one label,
// tone and sentence per status, the failure reasons in plain words, and which actions each allows.
import { imageParamsSchemas, type ImageFailureReason, type ImagePreset, type ImageStatus, type ImageVariant, type MediaAsset } from "@zs/contracts";
import { formatMinor } from "@/lib/utils";

type Tone = "success" | "info" | "warn" | "neutral" | "danger" | "accent";

export interface VariantStatusView {
  label: string;
  tone: Tone;
  /** The worker is still on it: the badge pulses and the list is read again. */
  working: boolean;
  summary: string;
}

export const PRESET_LABELS: Readonly<Record<ImagePreset, string>> = Object.freeze({
  background_remove: "Remove background",
  studio_background_swap: "Studio background",
  upscale_2k: "Enlarge to 2K",
});

export const PRESET_HINTS: Readonly<Record<ImagePreset, string>> = Object.freeze({
  background_remove: "Cuts the item out onto a clear background. The item itself is never changed.",
  studio_background_swap: "Puts the item on a new background you describe. The item itself is never changed.",
  upscale_2k: "Makes the photo 2048 pixels on its long side. Fine details can change, so check them closely.",
});

/** IM-2, IM-5, IM-7..IM-9 in the owner's words. */
export const FAILURE_MESSAGES: Readonly<Record<ImageFailureReason, string>> = Object.freeze({
  model_not_allowed: "This kind of edit is switched off for now.",
  insufficient_funds: "Your balance was too low for this edit. Add funds, then try again.",
  adapter_error: "The image service could not make this edit. Try again, or try another photo.",
  digest_mismatch: "The original photo changed or went missing before the edit ran. Upload it again.",
  matte_invalid: "We could not pick out the item clearly enough. Try a photo with a plainer background.",
  product_pixels_changed: "The edit changed the item itself, so we did not keep it.",
  size_changed: "The edit came back at the wrong size, so we did not keep it.",
  outcome_unknown: "We could not tell whether the image service finished this edit. Support has been told. Start a new edit if you need one now.",
  source_undecodable: "We could not read this photo for that edit. Upload it as a PNG and try again.",
  output_invalid: "The image service sent back a file we could not use, so we did not keep it.",
});

const STATUS: Readonly<Record<Exclude<ImageStatus, "failed">, VariantStatusView>> = Object.freeze({
  queued: { label: "Waiting", tone: "info", working: true, summary: "Waiting for its turn." },
  running: { label: "Working", tone: "info", working: true, summary: "Making your image. This usually takes under a minute." },
  staged: { label: "Ready to review", tone: "warn", working: false, summary: "Compare it with the original, then approve or reject it." },
  approved: { label: "Approved", tone: "success", working: true, summary: "Approved. Adding it to your images." },
  promoted: { label: "Approved", tone: "success", working: false, summary: "In your images, ready to use on your site." },
  expired: { label: "Expired", tone: "neutral", working: false, summary: `Nobody decided within 14 days, so it was removed. Make it again if you still want it.` },
  rejected: { label: "Rejected", tone: "neutral", working: false, summary: "You turned this one down. It will not be used." },
});

export function variantStatus(variant: Pick<ImageVariant, "status" | "failureReason">): VariantStatusView {
  if (variant.status === "failed") {
    return {
      label: "Failed",
      tone: "danger",
      working: false,
      summary: variant.failureReason ? FAILURE_MESSAGES[variant.failureReason] : "This edit could not be made. Try again.",
    };
  }
  return STATUS[variant.status];
}

export interface VariantActions {
  /** Approve and Reject: only a staged variant, named by the digest of its bytes. */
  decide: boolean;
  /** The edited bytes can be read: staged, approved or promoted. */
  showResult: boolean;
  /** Provenance is set once the worker staged it. */
  showProvenance: boolean;
}

export function variantActions(variant: Pick<ImageVariant, "status" | "sha256">): VariantActions {
  const hasBytes = variant.sha256 !== null;
  const shown = variant.status === "staged" || variant.status === "approved" || variant.status === "promoted";
  return {
    decide: variant.status === "staged" && hasBytes,
    showResult: shown && hasBytes,
    showProvenance: hasBytes && variant.status !== "queued" && variant.status !== "running",
  };
}

/** "Fake test adapter" for the test double, the vendor's name otherwise. */
const ADAPTER_NAMES: Readonly<Record<string, string>> = Object.freeze({
  fake: "Test adapter (fake)", kie: "Kie.ai", fal: "fal", higgsfield: "Higgsfield", comfyui: "ComfyUI",
});

export interface ProvenanceRow { term: string; detail: string }

/** Who made the image, with which model and licence, and what it costs (IM-15, IM-24). */
export function provenanceRows(variant: ImageVariant): ProvenanceRow[] {
  const rows: ProvenanceRow[] = [{ term: "Price", detail: formatPrice(variant) }];
  if (variant.adapter) rows.push({ term: "Made with", detail: ADAPTER_NAMES[variant.adapter] ?? variant.adapter });
  if (variant.modelId) rows.push({ term: "Model", detail: variant.modelId });
  if (variant.modelLicense) rows.push({ term: "Licence", detail: variant.modelLicense });
  return rows;
}

export function formatPrice(variant: Pick<ImageVariant, "priceMinor" | "currency">): string {
  return formatMinor(variant.priceMinor, variant.currency.toUpperCase());
}

/** The variant's own background description, for the list. */
export function variantTitle(variant: Pick<ImageVariant, "preset" | "params">): string {
  const description = variant.preset === "studio_background_swap" ? variant.params.backgroundDescription : undefined;
  return typeof description === "string" && description.trim() ? `${PRESET_LABELS[variant.preset]}: ${description.trim()}` : PRESET_LABELS[variant.preset];
}

export const BACKGROUND_MAX = 300;

/** The body to send for a preset, or why it cannot be sent yet. */
export function generateRequest(sourceAssetId: string | null, preset: ImagePreset, backgroundDescription: string):
  { ok: true; request: { sourceAssetId: string; preset: ImagePreset; params: Record<string, string> } } | { ok: false; why: string } {
  if (!sourceAssetId) return { ok: false, why: "Upload or pick a photo first." };
  const params: Record<string, string> = preset === "studio_background_swap"
    ? { aspectRatio: "source", backgroundDescription: backgroundDescription.trim() }
    : { aspectRatio: "source" };
  if (preset === "studio_background_swap") {
    if (!params.backgroundDescription) return { ok: false, why: "Describe the background first." };
    if (params.backgroundDescription.length > BACKGROUND_MAX) return { ok: false, why: `Keep the background description to ${BACKGROUND_MAX} characters.` };
  }
  const parsed = imageParamsSchemas[preset].safeParse(params);
  if (!parsed.success) return { ok: false, why: "This description cannot be used. Try other words." };
  return { ok: true, request: { sourceAssetId, preset, params } };
}

/** The edits of one photo, newest first. */
export function variantsOf(variants: readonly ImageVariant[] | undefined, assetId: string | null): ImageVariant[] {
  if (!variants || !assetId) return [];
  return variants.filter((variant) => variant.sourceAssetId === assetId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Photos the owner uploaded, newest first; edits that went into the library stay with their variant. */
export function uploadedPhotos(assets: readonly MediaAsset[] | undefined): MediaAsset[] {
  return (assets ?? []).filter((asset) => asset.origin === "upload").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The photo to show: the one picked if it is still listed, else the newest. */
export function pickedPhoto(photos: readonly MediaAsset[], picked: string | null): string | null {
  return photos.find((photo) => photo.id === picked)?.id ?? photos[0]?.id ?? null;
}

export const ACCEPTED_TYPES = "image/png,image/jpeg,image/webp";
