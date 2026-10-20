import { createHash } from "node:crypto";
import type { SiteObjectStore, SitePutCondition, SiteStoredObject } from "@zs/contracts";

export interface MemorySiteStore extends SiteObjectStore {
  /** Every key, sorted; for tests. */
  keys(): string[];
}

/**
 * The in-memory fake of the R2-shaped store, for tests and local runs. Conditional puts behave
 * as R2's do: one check-and-write with no await in between, so a lost race answers null.
 * Objects are copied in and out, so a caller cannot change what is stored.
 */
export function createMemorySiteStore(): MemorySiteStore {
  const objects = new Map<string, { body: Uint8Array; contentType: string; etag: string }>();
  let writes = 0;
  const holds = (key: string, condition: SitePutCondition | undefined) => {
    if (!condition) return true;
    const current = objects.get(key);
    return "absent" in condition ? current === undefined : current?.etag === condition.etagMatches;
  };
  return {
    async get(key): Promise<SiteStoredObject | null> {
      const object = objects.get(key);
      return object ? { body: object.body.slice(), contentType: object.contentType, etag: object.etag } : null;
    },
    async head(key) {
      const object = objects.get(key);
      return object ? { etag: object.etag, size: object.body.byteLength } : null;
    },
    async put(key, body, options) {
      if (!holds(key, options.onlyIf)) return null;
      // Like R2, an etag names one write, not just the bytes: a rewrite of equal bytes gets a new one.
      writes += 1;
      const etag = createHash("sha256").update(`${writes}\u0000`).update(body).digest("hex").slice(0, 32);
      objects.set(key, { body: body.slice(), contentType: options.contentType, etag });
      return { etag };
    },
    async delete(key) {
      objects.delete(key);
    },
    keys: () => [...objects.keys()].sort(),
  };
}
