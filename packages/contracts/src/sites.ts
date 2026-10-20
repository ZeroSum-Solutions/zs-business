import { z } from "zod";
import { isPostgresText, jsonValueSchema, type JsonValue } from "./json.js";

// M4b site releases. The API compiles a site spec into static files, stores each file once
// under a content-addressed key, and records an immutable release. Activating a release flips
// the site's pointer in one row update; the edge objects below are a projection of that state
// which the dispatch Worker reads. The root module re-exports this one, so shared root schemas
// are not initialized yet here.
const idSchema = z.uuid().toLowerCase();
const instantSchema = z.iso.datetime({ precision: 3 });

export const SITE_LIMITS = Object.freeze({
  files: 500,
  fileBytes: 10 * 1024 * 1024,
  totalBytes: 50 * 1024 * 1024,
  pathLength: 200,
});

/** A file's path inside a release: relative, slash-separated, no empty, `.` or `..` segment. */
export const sitePathSchema = z.string().min(1).max(SITE_LIMITS.pathLength)
  .regex(/^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/, "Relative path of letters, digits and ._~- segments")
  .refine((path) => path.split("/").every((segment) => segment !== "." && segment !== ".."), "No . or .. segments");
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "Lowercase hex SHA-256");
export const siteMediaTypeSchema = z.string().max(100)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(; ?charset=[a-z0-9_-]+)?$/i, "A media type");

/**
 * A site's DNS host name, lowercased, without port or trailing dot. Two labels at least; no IP
 * literals. `.invalid` names exist only as the column default the catalog fixture relies on.
 */
export const siteHostSchema = z.string().trim().toLowerCase().max(253)
  .transform((host) => (host.endsWith(".") ? host.slice(0, -1) : host))
  .pipe(z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/, "A DNS host name"));

export const siteNameSchema = z.string().trim().min(1).max(200).refine(isPostgresText, "Text is not valid in Postgres");

/** What the compiler produced for one path. `bytes` is the byte count. */
export const siteFileSchema = z.strictObject({
  path: sitePathSchema,
  mediaType: siteMediaTypeSchema,
  sha256: sha256HexSchema,
  bytes: z.number().int().min(0).max(SITE_LIMITS.fileBytes),
});
export type SiteFile = z.infer<typeof siteFileSchema>;

export const siteFilesSchema = z.array(siteFileSchema).min(1).max(SITE_LIMITS.files)
  .refine((files) => new Set(files.map((file) => file.path)).size === files.length, "Each path appears once")
  .refine((files) => files.every((file, i) => i === 0 || files[i - 1]!.path < file.path), "Files are sorted by path")
  .refine((files) => files.reduce((sum, file) => sum + file.bytes, 0) <= SITE_LIMITS.totalBytes, "Release is too large");

/** The compiler's input: a JSON object whose shape the compiler defines (a Mish recipe in production). */
export const siteSpecSchema = z.record(z.string(), jsonValueSchema);
export type SiteSpec = Record<string, JsonValue>;

/**
 * The spec of the built-in plain compiler: a one-page site of escaped text. It lets the API
 * publish without the Mish publisher wired in (local runs, tests, a first site).
 */
const plainText = (max: number) => z.string().trim().min(1).max(max).refine(isPostgresText, "Text is not valid in Postgres");
export const plainSiteSpecSchema = z.strictObject({
  kind: z.literal("plain"),
  title: plainText(120),
  tagline: plainText(200).optional(),
  sections: z.array(z.strictObject({ heading: plainText(120), body: plainText(2000) })).max(20).default([]),
});
export type PlainSiteSpec = z.input<typeof plainSiteSpecSchema>;

