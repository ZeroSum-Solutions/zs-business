import { siteObjectKeys, type SiteObjectStore } from "@zs/contracts";
import type { VerifiedRelease } from "./compiler.js";
import { forEachLimited, STORE_CONCURRENCY } from "./limit.js";

const BLOB_TYPE = "application/octet-stream";

/**
 * Store each file once under `t/<tenant>/blobs/<sha256>`. A blob never changes, so an existing
 * one of the right size is kept, and a concurrent upload of the same bytes is no conflict.
 * Runs before the publish is dispatched: an upload whose publish never commits is unreferenced.
 * Answers the digests it verified are stored, so the sync after the commit need not ask again.
 */
export async function storeReleaseFiles(store: SiteObjectStore, tenantId: string, release: VerifiedRelease): Promise<ReadonlySet<string>> {
  const unique = new Map(release.files.map((file) => [file.sha256, file]));
  await forEachLimited([...unique.values()], STORE_CONCURRENCY, async (file) => {
    const key = siteObjectKeys.blob(tenantId, file.sha256);
    const existing = await store.head(key);
    if (existing?.size === file.bytes) return;
    if (existing) throw new Error("A stored blob has the wrong size");
    const written = await store.put(key, release.bytes.get(file.path)!, { contentType: BLOB_TYPE, onlyIf: { absent: true } });
    if (!written && (await store.head(key))?.size !== file.bytes) throw new Error("A stored blob has the wrong size");
  });
  return new Set(unique.keys());
}
