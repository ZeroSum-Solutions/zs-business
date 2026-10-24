"use client";

import { Check, MagicWand, UploadSimple, X } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { imageVariantSchema, IMAGE_PRESETS, MEDIA_CONTENT_TYPES, MEDIA_LIMITS, type ImagePreset, type ImageVariant, type MediaAsset } from "@zs/contracts";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, TrayHeader, TrayTitle } from "@/components/ui/card";
import { Label, Select, Textarea } from "@/components/ui/input";
import { DisabledReason } from "@/components/ui/sample";
import { EmptyState, ErrorNote, LoadingRows, Skeleton } from "@/components/ui/states";
import { useClearToasts, useToast } from "@/components/ui/toast";
import { isApiError } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { isDefinitive, useIntentKey } from "@/lib/intent-key";
import { useImageUrl, useImageVariants, useKeys, useMediaAssets } from "@/lib/queries";
import { cn, relativeTime } from "@/lib/utils";
import {
  ACCEPTED_TYPES,
  BACKGROUND_MAX,
  generateRequest,
  pickedPhoto,
  PRESET_HINTS,
  PRESET_LABELS,
  provenanceRows,
  uploadedPhotos,
  variantActions,
  variantStatus,
  variantsOf,
  variantTitle,
} from "./images-model";
import { singleFlight } from "./site-status";

/** Image toasts share a topic: each new answer replaces the last. */
const IMAGES = { topic: "images" };

/** A checkerboard from the tray tokens, so a cut-out's clear background shows as clear. */
const CLEAR_BACKDROP = "bg-[repeating-conic-gradient(var(--tray)_0%_25%,var(--surface)_0%_50%)] bg-[length:16px_16px]";

function ImageView({ kind, id, alt, size, className }: {
  kind: "asset" | "variant";
  id: string;
  alt: string;
  size: { width: number; height: number };
  className?: string;
}) {
  const image = useImageUrl(kind, id);
  const ratio = { aspectRatio: `${size.width} / ${size.height}` };
  if (image.isError) {
    return <div style={ratio} className={cn("flex items-center justify-center rounded-sm bg-inset p-2 text-center text-xs text-muted", className)}>Could not load this image.</div>;
  }
  if (!image.url) return <div style={ratio} className={cn("w-full", className)}><Skeleton className="h-full w-full rounded-sm" /></div>;
  // eslint-disable-next-line @next/next/no-img-element -- a blob: URL of bytes this page read; next/image cannot serve it.
  return <img src={image.url} alt={alt} style={ratio} className={cn("w-full rounded-sm object-contain", CLEAR_BACKDROP, className)} />;
}

const fileIntent = (file: File) => ({ name: file.name, size: file.size, type: file.type, lastModified: file.lastModified });

function localFileProblem(file: File): string | null {
  if (!MEDIA_CONTENT_TYPES.some((type) => type === file.type)) return "Upload a PNG, JPEG or WebP photo.";
  if (file.size > MEDIA_LIMITS.fileBytes) return "That photo is too large. Upload one under 10 MB.";
  if (file.size === 0) return "That file is empty.";
  return null;
}

function UploadButton({ onUploaded }: { onUploaded: (asset: MediaAsset) => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const intents = useIntentKey();
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadMediaAsset(file, { idempotencyKey: intents.keyFor(fileIntent(file)) }),
    onSettled: (_asset, error, file) => {
      intents.settle(fileIntent(file), error);
      void queryClient.invalidateQueries({ queryKey: keys.mediaAssets });
    },
    onSuccess: (asset) => {
      queryClient.setQueryData<MediaAsset[]>(keys.mediaAssets, (list) => (list && !list.some((item) => item.id === asset.id) ? [asset, ...list] : list));
      onUploaded(asset);
      toast("Photo uploaded. Pick an edit for it below.", "success", IMAGES);
    },
  });
  return (
    <div className="space-y-2">
      {/* Hidden: the button below opens it, so the page has one control with a visible label. */}
      <input ref={input} type="file" accept={ACCEPTED_TYPES} hidden aria-label="Photo to upload" data-testid="image-upload-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          const why = localFileProblem(file);
          setProblem(why);
          if (!why) upload.mutate(file);
        }} />
      <Button variant="secondary" disabled={upload.isPending} aria-busy={upload.isPending} onClick={() => input.current?.click()}>
        <UploadSimple aria-hidden />{upload.isPending ? "Uploading" : "Upload a photo"}
      </Button>
      {problem ? <ErrorNote error={null} message={problem} /> : upload.isError ? <ErrorNote error={upload.error} /> : null}
    </div>
  );
}

