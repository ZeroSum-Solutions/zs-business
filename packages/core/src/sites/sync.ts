// The edge projection. After a commit, write what the dispatch Worker reads: the live
// release's manifest (immutable, once) and one pointer object per host. Pointers move by
// compare-and-set on the store's etag and are ordered by (host assignment, version): a pointer
// never replaces one with a higher assignment (the host was detached, or given to another site,
// after this sync read the database), nor one of the same assignment at a higher version. So
// two syncs racing, or a slow one finishing late, can never put an older release or an earlier
// owner back.
import {
  SITE_OBJECT_FORMAT,
  siteHostPointerSchema,
  siteObjectKeys,
  type SiteEdgeStatus,
  type SiteFile,
  type SiteHostLivePointer,
  type SiteHostPointer,
  type SiteHostRetiredPointer,
  type SiteObjectStore,
  type SiteReleaseManifest,
} from "@zs/contracts";
import type { ScopedDatabase, Transaction } from "@zs/db";
import type { DetachedHost } from "./hosts.js";
import { parseHost } from "./hosts.js";
import { forEachLimited, STORE_CONCURRENCY } from "./limit.js";
import { loadReleaseFiles } from "./reads.js";

const JSON_TYPE = "application/json";
const encoder = new TextEncoder();
const encodeJson = (value: unknown) => encoder.encode(JSON.stringify(value));

/** Attempts per host pointer before the sync reports `pending`; each one re-reads the object. */
const CAS_ATTEMPTS = 5;

export interface SiteEdgeState {
  readonly tenantId: string;
  readonly siteId: string;
  readonly hosts: readonly { readonly host: string; readonly assignment: number }[];
  readonly live: {
    readonly releaseId: string;
    readonly version: number;
    readonly entry: string;
    readonly digest: string;
    readonly files: readonly SiteFile[];
  } | null;
}

/** What the edge should show for one site, read in one transaction. */
export async function loadSiteEdgeState(tx: Transaction, tenantId: string, siteId: string): Promise<SiteEdgeState> {
  const hosts = (await tx.query<{ host: string; assignment: string }>(
    "SELECT host, assignment FROM site_hosts WHERE tenant_id=$1 AND site_id=$2 ORDER BY host", [tenantId, siteId],
  )).rows.map((row) => ({ host: row.host, assignment: Number(row.assignment) }));
  const pointer = (await tx.query<{ release_id: string; version: string; entry: string; digest: string }>(
    `SELECT p.release_id, p.version, r.entry, r.digest FROM site_pointers p
       JOIN site_releases r ON r.tenant_id=p.tenant_id AND r.id=p.release_id
      WHERE p.tenant_id=$1 AND p.site_id=$2`, [tenantId, siteId],
  )).rows[0];
  if (!pointer) return { tenantId, siteId, hosts, live: null };
  const files = await loadReleaseFiles(tx, tenantId, pointer.release_id);
  return {
    tenantId, siteId, hosts,
    live: { releaseId: pointer.release_id, version: Number(pointer.version), entry: pointer.entry, digest: pointer.digest, files },
  };
}

/**
 * Write the release manifest once. First, every file it names must already be stored (`verified`
 * names digests this request has just checked). Throws unless the manifest exists afterwards,
 * so no pointer moves to a release the Worker could not read.
 */
async function ensureManifest(store: SiteObjectStore, manifest: SiteReleaseManifest, verified: ReadonlySet<string>): Promise<void> {
  const key = siteObjectKeys.manifest(manifest.tenantId, manifest.releaseId);
  if (await store.head(key)) return;
  const unchecked = [...new Map(manifest.files.filter((file) => !verified.has(file.sha256)).map((file) => [file.sha256, file])).values()];
  await forEachLimited(unchecked, STORE_CONCURRENCY, async (file) => {
    const blob = await store.head(siteObjectKeys.blob(manifest.tenantId, file.sha256));
    if (!blob || blob.size !== file.bytes) throw new Error("A release file is missing from the store");
  });
  // A concurrent writer of the same release writes the same bytes, so losing that race is fine,
  // but only once its write has landed: a conflict (409) can mean the other write fails.
  const written = await store.put(key, encodeJson(manifest), { contentType: JSON_TYPE, onlyIf: { absent: true } });
  if (!written && !(await store.head(key))) throw new Error("The release manifest is missing from the store");
}