/** The release digest: SHA-256 over each file's `${path}\0${sha256}\n`, in path order (as @mish/publisher). */
export async function siteReleaseDigest(files: readonly Pick<SiteFile, "path" | "sha256">[]): Promise<string> {
  const text = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.path}\u0000${file.sha256}\n`).join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Actions (one server-side path; the edge mints IDs from the idempotency key).
const siteTarget = z.strictObject({ tenantId: idSchema, type: z.literal("site"), id: idSchema });
const command = <Type extends string, Payload extends z.ZodType>(type: Type, payload: Payload) =>
  z.strictObject({
    actionType: z.literal(type),
    target: siteTarget,
    payload,
    approvalReference: z.strictObject({ tenantId: idSchema, id: idSchema }),
    idempotencyKey: z.string().min(1).max(200).refine(isPostgresText, "Text is not valid in Postgres"),
  });

export const createSiteInputSchema = z.strictObject({ siteId: idSchema, name: siteNameSchema });
export const createSiteCommandSchema = command("site.create", createSiteInputSchema)
  .refine((value) => value.target.id === value.payload.siteId, "Target must equal the pre-minted site ID");
export type CreateSiteCommand = z.infer<typeof createSiteCommandSchema>;

export const publishSiteReleaseInputSchema = z.strictObject({
  siteId: idSchema,
  releaseId: idSchema,
  spec: siteSpecSchema,
  entry: sitePathSchema,
  digest: sha256HexSchema,
  files: siteFilesSchema,
}).refine((value) => value.files.some((file) => file.path === value.entry), "The entry must be one of the files");
export const publishSiteReleaseCommandSchema = command("site.release.publish", publishSiteReleaseInputSchema)
  .refine((value) => value.target.id === value.payload.siteId, "Target must equal the site ID");
export type PublishSiteReleaseCommand = z.infer<typeof publishSiteReleaseCommandSchema>;

/** Point the site at one of its releases: rollback, or roll forward again. */
export const activateSiteReleaseInputSchema = z.strictObject({
  siteId: idSchema,
  releaseId: idSchema,
  /** The release the caller saw as live; another one now live is a stale view (409). */
  expectedCurrentReleaseId: idSchema.nullable(),
});
export const activateSiteReleaseCommandSchema = command("site.release.activate", activateSiteReleaseInputSchema)
  .refine((value) => value.target.id === value.payload.siteId, "Target must equal the site ID");
export type ActivateSiteReleaseCommand = z.infer<typeof activateSiteReleaseCommandSchema>;

// Records.
export const siteRecordSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  /** Live release, or null before the first publish. */
  currentReleaseId: idSchema.nullable(),
  /** Bumps on every activation; the edge never goes back to a lower one. */
  pointerVersion: z.number().int().min(0),
  hosts: z.array(z.string()),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type SiteRecord = z.infer<typeof siteRecordSchema>;

export const siteReleaseRecordSchema = z.strictObject({
  id: idSchema,
  siteId: idSchema,
  entry: z.string(),
  digest: sha256HexSchema,
  fileCount: z.number().int(),
  totalBytes: z.number().int(),
  createdBy: idSchema,
  createdAt: instantSchema,
});
export type SiteReleaseRecord = z.infer<typeof siteReleaseRecordSchema>;

export const siteReleaseDetailSchema = siteReleaseRecordSchema.extend({
  spec: siteSpecSchema,
  files: z.array(siteFileSchema),
});
export type SiteReleaseDetail = z.infer<typeof siteReleaseDetailSchema>;

const actionResult = <Result extends z.ZodType>(result: Result) =>
  z.strictObject({ actionId: idSchema, result });
export const siteOutputSchema = actionResult(siteRecordSchema);
export type SiteOutput = z.infer<typeof siteOutputSchema>;
/** Publish and activate answer with the site as it now stands and the release involved. */
export const siteReleaseOutputSchema = actionResult(z.strictObject({ site: siteRecordSchema, release: siteReleaseRecordSchema }));
export type SiteReleaseOutput = z.infer<typeof siteReleaseOutputSchema>;

/**
 * Whether the edge objects caught up after the commit. `pending`: the database holds the new
 * state but the Worker still serves the previous one; `POST /v1/sites/:id/sync` retries.
 */
export const siteEdgeStatusSchema = z.enum(["synced", "pending"]);
export type SiteEdgeStatus = z.infer<typeof siteEdgeStatusSchema>;
export const siteReleaseResponseSchema = siteReleaseOutputSchema.extend({ edge: siteEdgeStatusSchema });
export type SiteReleaseResponse = z.infer<typeof siteReleaseResponseSchema>;
export const siteSyncResponseSchema = z.strictObject({ site: siteRecordSchema, edge: siteEdgeStatusSchema });
export type SiteSyncResponse = z.infer<typeof siteSyncResponseSchema>;

// HTTP bodies.
export const createSiteRequestSchema = z.strictObject({ name: siteNameSchema });
export type CreateSiteRequest = z.infer<typeof createSiteRequestSchema>;
export const publishSiteRequestSchema = z.strictObject({ spec: siteSpecSchema });
export type PublishSiteRequest = z.infer<typeof publishSiteRequestSchema>;
export const activateSiteReleaseRequestSchema = z.strictObject({ expectedCurrentReleaseId: idSchema.nullable() });
export type ActivateSiteReleaseRequest = z.infer<typeof activateSiteReleaseRequestSchema>;
export const siteListSchema = z.strictObject({ items: z.array(siteRecordSchema) });
export type SiteList = z.infer<typeof siteListSchema>;
export const siteReleaseListSchema = z.strictObject({ items: z.array(siteReleaseRecordSchema) });
export type SiteReleaseList = z.infer<typeof siteReleaseListSchema>;

// Edge objects: written by the API (a projection of committed state), read by the Worker.
export const SITE_OBJECT_FORMAT = 1;

/**
 * One host's live release. The Worker reads it once per request, so a flip is one object write.
 * `assignment` is the host's attach number (`site_hosts.assignment`): a pointer never replaces
 * one with a higher number, so a site that lost the host cannot write it back.
 */
export const siteHostLivePointerSchema = z.strictObject({
  format: z.literal(SITE_OBJECT_FORMAT),
  host: z.string(),
  assignment: z.number().int().min(1),
  tenantId: idSchema,
  siteId: idSchema,
  releaseId: idSchema,
  version: z.number().int().min(1),
});
export type SiteHostLivePointer = z.infer<typeof siteHostLivePointerSchema>;
/** Left where a detached host's pointer was, under the detach's number: the Worker answers 404. */
export const siteHostRetiredPointerSchema = z.strictObject({
  format: z.literal(SITE_OBJECT_FORMAT),
  host: z.string(),
  assignment: z.number().int().min(1),
  retired: z.literal(true),
});
export type SiteHostRetiredPointer = z.infer<typeof siteHostRetiredPointerSchema>;
export const siteHostPointerSchema = z.union([siteHostLivePointerSchema, siteHostRetiredPointerSchema]);
export type SiteHostPointer = z.infer<typeof siteHostPointerSchema>;

/** A release's file table. Immutable once written: a release never changes. */
export const siteReleaseManifestSchema = z.strictObject({
  format: z.literal(SITE_OBJECT_FORMAT),
  tenantId: idSchema,
  siteId: idSchema,
  releaseId: idSchema,
  entry: sitePathSchema,
  digest: sha256HexSchema,
  files: z.array(siteFileSchema),
});
export type SiteReleaseManifest = z.infer<typeof siteReleaseManifestSchema>;

/**
 * Object keys. Every tenant object sits under `t/<tenantId>/`, and the Worker builds file keys
 * from the pointer's tenant and the file's digest, never from a key stored in an object.
 */
export const siteObjectKeys = Object.freeze({
  blob: (tenantId: string, sha256: string) => `t/${tenantId}/blobs/${sha256}`,
  manifest: (tenantId: string, releaseId: string) => `t/${tenantId}/releases/${releaseId}/manifest.json`,
  host: (host: string) => `hosts/${host}`,
});

/** An object read back from the store. `etag` is opaque: compare it, never parse it. */
export interface SiteStoredObject {
  readonly body: Uint8Array;
  readonly contentType: string | null;
  readonly etag: string;
}
export type SitePutCondition = { readonly etagMatches: string } | { readonly absent: true };

/**
 * The R2-shaped store port. R2 (the Worker binding, or its S3 API from the server) and the
 * in-memory fake implement it. `put` with a condition answers null when the condition fails.
 */
export interface SiteObjectStore {
  get(key: string): Promise<SiteStoredObject | null>;
  head(key: string): Promise<{ readonly etag: string; readonly size: number } | null>;
  put(key: string, body: Uint8Array, options: { readonly contentType: string; readonly onlyIf?: SitePutCondition }): Promise<{ readonly etag: string } | null>;
  delete(key: string): Promise<void>;
}
/** All the dispatch Worker needs. */
export type SiteObjectReader = Pick<SiteObjectStore, "get">;