function PhotoPicker({ photos, picked, onPick }: { photos: MediaAsset[]; picked: string | null; onPick: (id: string) => void }) {
  return (
    <div role="group" aria-label="Your photos" className="flex flex-wrap gap-2">
      {photos.map((photo, index) => (
        <button key={photo.id} type="button" aria-pressed={photo.id === picked} onClick={() => onPick(photo.id)} data-testid="image-photo"
          className={cn("press w-20 rounded-md p-1 transition-quick", photo.id === picked ? "bg-accent-tint shadow-[inset_0_0_0_2px_var(--accent)]" : "bg-surface shadow-[inset_0_0_0_1px_var(--border-strong)] hover:bg-inset")}>
          <ImageView kind="asset" id={photo.id} alt="" size={photo} />
          <span className="sr-only">Photo {photos.length - index}, uploaded {relativeTime(photo.createdAt).toLowerCase()}</span>
        </button>
      ))}
    </div>
  );
}

function GenerateForm({ photo }: { photo: MediaAsset | null }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const intents = useIntentKey();
  const [preset, setPreset] = useState<ImagePreset>("background_remove");
  const [background, setBackground] = useState("");
  const checked = generateRequest(photo?.id ?? null, preset, background);
  const generate = useMutation({
    mutationFn: (request: { sourceAssetId: string; preset: ImagePreset; params: Record<string, string> }) =>
      api.generateImageVariant(request, { idempotencyKey: intents.keyFor(request) }),
    onSettled: (_variant, error, request) => {
      intents.settle(request, error);
      void queryClient.invalidateQueries({ queryKey: keys.imageVariants });
    },
    onSuccess: (variant) => {
      queryClient.setQueryData<ImageVariant[]>(keys.imageVariants, (list) => (list && !list.some((item) => item.id === variant.id) ? [variant, ...list] : list));
      toast("Making your image. It shows below when it is ready to review.", "info", IMAGES);
    },
  });
  const swap = preset === "studio_background_swap";
  const over = background.trim().length > BACKGROUND_MAX;
  const why = checked.ok ? null : checked.why;
  return (
    <form className="space-y-3" aria-label="Make an edited image"
      onSubmit={(event) => { event.preventDefault(); if (checked.ok && !generate.isPending) generate.mutate(checked.request); }}>
      <div>
        <Label htmlFor="image-preset">Edit</Label>
        <Select id="image-preset" className="w-full sm:w-auto" value={preset} aria-describedby="image-preset-hint"
          onChange={(event) => setPreset(event.target.value as ImagePreset)}>
          {IMAGE_PRESETS.map((value) => <option key={value} value={value}>{PRESET_LABELS[value]}</option>)}
        </Select>
        <p id="image-preset-hint" className="mt-1.5 text-xs text-muted">{PRESET_HINTS[preset]}</p>
      </div>
      {swap ? (
        <div>
          <Label htmlFor="image-background">Describe the background</Label>
          <Textarea id="image-background" value={background} placeholder="White marble with soft morning light"
            aria-invalid={over || undefined} aria-describedby="image-background-count" onChange={(event) => setBackground(event.target.value)} />
          <p id="image-background-count" className={cn("mt-1 text-xs", over ? "text-danger" : "text-muted")}>{background.trim().length} of {BACKGROUND_MAX} characters</p>
        </div>
      ) : null}
      {why ? <DisabledReason id="image-generate-why">{why}</DisabledReason> : null}
      <Button type="submit" disabled={!checked.ok || generate.isPending} aria-busy={generate.isPending} aria-describedby={why ? "image-generate-why" : undefined}>
        <MagicWand aria-hidden />{generate.isPending ? "Starting" : "Make image"}
      </Button>
      {generate.isError ? <ErrorNote error={generate.error} /> : null}
    </form>
  );
}

