// The edge projection. After a commit, write what the dispatch Worker reads: the live
// release's manifest (immutable, once) and one pointer object per host. A pointer only ever
// moves to a higher version, by compare-and-set on the store's etag, so two syncs racing
// (or a slow one finishing late) can never put an older release back.
import {
  SITE_OBJECT_FORMAT,
  siteHostPointerSchema,
  siteObjectKeys,
  type SiteEdgeStatus,
  type SiteFile,
  type SiteHostPointer,
  type SiteObjectStore,
  type SiteReleaseManifest,
} from "@zs/contracts";
import type { ScopedDatabase, Transaction } from "@zs/db";
import { loadReleaseFiles } from "./reads.js";

const JSON_TYPE = "application/json";
const encoder = new TextEncoder();
const encodeJson = (value: unknown) => encoder.encode(JSON.stringify(value));

/** Attempts per host pointer before the sync reports `pending`; each one re-reads the object. */
const CAS_ATTEMPTS = 5;

export interface SiteEdgeState {
  readonly tenantId: string;
  readonly siteId: string;
  readonly hosts: readonly string[];
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
  const hosts = (await tx.query<{ host: string }>(
    "SELECT host FROM site_hosts WHERE tenant_id=$1 AND site_id=$2 ORDER BY host", [tenantId, siteId],
  )).rows.map((row) => row.host);
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

/** Write the release manifest once. First, every file it names must already be stored. */
async function ensureManifest(store: SiteObjectStore, manifest: SiteReleaseManifest): Promise<void> {
  const key = siteObjectKeys.manifest(manifest.tenantId, manifest.releaseId);
  if (await store.head(key)) return;
  for (const file of manifest.files) {
    const blob = await store.head(siteObjectKeys.blob(manifest.tenantId, file.sha256));
    if (!blob || blob.size !== file.bytes) throw new Error("A release file is missing from the store");
  }
  // A concurrent writer of the same release writes the same bytes: losing that race is fine.
  await store.put(key, encodeJson(manifest), { contentType: JSON_TYPE, onlyIf: { absent: true } });
}

const parsePointer = (body: Uint8Array): SiteHostPointer | null => {
  try {
    const parsed = siteHostPointerSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * Move one host's pointer to `wanted` unless it already shows that site at the same or a later
 * version. The database row for the host names this site, so a pointer left by another site
 * or tenant (the host was moved) is replaced. Answers whether the host now shows `wanted` or newer.
 */
async function advancePointer(store: SiteObjectStore, wanted: SiteHostPointer): Promise<boolean> {
  const key = siteObjectKeys.host(wanted.host);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const stored = await store.get(key);
    const current = stored ? parsePointer(stored.body) : null;
    if (current && current.tenantId === wanted.tenantId && current.siteId === wanted.siteId && current.version >= wanted.version)
      return true;
    const written = await store.put(key, encodeJson(wanted), {
      contentType: JSON_TYPE,
      onlyIf: stored ? { etagMatches: stored.etag } : { absent: true },
    });
    if (written) return true;
  }
  return false;
}

/** Bring the edge in line with the state read. Any store failure leaves it `pending`. */
export async function projectSiteEdge(store: SiteObjectStore, state: SiteEdgeState): Promise<SiteEdgeStatus> {
  const live = state.live;
  // Nothing published yet: a host stays unknown to the Worker (404) until the first release.
  if (!live) return "synced";
  try {
    await ensureManifest(store, {
      format: SITE_OBJECT_FORMAT, tenantId: state.tenantId, siteId: state.siteId, releaseId: live.releaseId,
      entry: live.entry, digest: live.digest, files: [...live.files],
    });
    let synced = true;
    for (const host of state.hosts) {
      synced = await advancePointer(store, {
        format: SITE_OBJECT_FORMAT, host, tenantId: state.tenantId, siteId: state.siteId,
        releaseId: live.releaseId, version: live.version,
      }) && synced;
    }
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
): Promise<SiteEdgeStatus> {
  const state = await db.tenant(tenantId, async (tx) => {
    await authorize?.(tx);
    return loadSiteEdgeState(tx, tenantId, siteId);
  });
  return projectSiteEdge(store, state);
}

/** Stop serving a host that left the site: delete its pointer if it still names this site. */
export async function retractHostPointer(store: SiteObjectStore, host: string, tenantId: string, siteId: string): Promise<void> {
  const key = siteObjectKeys.host(host);
  const stored = await store.get(key);
  const current = stored ? parsePointer(stored.body) : null;
  if (current && current.tenantId === tenantId && current.siteId === siteId) await store.delete(key);
}
