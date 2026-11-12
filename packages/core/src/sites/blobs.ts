// hub-access.md H-16, H-17: the content-addressed blobs a release may name. A blob is a picture the
// tenant uploaded ahead of a release, stored once at `t/<tenant>/blobs/<sha256>` (the key
// `storeReleaseFiles` uses). Original code.
import { createHash } from "node:crypto";
import {
  SITE_LIMITS, sha256HexSchema, siteBlobTypeSchema, siteObjectKeys, ValidationFailed,
  type SiteBlob, type SiteBlobType, type SiteObjectStore,
} from "@zs/contracts";
import { SiteStoreUnavailable, validationError } from "../edge/errors.js";
import { readImageInfo } from "../images/png.js";
import type { SiteBlobReader } from "./compiler.js";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));

/** The picture type the bytes themselves show (PNG, JPEG, WebP, GIF), or null. The caller's Content-Type is never used. */
export function sniffBlobType(bytes: Uint8Array): SiteBlobType | null {
  if (bytes.length >= 13 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "image/gif";
  const info = readImageInfo(bytes);
  return info ? siteBlobTypeSchema.parse(info.contentType) : null;
}

/** The refusal of a spec that names a blob the tenant never uploaded. One answer for "nobody holds it" and "another tenant holds it". */
const missingBlob = (digest: string) =>
  validationError("The spec names a picture that was not uploaded", [{ path: ["spec"], message: `Blob ${digest} was not uploaded` }]);

/**
 * H-17: the reader a compile receives. It builds the key from the request's tenant and a digest that
 * passed the SHA-256 schema, so no spec can reach another tenant's prefix or any other key.
 */
export function createBlobReader(store: Pick<SiteObjectStore, "get">, tenantId: string): SiteBlobReader {
  return {
    async read(digest) {
      const parsed = sha256HexSchema.safeParse(digest);
      if (!parsed.success) throw validationError("The spec names an invalid picture digest", [{ path: ["spec"], message: "A blob digest is 64 lowercase hex characters" }]);
      // A store that does not answer is retryable (503), unlike a blob that is absent (400) or corrupt (500).
      const object = await store.get(siteObjectKeys.blob(tenantId, parsed.data)).catch((cause: unknown) => { throw new SiteStoreUnavailable({ cause }); });
      if (!object) throw missingBlob(parsed.data);
      if (sha256(object.body) !== parsed.data) throw new Error("A stored blob does not match its digest");
      return object.body;
    },
  };
}

/** A reader for a caller with no store: every digest is missing. */
export const noBlobs: SiteBlobReader = {
  async read(digest) { throw missingBlob(digest); },
};

/**
 * H-16: check the bytes against the path, then store them once under the tenant's prefix. Every refusal
 * (path, size, type, digest) happens before any store call, so a refused upload touches nothing. The same
 * bytes again are not rewritten.
 */
export async function putSiteBlob(
  store: Pick<SiteObjectStore, "head" | "put">, tenantId: string, digest: unknown, bytes: Uint8Array,
): Promise<SiteBlob> {
  const parsed = sha256HexSchema.safeParse(digest);
  if (!parsed.success) throw validationError("Invalid request", [{ path: ["sha256"], message: "Lowercase hex SHA-256" }]);
  if (bytes.byteLength < 1 || bytes.byteLength > SITE_LIMITS.fileBytes) throw new ValidationFailed("Picture size is not allowed");
  const mediaType = sniffBlobType(bytes);
  if (!mediaType) throw new ValidationFailed("Not a supported picture");
  if (sha256(bytes) !== parsed.data) throw new ValidationFailed("The bytes do not match the SHA-256 in the path");
  const key = siteObjectKeys.blob(tenantId, parsed.data);
  // A store that does not answer is a 503 (retry later); an object of the wrong size is a fault (500).
  const stored = <T>(work: Promise<T>) => work.catch((cause: unknown) => { throw new SiteStoreUnavailable({ cause }); });
  const wrongSize = () => new Error("A stored blob has the wrong size");
  const existing = await stored(store.head(key));
  if (existing) {
    if (existing.size !== bytes.byteLength) throw wrongSize();
    return { sha256: parsed.data, bytes: bytes.byteLength, mediaType, created: false };
  }
  const written = await stored(store.put(key, bytes, { contentType: mediaType, onlyIf: { absent: true } }));
  if (!written && (await stored(store.head(key)))?.size !== bytes.byteLength) throw wrongSize();
  return { sha256: parsed.data, bytes: bytes.byteLength, mediaType, created: written !== null };
}
