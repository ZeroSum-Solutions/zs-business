// The site methods behind `/v1/sites` (members) and `/automation/v1/sites` (tokens, hub-access.md
// H-15). One implementation, two callers: each passes how it checks its caller. A member session
// checks membership and the `publish` permission; a token adapter locks the token row, checks
// `sites:publish` and the token's allowlist. Nothing else differs, so a change here is a change for both.
import {
  activateSiteReleaseRequestSchema,
  publishSiteRequestSchema,
  sha256HexSchema,
  siteFilesSchema,
  sitePathSchema,
  SITE_PREVIEW_HTML_BYTES,
  uuidSchema,
  Conflict,
  NotFound,
  type ActionCommand,
  type ActionResult,
  type SiteBlob,
  type SiteEdgeStatus,
  type PublishSiteRequest,
  type SitePreview,
  type SiteReleaseList,
  type SiteReleaseResponse,
  type SiteSyncResponse,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { assertSitePublishRoom } from "../billing/plan-gate.js";
import { assertImagesApproved } from "../images/gate.js";
import {
  activateSiteRelease, createBlobReader, getRelease, getSite, listReleases, publishSiteRelease, putSiteBlob,
  storeReleaseFiles, syncSiteEdge, verifyCompiledSite, type ProjectOptions, type VerifiedRelease,
} from "../sites/index.js";
import { SiteStoreUnavailable } from "./errors.js";
import { derivedId } from "./ids.js";
import { parseInput, type EdgeDependencies } from "./session.js";

/** The edge projection's default time, and the time kept back to send the answer. */
const SITE_SYNC_TIMEOUT_MS = 5_000;
const SITE_SYNC_MARGIN_MS = 1_000;

/** `work`'s status, or `pending` once `ms` pass. The projection may finish later; it is safe to. */
function withinBudget(work: Promise<SiteEdgeStatus>, ms: number): Promise<SiteEdgeStatus> {
  if (ms <= 0) return Promise.resolve("pending");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<SiteEdgeStatus>((resolve) => { timer = setTimeout(() => resolve("pending"), ms); });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/**
 * The entry, digest and files an earlier publish with this key recorded, or null when the key belongs to
 * something else (then the request compiles and dispatch refuses the reused key).
 */
function recordedRelease(earlier: { action_type: string; payload: unknown }, siteId: string): VerifiedRelease | null {
  const payload = earlier.payload as { siteId?: unknown; entry?: unknown; digest?: unknown; files?: unknown };
  if (earlier.action_type !== "site.release.publish" || payload.siteId !== siteId) return null;
  const entry = sitePathSchema.safeParse(payload.entry);
  const digest = sha256HexSchema.safeParse(payload.digest);
  const files = siteFilesSchema.safeParse(payload.files);
  return entry.success && digest.success && files.success ? { entry: entry.data, digest: digest.data, files: files.data, bytes: new Map() } : null;
}

type BodySchema = Parameters<typeof parseInput<PublishSiteRequest>>[0];

/** What a caller must supply: its checks, and how its idempotency key becomes an action envelope. */
export interface SiteMethodsHost {
  readonly deps: Pick<EdgeDependencies, "clock" | "db" | "sites" | "timeLeft">;
  readonly tenantId: string;
  /** A tenant transaction in which the caller has been checked for this site, then `work`. */
  readonly read: <T>(siteId: string, work: (tx: Transaction) => Promise<T>) => Promise<T>;
  /** Writes: dispatch through the caller's own `Authorize` (it runs inside the action's transaction). */
  readonly dispatch: (command: ActionCommand) => Promise<ActionResult>;
  /** The same check inside the edge projection's read, so a caller who lost access mid-request projects nothing. */
  readonly syncAuthorize: (siteId: string) => (tx: Transaction) => Promise<void>;
  /** Target, approval reference and idempotency key for a write to `siteId`; throws on a bad key. */
  readonly envelope: (rawKey: unknown, siteId: string) => {
    readonly target: { readonly tenantId: string; readonly type: "site"; readonly id: string };
    readonly approvalReference: { readonly tenantId: string; readonly id: string };
    readonly idempotencyKey: string;
  };
}

export function createSiteMethods(host: SiteMethodsHost) {
  const { deps, tenantId, read } = host;

  /** Sites are off without a store: every site route is then unknown. */
  const requireSites = () => {
    if (!deps.sites) throw new NotFound();
    return deps.sites;
  };
  /**
   * Project committed state to the edge, re-checking the caller in that read. It gets its own
   * time, short of the request's deadline: past it the answer is `pending`, and the request
   * still answers before its deadline would turn a committed write into a 503.
   */
  const syncSite = (sites: NonNullable<EdgeDependencies["sites"]>, siteId: string, options?: ProjectOptions) => {
    const budget = Math.min(sites.syncTimeoutMs ?? SITE_SYNC_TIMEOUT_MS, (deps.timeLeft?.() ?? Infinity) - SITE_SYNC_MARGIN_MS);
    if (budget <= 0) return Promise.resolve<SiteEdgeStatus>("pending");
    const work = syncSiteEdge(deps.db, sites.store, tenantId, siteId, host.syncAuthorize(siteId), options);
    work.catch(() => undefined);
    return withinBudget(work, budget);
  };
  /** After a committed write the answer is that write's result: a failed projection is only `pending`. */
  const syncAfterWrite = (sites: NonNullable<EdgeDependencies["sites"]>, siteId: string, options?: ProjectOptions) =>
    syncSite(sites, siteId, options).catch(() => "pending" as const);

  return {
    requireSites,
    getSite: (siteId: unknown) => {
      requireSites();
      const id = parseInput(uuidSchema, siteId, "site ID");
      return read(id, (tx) => getSite(tx, tenantId, id));
    },
    listSiteReleases: async (siteId: unknown): Promise<SiteReleaseList> => {
      requireSites();
      const id = parseInput(uuidSchema, siteId, "site ID");
      return { items: await read(id, (tx) => listReleases(tx, tenantId, id)) };
    },
    getSiteRelease: (siteId: unknown, releaseId: unknown) => {
      requireSites();
      const id = parseInput(uuidSchema, siteId, "site ID");
      const release = parseInput(uuidSchema, releaseId, "release ID");
      return read(id, (tx) => getRelease(tx, tenantId, id, release));
    },
    /**
     * Compile the spec, store its files, record the release and make it live, then move the
     * edge. Retried with its key, it compiles nothing and reads no blob: the files come from the
     * action it recorded, and the dispatcher replays the recorded result (or refuses a changed
     * request as a reused key), so a retry after a lost answer works during a store outage.
     */
    async publishSite(siteId: unknown, body: unknown, key: unknown, bodySchema: BodySchema = publishSiteRequestSchema): Promise<SiteReleaseResponse> {
      const sites = requireSites();
      const id = parseInput(uuidSchema, siteId, "site ID");
      const request = parseInput(bodySchema, body);
      const rest = host.envelope(key, id);
      // Permission and ownership first, so nobody else's request stores bytes under this tenant.
      const recorded = await read(id, async (tx) => {
        const site = await getSite(tx, tenantId, id);
        const earlier = (await tx.query<{ action_type: string; payload: unknown }>(
          "SELECT action_type, payload FROM actions WHERE tenant_id=$1 AND idempotency_key=$2", [tenantId, rest.idempotencyKey])).rows[0];
        // Fail a stale edit before compiling and storing; the handler checks again under the site lock.
        if (!earlier && request.expectedCurrentReleaseId !== undefined && site.currentReleaseId !== request.expectedCurrentReleaseId)
          throw new Conflict("Another release went live since this edit started", { reason: "stale_release" });
        // PL-25: a tenant past its daily publish number stores nothing; the plan gate checks again under the plan lock.
        if (!earlier) await assertSitePublishRoom(tx, tenantId, new Date(deps.clock.now().getTime()));
        return earlier === undefined ? null : recordedRelease(earlier, id);
      });
      // A key that already recorded a publish of this site keeps the release it recorded. It is put through
      // dispatch with the request's own spec, so a different spec is still refused as a reused key.
      const release = recorded ?? await verifyCompiledSite(await sites.compiler.compile(request.spec, { blobs: createBlobReader(sites.store, tenantId) }));
      // image-port.md IM-14: no unapproved image is stored; the handler checks again under the site lock.
      if (!recorded) await read(id, (tx) => assertImagesApproved(tx, tenantId, release.files));
      // A recorded key replays (or is refused as reused) in dispatch; its files were stored then.
      const verifiedBlobs = recorded ? undefined : await storeReleaseFiles(sites.store, tenantId, release).catch((cause: unknown) => {
        throw new SiteStoreUnavailable({ cause });
      });
      const output = await publishSiteRelease({
        actionType: "site.release.publish", ...rest,
        payload: {
          siteId: id, releaseId: derivedId(tenantId, rest.idempotencyKey, "site_release"), spec: request.spec,
          entry: release.entry, digest: release.digest, files: [...release.files],
          // Only when sent: a payload without the key still matches what older keys recorded.
          ...(request.expectedCurrentReleaseId !== undefined ? { expectedCurrentReleaseId: request.expectedCurrentReleaseId } : {}),
        },
      }, { dispatch: host.dispatch });
      return { ...output, edge: await syncAfterWrite(sites, id, verifiedBlobs ? { verifiedBlobs } : {}) };
    },
    /** Compile without storing or recording anything: what a publish of this spec would serve. */
    async previewSite(siteId: unknown, body: unknown, bodySchema: BodySchema = publishSiteRequestSchema): Promise<SitePreview> {
      const sites = requireSites();
      const id = parseInput(uuidSchema, siteId, "site ID");
      const request = parseInput(bodySchema, body);
      await read(id, (tx) => getSite(tx, tenantId, id));
      const release = await verifyCompiledSite(await sites.compiler.compile(request.spec, { blobs: createBlobReader(sites.store, tenantId) }));
      const entry = release.files.find((file) => file.path === release.entry)!;
      const html = entry.mediaType.startsWith("text/html") && entry.bytes <= SITE_PREVIEW_HTML_BYTES
        ? new TextDecoder("utf-8", { fatal: false }).decode(release.bytes.get(entry.path)) : null;
      return { entry: release.entry, digest: release.digest, files: [...release.files], entryHtml: html };
    },
    /**
     * H-16: store a picture ahead of a release, content-addressed under the caller's tenant. The caller is
     * checked for this site first, so nobody else's request stores bytes under this tenant; the bytes are
     * checked against the path before the store is touched.
     */
    async putSiteBlob(siteId: unknown, sha256: unknown, bytes: Uint8Array): Promise<SiteBlob> {
      const sites = requireSites();
      const id = parseInput(uuidSchema, siteId, "site ID");
      await read(id, (tx) => getSite(tx, tenantId, id));
      return putSiteBlob(sites.store, tenantId, sha256, bytes);
    },
    /** Make an earlier (or later) release live again: the rollback. */
    async activateSiteRelease(siteId: unknown, releaseId: unknown, body: unknown, key: unknown): Promise<SiteReleaseResponse> {
      const sites = requireSites();
      const id = parseInput(uuidSchema, siteId, "site ID");
      const release = parseInput(uuidSchema, releaseId, "release ID");
      const request = parseInput(activateSiteReleaseRequestSchema, body);
      const rest = host.envelope(key, id);
      const output = await activateSiteRelease({
        actionType: "site.release.activate", ...rest,
        payload: { siteId: id, releaseId: release, expectedCurrentReleaseId: request.expectedCurrentReleaseId },
      }, { dispatch: host.dispatch });
      return { ...output, edge: await syncAfterWrite(sites, id) };
    },
    /** Retry the edge projection after a `pending` answer. */
    async syncSite(siteId: unknown): Promise<SiteSyncResponse> {
      const sites = requireSites();
      const id = parseInput(uuidSchema, siteId, "site ID");
      const site = await read(id, (tx) => getSite(tx, tenantId, id));
      return { site, edge: await syncSite(sites, id) };
    },
  };
}
export type SiteMethods = ReturnType<typeof createSiteMethods>;
