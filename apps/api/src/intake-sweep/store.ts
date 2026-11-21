// The intake file store (document-intake.md DL-3, DL-16) over the R2-shaped site object store: the PDFs sit in the
// site store's bucket under the server-built key `t/<tenant>/intake/<job>/<sha256>.pdf`, with no key prefix.
import type { SiteObjectStore } from "@zs/contracts";
import type { IntakeFileStore } from "@zs/core";

export function createIntakeFileStore(objects: SiteObjectStore): IntakeFileStore {
  return {
    async put(path, bytes) {
      await objects.put(path, bytes, { contentType: "application/pdf" });
    },
    async read(path) {
      return (await objects.get(path))?.body ?? null;
    },
    async exists(path) {
      return (await objects.head(path)) !== null;
    },
    async delete(path) {
      await objects.delete(path);
    },
  };
}
