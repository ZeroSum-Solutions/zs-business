// hub-access.md H-16, H-17 and plans.md PL-25 below the HTTP layer: the blob store step, the blob reader,
// the kind dispatch and the limit a plan row gives.
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FREE_SITE_PUBLISHES_PER_DAY, PLAN_SITE_PUBLISHES_PER_DAY, siteObjectKeys, type SiteObjectStore } from "@zs/contracts";
import {
  createBlobReader, createKindSiteCompiler, createMemorySiteStore, noBlobs, plainSiteCompiler, putSiteBlob, sitePublishLimit,
  sniffBlobType, SiteStoreUnavailable, type SiteCompiler,
} from "../src/index.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const png = () => {
  const out = new Uint8Array(40);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 8, 0, 0, 0, 8]);
  out.set(randomBytes(16), 24);
  return out;
};
const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("sniffBlobType", () => {
  it("reads the type from the bytes", () => {
    expect(sniffBlobType(png())).toBe("image/png");
    expect(sniffBlobType(Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 8, 0, 8, 1, 1, 17, 0, 2, 17, 1]))).toBe("image/jpeg");
    expect(sniffBlobType(new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;"))).toBe("image/gif");
    expect(sniffBlobType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffBlobType(new Uint8Array(0))).toBeNull();
  });
});

describe("putSiteBlob", () => {
  it("writes once under the tenant prefix and reports created only the first time", async () => {
    const store = createMemorySiteStore();
    const bytes = png();
    const first = await putSiteBlob(store, TENANT, sha(bytes), bytes);
    expect(first).toEqual({ sha256: sha(bytes), bytes: 40, mediaType: "image/png", created: true });
    expect(store.keys()).toEqual([siteObjectKeys.blob(TENANT, sha(bytes))]);
    store.resetLog();
    expect((await putSiteBlob(store, TENANT, sha(bytes), bytes)).created).toBe(false);
    expect(store.writes()).toEqual([]);
  });

  it("treats a lost conditional write as success when the winner holds the same bytes", async () => {
    const memory = createMemorySiteStore();
    const bytes = png();
    const key = siteObjectKeys.blob(TENANT, sha(bytes));
    let raced = false;
    const racing: SiteObjectStore = {
      ...memory,
      head: async (name) => { if (!raced) return null; return memory.head(name); },
      put: async (name, body, options) => { raced = true; await memory.put(name, body, { contentType: "image/png" }); return memory.put(name, body, options); },
    };
    const blob = await putSiteBlob(racing, TENANT, sha(bytes), bytes);
    expect(blob.created).toBe(false);
    expect(memory.keys()).toEqual([key]);
  });

  it("refuses every bad input before it calls the store", async () => {
    const calls: string[] = [];
    const spy: SiteObjectStore = {
      get: async () => { calls.push("get"); return null; }, head: async () => { calls.push("head"); return null; },
      put: async () => { calls.push("put"); return { etag: "x" }; }, delete: async () => { calls.push("delete"); },
    };
    const bytes = png();
    await expect(putSiteBlob(spy, TENANT, "nope", bytes)).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(putSiteBlob(spy, TENANT, sha(bytes), new Uint8Array(0))).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(putSiteBlob(spy, TENANT, sha(png()), bytes)).rejects.toMatchObject({ code: "ValidationFailed" });
    const text = new TextEncoder().encode("plain text");
    await expect(putSiteBlob(spy, TENANT, sha(text), text)).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(calls).toEqual([]);
  });

  it("answers a store that fails as SiteStoreUnavailable", async () => {
    const down: SiteObjectStore = {
      get: async () => { throw new Error("R2 500"); }, head: async () => { throw new Error("R2 500"); },
      put: async () => { throw new Error("R2 500"); }, delete: async () => { throw new Error("R2 500"); },
    };
    const bytes = png();
    await expect(putSiteBlob(down, TENANT, sha(bytes), bytes)).rejects.toBeInstanceOf(SiteStoreUnavailable);
  });
});

