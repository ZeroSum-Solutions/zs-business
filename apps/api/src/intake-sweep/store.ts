// The intake file store (document-intake.md DL-3, DL-16) over the R2-shaped site object store: the PDFs sit in the
// site store's bucket under the server-built key `t/<tenant>/intake/<job>/<sha256>.pdf`, with no key prefix.
import type { SiteObjectStore } from "@zs/contracts";
import { SiteStoreUnavailable, type IntakeFileStore } from "@zs/core";

// A put or read that fails (R2 down, a timeout) is SiteStoreUnavailable, a retryable 503 on the upload and the
// worker's file route, as for /v1/sites. A delete keeps its own error: the sweep's alert names the cause.
const unavailable = (cause: unknown): never => { throw new SiteStoreUnavailable({ cause }); };

export function createIntakeFileStore(objects: SiteObjectStore): IntakeFileStore {
  return {
    async put(path, bytes) {
      await objects.put(path, bytes, { contentType: "application/pdf" }).catch(unavailable);
    },
    async read(path) {
      return (await objects.get(path).catch(unavailable))?.body ?? null;
    },
    async delete(path) {
      await objects.delete(path);
    },
  };
}