const parsePointer = (body: Uint8Array): SiteHostPointer | null => {
  try {
    const parsed = siteHostPointerSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const isRetired = (pointer: SiteHostPointer): pointer is SiteHostRetiredPointer => "retired" in pointer;

/** Whether `current` already says what `wanted` would, or something the database said later. */
function supersedes(current: SiteHostPointer, wanted: SiteHostPointer): boolean {
  if (current.assignment !== wanted.assignment) return current.assignment > wanted.assignment;
  // One assignment is one site: only its version (or its retirement) can move it forward.
  if (isRetired(current)) return true;
  return !isRetired(wanted) && current.version >= wanted.version;
}

/**
 * Write `wanted` to its host by compare-and-set unless the stored pointer supersedes it.
 * Answers "current" when the host shows `wanted` or something newer for the same assignment,
 * "lost" when a later assignment holds the host, and "busy" when the writes kept racing.
 */
async function advancePointer(store: SiteObjectStore, wanted: SiteHostPointer): Promise<"current" | "lost" | "busy"> {
  const key = siteObjectKeys.host(wanted.host);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const stored = await store.get(key);
    const current = stored ? parsePointer(stored.body) : null;
    // An unreadable object is a broken projection: it is replaced like an older one.
    if (current && supersedes(current, wanted)) return current.assignment > wanted.assignment ? "lost" : "current";
    const written = await store.put(key, encodeJson(wanted), {
      contentType: JSON_TYPE,
      onlyIf: stored ? { etagMatches: stored.etag } : { absent: true },
    });
    if (written) return "current";
  }
  return "busy";
}

export interface ProjectOptions {
  /** Blob digests this request has just verified in the store (see `storeReleaseFiles`). */
  readonly verifiedBlobs?: ReadonlySet<string>;
}

/**
 * Bring the edge in line with the state read. Any store failure leaves it `pending`, and so
 * does a host a later assignment took: the state read was stale, and a new sync reads afresh.
 */
export async function projectSiteEdge(store: SiteObjectStore, state: SiteEdgeState, options: ProjectOptions = {}): Promise<SiteEdgeStatus> {
  const live = state.live;
  // Nothing published yet: a host stays unknown to the Worker (404) until the first release.
  if (!live) return "synced";
  try {
    await ensureManifest(store, {
      format: SITE_OBJECT_FORMAT, tenantId: state.tenantId, siteId: state.siteId, releaseId: live.releaseId,
      entry: live.entry, digest: live.digest, files: [...live.files],
    }, options.verifiedBlobs ?? new Set());
    let synced = true;
    await forEachLimited(state.hosts, STORE_CONCURRENCY, async ({ host, assignment }) => {
      const pointer: SiteHostLivePointer = {
        format: SITE_OBJECT_FORMAT, host, assignment, tenantId: state.tenantId, siteId: state.siteId,
        releaseId: live.releaseId, version: live.version,
      };
      if (await advancePointer(store, pointer) !== "current") synced = false;
    });
    return synced ? "synced" : "pending";
  } catch {
    return "pending";
  }
}

/**
 * Read the site's committed state and project it. `authorize` runs first in the transaction
 * (a member session's permission check). Safe to repeat and to run concurrently.
 */
export async function syncSiteEdge(
  db: ScopedDatabase,
  store: SiteObjectStore,
  tenantId: string,
  siteId: string,
  authorize?: (tx: Transaction) => Promise<void>,
  options: ProjectOptions = {},
): Promise<SiteEdgeStatus> {
  const state = await db.tenant(tenantId, async (tx) => {
    await authorize?.(tx);
    return loadSiteEdgeState(tx, tenantId, siteId);
  });
  return projectSiteEdge(store, state, options);
}

/**
 * Stop serving a detached host: after `detachSiteHost` commits, replace its pointer with a
 * retired one under the detach's number. A pointer written later for a new owner has a higher
 * number and stays; a late sync from the old owner has a lower one and can no longer write.
 * Safe to repeat. Answers false when the store kept racing, so the caller retries.
 */
export async function retractHostPointer(store: SiteObjectStore, detached: DetachedHost): Promise<boolean> {
  const host = parseHost(detached.host);
  const outcome = await advancePointer(store, { format: SITE_OBJECT_FORMAT, host, assignment: detached.assignment, retired: true });
  return outcome !== "busy";
}