describe("createBlobReader", () => {
  it("reads only the tenant's own key", async () => {
    const store = createMemorySiteStore();
    const mine = png();
    const theirs = png();
    await putSiteBlob(store, TENANT, sha(mine), mine);
    await putSiteBlob(store, OTHER, sha(theirs), theirs);
    store.resetLog();
    const reader = createBlobReader(store, TENANT);
    expect(await reader.read(sha(mine))).toEqual(mine);
    await expect(reader.read(sha(theirs))).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(store.reads()).toEqual([siteObjectKeys.blob(TENANT, sha(mine)), siteObjectKeys.blob(TENANT, sha(theirs))]);
  });

  it("refuses anything but a lowercase SHA-256 without reading", async () => {
    const store = createMemorySiteStore();
    const reader = createBlobReader(store, TENANT);
    for (const digest of ["", "../x", `${OTHER}/blobs/${sha(png())}`, sha(png()).toUpperCase(), "a".repeat(63)])
      await expect(reader.read(digest)).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(store.reads()).toEqual([]);
  });

  it("fails loudly when the stored bytes do not match their digest", async () => {
    const store = createMemorySiteStore();
    const digest = sha(png());
    await store.put(siteObjectKeys.blob(TENANT, digest), png(), { contentType: "image/png" });
    await expect(createBlobReader(store, TENANT).read(digest)).rejects.toThrow(/does not match/);
  });

  it("noBlobs holds nothing", async () => {
    await expect(noBlobs.read(sha(png()))).rejects.toMatchObject({ code: "ValidationFailed" });
  });
});

describe("createKindSiteCompiler", () => {
  const tagged = (name: string): SiteCompiler => ({
    async compile() { return { entry: "index.html", files: [{ path: "index.html", mediaType: "text/html", bytes: new TextEncoder().encode(name) }] }; },
  });
  const context = { blobs: noBlobs };
  const text = async (compiler: SiteCompiler, spec: Record<string, unknown>) =>
    new TextDecoder().decode((await compiler.compile(spec as never, context)).files[0]!.bytes);

  it("sends each kind to its slot", async () => {
    const compiler = createKindSiteCompiler({ plain: tagged("plain"), publisher: tagged("publisher"), linkpage: tagged("linkpage") });
    expect(await text(compiler, { recipe: "x" })).toBe("publisher");
    expect(await text(compiler, { kind: "plain" })).toBe("plain");
    expect(await text(compiler, { kind: "linkpage" })).toBe("linkpage");
  });

  it("refuses an unwired slot and any other kind with a 400", async () => {
    const compiler = createKindSiteCompiler({ plain: plainSiteCompiler });
    for (const spec of [{ kind: "linkpage" }, { recipe: "x" }, { kind: "recipe" }, { kind: 3 }, { kind: null }, { kind: "" }, { kind: "__proto__" }])
      await expect(compiler.compile(spec as never, context), JSON.stringify(spec)).rejects.toMatchObject({ code: "ValidationFailed" });
  });
});

describe("sitePublishLimit", () => {
  const base = { plan: null, free_tier: false, granted_plan: null, granted_until: null, grant_note: null, granted_at: null, granted_by: null } as const;
  const now = new Date("2026-11-12T00:00:00Z");
  it("is none for a comped tenant, 20 for a free one, the plan's number for a paid one and the grant's while it holds", () => {
    expect(sitePublishLimit(null, now)).toBeNull();
    expect(sitePublishLimit({ ...base }, now)).toBeNull();
    expect(sitePublishLimit({ ...base, free_tier: true }, now)).toBe(FREE_SITE_PUBLISHES_PER_DAY);
    expect(sitePublishLimit({ ...base, free_tier: true, plan: "solo" }, now)).toBe(PLAN_SITE_PUBLISHES_PER_DAY.solo);
    expect(sitePublishLimit({ ...base, free_tier: true, granted_plan: "pro" }, now)).toBe(PLAN_SITE_PUBLISHES_PER_DAY.pro);
    expect(sitePublishLimit({ ...base, free_tier: true, granted_plan: "pro", granted_until: new Date("2026-11-11T00:00:00Z") }, now)).toBe(FREE_SITE_PUBLISHES_PER_DAY);
  });
});