function VariantCard({ variant, source }: { variant: ImageVariant; source: MediaAsset }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const clearToasts = useClearToasts();
  const intents = useIntentKey();
  const [flight] = useState(singleFlight);
  const status = variantStatus(variant);
  const actions = variantActions(variant);
  const title = variantTitle(variant);
  const decision = { variantId: variant.id, sha256: variant.sha256 ?? "" };
  // After Approve or Reject the buttons go, so focus moves to the edit's title rather than the page body.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusTitle = () => requestAnimationFrame(() => headingRef.current?.focus());
  // "Making your image" is out of date once the edit has an answer: clear it, so it never covers the review.
  const wasWorking = useRef(variant.status === "queued" || variant.status === "running");
  useEffect(() => {
    const working = variant.status === "queued" || variant.status === "running";
    if (wasWorking.current && !working) clearToasts(IMAGES.topic);
    wasWorking.current = working;
  }, [variant.status, clearToasts]);
  const put = (next: ImageVariant) =>
    queryClient.setQueryData<ImageVariant[]>(keys.imageVariants, (list) => list?.map((item) => (item.id === next.id ? next : item)));
  const refresh = (error: unknown) => {
    // After a lost answer the outcome is unknown; the next press replays with the same keys.
    if (isDefinitive(error)) void queryClient.invalidateQueries({ queryKey: keys.imageVariants });
  };
  // Approve is one owner action on two routes: ask for the approval, then approve it (IM-12, IM-22).
  // Both keys stay until the whole action has a definitive answer, so a retry replays the same approval.
  const approvalOf = useRef<string | null>(null);
  const approve = useMutation({
    mutationFn: async () => {
      const approval = await api.requestVariantApproval(decision, { idempotencyKey: intents.keyFor(["approval", decision]) });
      approvalOf.current = approval.id;
      return api.approveApproval(approval.id, { idempotencyKey: intents.keyFor(["approve", approval.id]) });
    },
    onSettled: (_answer, error) => {
      intents.settle(["approval", decision], error);
      if (approvalOf.current) intents.settle(["approve", approvalOf.current], error);
      if (isDefinitive(error)) approvalOf.current = null;
      refresh(error);
    },
    onSuccess: (answer) => {
      const executed = imageVariantSchema.safeParse(answer.execution.result);
      if (executed.success) put(executed.data);
      toast("Approved. It is being added to your images.", "success", IMAGES);
      focusTitle();
    },
  });
  const reject = useMutation({
    mutationFn: () => api.rejectImageVariant(decision, { idempotencyKey: intents.keyFor(["reject", decision]) }),
    onSettled: (_variant, error) => {
      intents.settle(["reject", decision], error);
      refresh(error);
    },
    onSuccess: (next) => {
      put(next);
      toast("Rejected. This image will not be used.", "info", IMAGES);
      focusTitle();
    },
  });
  const run = (which: typeof approve | typeof reject) => flight.run((done) => {
    clearToasts(IMAGES.topic);
    approve.reset();
    reject.reset();
    which.mutate(undefined, { onSettled: done });
  });
  const error = approve.isError ? approve.error : reject.isError ? reject.error : null;
  const titleId = `image-variant-${variant.id}`;

  return (
    <Card className="space-y-3" aria-labelledby={titleId} data-status={variant.status}>
      <div className="space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={titleId} ref={headingRef} tabIndex={-1} className="focus-inset min-w-0 flex-1 rounded-sm font-medium break-words">{title}</h3>
          <Badge tone={status.tone} live={status.working} data-testid="image-variant-status">{status.label}</Badge>
        </div>
        <p className="text-xs text-meta">Started {relativeTime(variant.createdAt).toLowerCase()}</p>
      </div>
      <p className="text-sm text-fg-2" data-testid="image-variant-summary">{status.summary}</p>
      {actions.showResult ? (
        <div className="grid grid-cols-2 gap-2 sm:gap-3">
          <figure className="min-w-0 space-y-1">
            <ImageView kind="asset" id={source.id} alt="Original photo" size={source} className="lg:max-h-[360px]" />
            <figcaption className="text-xs text-muted">Original</figcaption>
          </figure>
          <figure className="min-w-0 space-y-1">
            <ImageView kind="variant" id={variant.id} alt={`Edited image: ${title}`} size={source} className="lg:max-h-[360px]" />
            <figcaption className="text-xs text-muted">Edited</figcaption>
          </figure>
        </div>
      ) : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm" data-testid="image-variant-provenance">
        {(actions.showProvenance ? provenanceRows(variant) : provenanceRows(variant).slice(0, 1)).map((row) => (
          <div key={row.term} className="contents">
            <dt className="text-muted">{row.term}</dt>
            <dd className="break-words text-fg">{row.detail}</dd>
          </div>
        ))}
      </dl>
      {actions.decide ? (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="danger-outline" disabled={reject.isPending} aria-busy={reject.isPending} onClick={() => run(reject)}>
            <X aria-hidden />{reject.isPending ? "Rejecting" : "Reject"}<span className="sr-only"> the edit: {title}</span>
          </Button>
          <Button disabled={approve.isPending} aria-busy={approve.isPending} onClick={() => run(approve)}>
            <Check aria-hidden />{approve.isPending ? "Approving" : "Approve"}<span className="sr-only"> the edit: {title}</span>
          </Button>
        </div>
      ) : null}
      {error ? <ErrorNote error={error} /> : null}
    </Card>
  );
}

/** The Site screen's Images section (image-port.md IM-24). Owners only, as the Site screen is. */
export function ImagesSection() {
  const assets = useMediaAssets();
  const variants = useImageVariants();
  const [picked, setPicked] = useState<string | null>(null);
  const photos = uploadedPhotos(assets.data);
  const photoId = pickedPhoto(photos, picked);
  const photo = photos.find((item) => item.id === photoId) ?? null;
  const edits = variantsOf(variants.data, photoId);

  let body;
  if (assets.isPending) body = <LoadingRows rows={2} label="Loading your photos" />;
  else if (assets.isError) {
    body = isApiError(assets.error, "not_found")
      // The API answers 404 for /v1/media until image settings are set (IM-21).
      ? <EmptyState title="Image editing is not switched on yet">It needs to be set up for this business first.</EmptyState>
      : isApiError(assets.error, "forbidden")
        ? <EmptyState title="Owners edit the images">Ask an owner of the business to upload and edit photos.</EmptyState>
        : <ErrorNote error={assets.error} retry={() => assets.refetch()} />;
  } else {
    body = (
      <div className="grid gap-1.5 lg:gap-2">
        <Card className="space-y-4">
          <p className="text-sm text-muted">Upload a product photo, then pick an edit. Nothing goes on your site until you approve it.</p>
          <UploadButton onUploaded={(asset) => setPicked(asset.id)} />
          {photos.length > 0 ? <PhotoPicker photos={photos} picked={photoId} onPick={setPicked} /> : null}
          {photo ? (
            <p className="text-xs text-meta" data-testid="image-photo-picked">
              Editing the photo uploaded {relativeTime(photo.createdAt).toLowerCase()}, {photo.width} by {photo.height} pixels.
            </p>
          ) : null}
          <GenerateForm photo={photo} />
        </Card>
        {variants.isPending ? <LoadingRows rows={2} label="Loading edits" /> : variants.isError ? (
          <ErrorNote error={variants.error} retry={() => variants.refetch()} />
        ) : photo && edits.length > 0 ? (
          <ul aria-label="Edits of this photo" className="grid gap-1.5 lg:gap-2">
            {edits.map((variant) => <li key={variant.id} data-testid="image-variant"><VariantCard variant={variant} source={photo} /></li>)}
          </ul>
        ) : photo ? (
          <p className="card p-4 text-sm text-muted">No edits of this photo yet. Each one you make waits here for you to approve it.</p>
        ) : null}
      </div>
    );
  }

  return (
    <section aria-labelledby="site-images-title" className="tray mt-5" data-testid="site-images">
      <TrayHeader className="px-3 lg:px-4">
        <TrayTitle id="site-images-title">Images</TrayTitle>
      </TrayHeader>
      {body}
    </section>
  );
}
