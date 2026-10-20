import type { SiteObjectReader, SiteStoredObject } from "@zs/contracts";

// The few parts of the Cloudflare R2 binding the Worker uses, declared structurally so the
// package needs no Workers type package. A real `R2Bucket` satisfies `R2BucketLike`.

export interface R2ObjectBodyLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  readonly httpMetadata?: { readonly contentType?: string | undefined } | undefined;
  readonly etag?: string | undefined;
  readonly httpEtag?: string | undefined;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
}

/** Read site objects from an R2 bucket binding. The etag stays opaque, as the port says. */
export function r2Reader(bucket: R2BucketLike): SiteObjectReader {
  return {
    async get(key): Promise<SiteStoredObject | null> {
      const object = await bucket.get(key);
      if (!object) return null;
      return {
        body: new Uint8Array(await object.arrayBuffer()),
        contentType: object.httpMetadata?.contentType ?? null,
        etag: object.etag ?? object.httpEtag ?? "",
      };
    },
  };
}
