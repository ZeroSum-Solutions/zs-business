import { describe, expect, it } from "vitest";
import { SITE_OBJECT_FORMAT, siteObjectKeys } from "@zs/contracts";
import { r2Reader, type R2BucketLike, type R2ObjectBodyLike } from "../src/r2.js";
import worker from "../src/worker.js";

/** A tiny stand-in for an R2 bucket binding. */
function fakeBucket(objects: Record<string, { body: string; contentType?: string; etag?: string; httpEtag?: string }>): R2BucketLike {
  return {
    async get(key) {
      const object = objects[key];
      if (!object) return null;
      const bytes = new TextEncoder().encode(object.body);
      const result: R2ObjectBodyLike = {
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        ...(object.contentType ? { httpMetadata: { contentType: object.contentType } } : {}),
        ...(object.etag ? { etag: object.etag } : {}),
        ...(object.httpEtag ? { httpEtag: object.httpEtag } : {}),
      };
      return result;
    },
  };
}

describe("r2Reader", () => {
  it("maps an R2 object to a stored object", async () => {
    const reader = r2Reader(fakeBucket({ k: { body: "hello", contentType: "text/plain", etag: "abc", httpEtag: '"abc"' } }));
    const object = await reader.get("k");
    expect(new TextDecoder().decode(object!.body)).toBe("hello");
    expect(object!.contentType).toBe("text/plain");
    expect(object!.etag).toBe("abc");
  });

  it("answers null for a missing key, and tolerates missing metadata", async () => {
    const reader = r2Reader(fakeBucket({ k: { body: "x", httpEtag: '"q"' } }));
    expect(await reader.get("missing")).toBeNull();
    const object = await reader.get("k");
    expect(object!.contentType).toBeNull();
    expect(object!.etag).toBe('"q"');
  });
});

describe("worker", () => {
  const host = "site.example.com";
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const siteId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const releaseId = "00000000-0000-4000-8000-000000000001";
  const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // SHA-256 of ""

  it("serves a release from the R2 binding", async () => {
    const SITES = fakeBucket({
      [siteObjectKeys.host(host)]: { body: JSON.stringify({ format: SITE_OBJECT_FORMAT, host, assignment: 1, tenantId, siteId, releaseId, version: 1 }) },
      [siteObjectKeys.manifest(tenantId, releaseId)]: {
        body: JSON.stringify({
          format: SITE_OBJECT_FORMAT, tenantId, siteId, releaseId, entry: "index.html", digest: "0".repeat(64),
          files: [{ path: "index.html", mediaType: "text/html", sha256: sha, bytes: 0 }],
        }),
      },
      [siteObjectKeys.blob(tenantId, sha)]: { body: "" },
    });
    const response = await worker.fetch(new Request(`https://${host}/`), { SITES });
    expect(response.status).toBe(200);
    // The digest, then 32-bit FNV-1a of "text/html" (checked against an independent implementation).
    expect(response.headers.get("etag")).toBe(`"${sha}-75d8656e"`);
  });

  it("answers a fixed 500 when the bucket throws", async () => {
    const SITES: R2BucketLike = { get: async () => { throw new Error("secret detail"); } };
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      const response = await worker.fetch(new Request(`https://${host}/`), { SITES });
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Internal error");
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(1);
  });
});
