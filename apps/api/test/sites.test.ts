import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiErrorBodySchema,
  siteHostPointerSchema,
  siteListSchema,
  siteObjectKeys,
  siteOutputSchema,
  siteReleaseDetailSchema,
  siteReleaseListSchema,
  siteReleaseResponseSchema,
  siteSyncResponseSchema,
  type SiteObjectStore,
  type SiteReleaseResponse,
} from "@zs/contracts";
import {
  attachSiteHost,
  createMemorySiteStore,
  detachSiteHost,
  loadSiteEdgeState,
  plainSiteCompiler,
  projectSiteEdge,
  retractHostPointer,
} from "@zs/core";
import { serveSite } from "@zs/site-worker";
import { call, clock, createApiHarness, signedInMember, type ApiHarness, type TenantSetup } from "./helpers.js";

/**
 * The real store, with switches for R2 failures: host-pointer writes fail, every call fails,
 * host-pointer reads never answer, or a manifest write loses a conflict (409) whose winner fails.
 */
const memory = createMemorySiteStore();
let pointerWritesFail = false;
let storeDown = false;
let pointerReadsHang = false;
let manifestConflict = false;
const down = () => { if (storeDown) throw new Error("R2 answered 500"); };
const store: SiteObjectStore = {
  get: async (key) => {
    down();
    if (pointerReadsHang && key.startsWith("hosts/")) return new Promise(() => undefined);
    return memory.get(key);
  },
  head: async (key) => { down(); return memory.head(key); },
  delete: async (key) => { down(); return memory.delete(key); },
  put: async (key, body, options) => {
    down();
    if (pointerWritesFail && key.startsWith("hosts/")) throw new Error("R2 put failed with status 500");
    if (manifestConflict && key.endsWith("/manifest.json")) return null;
    return memory.put(key, body, options);
  },
};
/** The projection's own time in these tests: short, so a hung store answers quickly. */
const SYNC_TIMEOUT_MS = 1_500;

let h: ApiHarness;
beforeAll(async () => { h = await createApiHarness({ sites: { store, compiler: plainSiteCompiler, syncTimeoutMs: SYNC_TIMEOUT_MS } }); });
afterAll(async () => { await h?.close(); });

const errorOf = (response: { body: unknown }) => apiErrorBodySchema.parse(response.body).error;
const spec = (title: string) => ({ kind: "plain", title, sections: [{ heading: "Hours", body: "Mon to Fri" }] });
const createSite = async (tenant: TenantSetup, name = "Main site") => {
  const response = await call(h.app, "POST", "/v1/sites", { token: tenant.token, key: randomUUID(), body: { name } });
  expect(response.status).toBe(201);
  return siteOutputSchema.parse(response.body).result;
};
const publish = (tenant: Pick<TenantSetup, "token">, siteId: string, title: string, key: string = randomUUID()) =>
  call(h.app, "POST", `/v1/sites/${siteId}/releases`, { token: tenant.token, key, body: { spec: spec(title) } });
const published = async (tenant: TenantSetup, siteId: string, title: string): Promise<SiteReleaseResponse> => {
  const response = await publish(tenant, siteId, title);
  expect(response.status).toBe(201);
  return siteReleaseResponseSchema.parse(response.body);
};
const activate = (tenant: TenantSetup, siteId: string, releaseId: string, expectedCurrentReleaseId: string | null) =>
  call(h.app, "POST", `/v1/sites/${siteId}/releases/${releaseId}/activate`, {
    token: tenant.token, key: randomUUID(), body: { expectedCurrentReleaseId },
  });
const attach = (tenant: TenantSetup, siteId: string, host: string) =>
  h.fixture.service((tx) => attachSiteHost(tx, { tenantId: tenant.tenantId, siteId, host }, clock.now()));
const detach = async (tenant: TenantSetup, siteId: string, host: string) => {
  const detached = await h.fixture.service((tx) => detachSiteHost(tx, { tenantId: tenant.tenantId, siteId, host }));
  expect(detached).not.toBeNull();
  return detached!;
};
const visit = async (host: string, path = "/") => {
  const response = await serveSite(new Request(`https://${host}${path}`), store);
  return { status: response.status, text: await response.text(), headers: response.headers };
};
const hostName = () => `site-${randomUUID().slice(0, 8)}.example.com`;

describe("publishing a site", () => {
  it("compiles the spec, stores each file once, records the release and serves it by host", async () => {
    const site = await createSite(h.a);
    expect(site).toMatchObject({ currentReleaseId: null, pointerVersion: 0, hosts: [] });
    const host = hostName();
    await attach(h.a, site.id, host);
    // A host with nothing published is unknown to the Worker.
    expect((await visit(host)).status).toBe(404);

    const first = await published(h.a, site.id, "Halden & Rowe");
    expect(first.edge).toBe("synced");
    expect(first.result.site).toMatchObject({ currentReleaseId: first.result.release.id, pointerVersion: 1, hosts: [host] });
    expect(first.result.release).toMatchObject({ siteId: site.id, entry: "index.html", fileCount: 2, createdBy: h.a.actorId });

    const page = await visit(host);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.text).toContain("<h1>Halden &amp; Rowe</h1>");
    expect((await visit(host, "/missing")).status).toBe(404);

    const detail = siteReleaseDetailSchema.parse((await call(h.app, "GET",
      `/v1/sites/${site.id}/releases/${first.result.release.id}`, { token: h.a.token })).body);
    expect(detail.spec).toEqual(spec("Halden & Rowe"));
    for (const file of detail.files)
      expect(await memory.head(siteObjectKeys.blob(h.a.tenantId, file.sha256))).toMatchObject({ size: file.bytes });
    expect(await memory.head(siteObjectKeys.manifest(h.a.tenantId, first.result.release.id))).not.toBeNull();
  });

  it("answers unknown and malformed hosts with 404", async () => {
    expect((await visit("nobody.example.com")).status).toBe(404);
    expect((await serveSite(new Request("https://x/", { headers: { host: "not a host" } }), store)).status).toBe(404);
  });

  it("replays a publish retried with its key, and refuses the key with another spec", async () => {
    const site = await createSite(h.a);
    const key = randomUUID();
    const once = await publish(h.a, site.id, "Fitting room", key);
    const again = await publish(h.a, site.id, "Fitting room", key);
    expect(again.status).toBe(201);
    expect(again.body.actionId).toBe(once.body.actionId);
    expect(again.body.result.release.id).toBe(once.body.result.release.id);
    const other = await publish(h.a, site.id, "Another title", key);
    expect(other.status).toBe(409);
    expect(errorOf(other).details).toEqual({ reason: "idempotency_key_reused" });
    const releases = siteReleaseListSchema.parse((await call(h.app, "GET", `/v1/sites/${site.id}/releases`, { token: h.a.token })).body);
    expect(releases.items).toHaveLength(1);
  });

  it("refuses a spec the compiler cannot build, before storing anything", async () => {
    const site = await createSite(h.a);
    const before = memory.keys().length;
    const response = await call(h.app, "POST", `/v1/sites/${site.id}/releases`, {
      token: h.a.token, key: randomUUID(), body: { spec: { kind: "plain", title: "" } },
    });
    expect(response.status).toBe(400);
    expect(memory.keys().length).toBe(before);
  });
});

describe("activating a release (rollback)", () => {
  it("moves the pointer back and forward, one version per move", async () => {
    const site = await createSite(h.a);
    const host = hostName();
    await attach(h.a, site.id, host);
    const v1 = await published(h.a, site.id, "Version one");
    const v2 = await published(h.a, site.id, "Version two");
    expect(v2.result.site.pointerVersion).toBe(2);
    expect((await visit(host)).text).toContain("Version two");

    const back = await activate(h.a, site.id, v1.result.release.id, v2.result.release.id);
    expect(back.status).toBe(200);
    const rolledBack = siteReleaseResponseSchema.parse(back.body);
    expect(rolledBack).toMatchObject({ edge: "synced", result: { site: { currentReleaseId: v1.result.release.id, pointerVersion: 3 } } });
    expect((await visit(host)).text).toContain("Version one");

    // A view that still thinks v2 is live is stale.
    const stale = await activate(h.a, site.id, v2.result.release.id, v2.result.release.id);
    expect(stale.status).toBe(409);
    expect(errorOf(stale).details).toEqual({ reason: "stale_release" });

    // Activating the live release changes nothing.
    const same = siteReleaseResponseSchema.parse((await activate(h.a, site.id, v1.result.release.id, v1.result.release.id)).body);
    expect(same.result.site.pointerVersion).toBe(3);

    const forward = siteReleaseResponseSchema.parse((await activate(h.a, site.id, v2.result.release.id, v1.result.release.id)).body);
    expect(forward.result.site.pointerVersion).toBe(4);
    expect((await visit(host)).text).toContain("Version two");
  });

  it("lets one of two racing rollbacks win; the other sees a stale view", async () => {
    const site = await createSite(h.a);
    const v1 = await published(h.a, site.id, "One");
    const v2 = await published(h.a, site.id, "Two");
    const v3 = await published(h.a, site.id, "Three");
    const [x, y] = await Promise.all([
      activate(h.a, site.id, v1.result.release.id, v3.result.release.id),
      activate(h.a, site.id, v2.result.release.id, v3.result.release.id),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const winner = x.status === 200 ? x : y;
    const live = siteOutputSchema.shape.result.parse((await call(h.app, "GET", `/v1/sites/${site.id}`, { token: h.a.token })).body);
    expect(live.currentReleaseId).toBe(winner.body.result.release.id);
    expect(live.pointerVersion).toBe(4);
  });

  it("refuses a release of another site", async () => {
    const one = await createSite(h.a);
    const two = await createSite(h.a);
    const release = await published(h.a, two.id, "Elsewhere");
    const response = await activate(h.a, one.id, release.result.release.id, null);
    expect(response.status).toBe(404);
  });
});

describe("the pointer flip", () => {
  it("serializes concurrent publishes and leaves the edge on the database's live release", async () => {
    const site = await createSite(h.a);
    const host = hostName();
    await attach(h.a, site.id, host);
    const results = await Promise.all(["A", "B", "C", "D"].map((title) => publish(h.a, site.id, `Release ${title}`)));
    for (const response of results) expect(response.status).toBe(201);
    const versions = results.map((response) => siteReleaseResponseSchema.parse(response.body).result.site.pointerVersion).sort();
    expect(versions).toEqual([1, 2, 3, 4]);
    const live = siteOutputSchema.shape.result.parse((await call(h.app, "GET", `/v1/sites/${site.id}`, { token: h.a.token })).body);
    const pointer = siteHostPointerSchema.parse(JSON.parse(new TextDecoder().decode((await memory.get(siteObjectKeys.host(host)))!.body)));
    expect(pointer).toMatchObject({ releaseId: live.currentReleaseId, version: 4, tenantId: h.a.tenantId, siteId: site.id });
  });

  it("never moves the edge back to an older version", async () => {
    const site = await createSite(h.a);
    const host = hostName();
    await attach(h.a, site.id, host);
    await published(h.a, site.id, "First");
    const old = await h.database.db.tenant(h.a.tenantId, (tx) => loadSiteEdgeState(tx, h.a.tenantId, site.id));
    await published(h.a, site.id, "Second");
    // A slow sync that read the first state finishes last.
    expect(await projectSiteEdge(store, old)).toBe("synced");
    expect((await visit(host)).text).toContain("Second");
  });

  it("commits when the edge write fails, keeps serving the old release, and catches up on sync", async () => {
    const site = await createSite(h.a);
    const host = hostName();
    await attach(h.a, site.id, host);
    await published(h.a, site.id, "Before outage");
    pointerWritesFail = true;
    let during: SiteReleaseResponse;
    try {
      during = await published(h.a, site.id, "After outage");
    } finally {
      pointerWritesFail = false;
    }
    expect(during.edge).toBe("pending");
    expect(during.result.site.pointerVersion).toBe(2);
    expect((await visit(host)).text).toContain("Before outage");
    const synced = siteSyncResponseSchema.parse((await call(h.app, "POST", `/v1/sites/${site.id}/sync`, { token: h.a.token })).body);
    expect(synced).toMatchObject({ edge: "synced", site: { pointerVersion: 2 } });
    expect((await visit(host)).text).toContain("After outage");
  });

  it("answers a committed write with pending, in time, when the store stops answering", async () => {
    const site = await createSite(h.a);
    const host = hostName();
    await attach(h.a, site.id, host);
    await published(h.a, site.id, "Before the hang");
    pointerReadsHang = true;
    try {
      const started = Date.now();
      const during = await published(h.a, site.id, "During the hang");
      expect(during.edge).toBe("pending");
      expect(during.result.site.pointerVersion).toBe(2);
      expect(Date.now() - started).toBeLessThan(SYNC_TIMEOUT_MS + 3_000);
    } finally {
      pointerReadsHang = false;
    }
    const synced = siteSyncResponseSchema.parse((await call(h.app, "POST", `/v1/sites/${site.id}/sync`, { token: h.a.token })).body);
    expect(synced.edge).toBe("synced");
    expect((await visit(host)).text).toContain("During the hang");
  });

  it("keeps the hosts on the old release when the manifest write loses a conflict that never lands", async () => {
    const site = await createSite(h.a);
    const host = hostName();
    await attach(h.a, site.id, host);
    await published(h.a, site.id, "Readable");
    manifestConflict = true;
    let during: SiteReleaseResponse;
    try {
      during = await published(h.a, site.id, "No manifest yet");
    } finally {
      manifestConflict = false;
    }
    expect(during.edge).toBe("pending");
    expect((await visit(host)).text).toContain("Readable");
    const synced = siteSyncResponseSchema.parse((await call(h.app, "POST", `/v1/sites/${site.id}/sync`, { token: h.a.token })).body);
    expect(synced.edge).toBe("synced");
    expect((await visit(host)).text).toContain("No manifest yet");
  });

  it("replays a committed publish while the store is down, and refuses a new one with 503", async () => {
    const site = await createSite(h.a);
    const key = randomUUID();
    const first = await publish(h.a, site.id, "Recorded", key);
    expect(first.status).toBe(201);
    storeDown = true;
    try {
      const again = await publish(h.a, site.id, "Recorded", key);
      expect(again.status).toBe(201);
      const replayed = siteReleaseResponseSchema.parse(again.body);
      expect(replayed.result).toEqual(siteReleaseResponseSchema.parse(first.body).result);
      expect(replayed.edge).toBe("pending");
      const fresh = await publish(h.a, site.id, "Not recorded");
      expect(fresh.status).toBe(503);
      expect(errorOf(fresh).code).toBe("Unavailable");
    } finally {
      storeDown = false;
    }
    const releases = siteReleaseListSchema.parse((await call(h.app, "GET", `/v1/sites/${site.id}/releases`, { token: h.a.token })).body);
    expect(releases.items).toHaveLength(1);
  });
});

describe("hosts", () => {
  it("belong to one site in the whole system", async () => {
    const a = await createSite(h.a);
    const b = await createSite(h.b);
    const host = hostName();
    await attach(h.a, a.id, host);
    await expect(attach(h.b, b.id, host)).rejects.toMatchObject({ code: "Conflict", details: { reason: "host_in_use" } });
    await expect(attach(h.a, a.id, "localhost")).rejects.toMatchObject({ code: "ValidationFailed" });
  });

  it("stop serving once detached and retracted", async () => {
    const site = await createSite(h.a);
    const host = hostName();
    await attach(h.a, site.id, host);
    await published(h.a, site.id, "Leaving soon");
    expect((await visit(host)).status).toBe(200);
    const detached = await detach(h.a, site.id, host);
    expect(await retractHostPointer(store, detached)).toBe(true);
    expect((await visit(host)).status).toBe(404);
  });

  it("normalize the host on detach, so the retraction finds its pointer", async () => {
    const site = await createSite(h.a);
    const host = hostName();
    await attach(h.a, site.id, host);
    await published(h.a, site.id, "Mixed case");
    const detached = await detach(h.a, site.id, `${host.toUpperCase()}.`);
    expect(detached.host).toBe(host);
    await retractHostPointer(store, detached);
    expect((await visit(host)).status).toBe(404);
  });

  it("go to their new site, and a stale sync or a late retraction from the old one cannot take them back", async () => {
    const a = await createSite(h.a);
    const b = await createSite(h.b);
    const host = hostName();
    await attach(h.a, a.id, host);
    await published(h.a, a.id, "Tenant A before the move");
    // A's sync reads the database, then stalls before it writes the host pointer.
    const stale = await h.database.db.tenant(h.a.tenantId, (tx) => loadSiteEdgeState(tx, h.a.tenantId, a.id));

    // The host leaves A. Until it is retracted, a stale sync may not bring it back either.
    const detached = await detach(h.a, a.id, host);
    await retractHostPointer(store, detached);
    expect(await projectSiteEdge(store, stale)).toBe("pending");
    expect((await visit(host)).status).toBe(404);

    // The host goes to tenant B, which publishes; then A's stale sync and the retraction run again.
    await attach(h.b, b.id, host);
    await published(h.b, b.id, "Tenant B owns it now");
    expect(await projectSiteEdge(store, stale)).toBe("pending");
    expect(await retractHostPointer(store, detached)).toBe(true);
    const page = await visit(host);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Tenant B owns it now");
    expect(page.text).not.toContain("Tenant A");
  });

  it("go to their new site even when the old pointer was never retracted", async () => {
    const a = await createSite(h.a);
    const b = await createSite(h.b);
    const host = hostName();
    await attach(h.a, a.id, host);
    await published(h.a, a.id, "Tenant A forgot");
    const stale = await h.database.db.tenant(h.a.tenantId, (tx) => loadSiteEdgeState(tx, h.a.tenantId, a.id));
    await detach(h.a, a.id, host);
    await attach(h.b, b.id, host);
    await published(h.b, b.id, "Tenant B took over");
    expect(await projectSiteEdge(store, stale)).toBe("pending");
    expect((await visit(host)).text).toContain("Tenant B took over");
  });
});

describe("hosts racing", () => {
  it("number the new owner above a detach that committed while its attach waited", async () => {
    const a = await createSite(h.a);
    const b = await createSite(h.b);
    const host = hostName();
    let attachedToA!: () => void;
    const heldByA = new Promise<void>((resolve) => { attachedToA = resolve; });
    let letGo!: () => void;
    const gate = new Promise<void>((resolve) => { letGo = resolve; });
    // One service transaction attaches the host to A, then detaches it before committing.
    const first = h.fixture.service(async (tx) => {
      await attachSiteHost(tx, { tenantId: h.a.tenantId, siteId: a.id, host }, clock.now());
      attachedToA();
      await gate;
      return detachSiteHost(tx, { tenantId: h.a.tenantId, siteId: a.id, host });
    });
    await heldByA;
    // B's attach starts meanwhile and has to wait for that transaction.
    const second = attach(h.b, b.id, host);
    await new Promise((resolve) => setTimeout(resolve, 250));
    letGo();
    const detached = await first;
    expect(detached).not.toBeNull();
    await second;

    const row = await h.fixture.service((tx) => tx.query<{ assignment: string }>("SELECT assignment FROM site_hosts WHERE host=$1", [host]));
    expect(Number(row.rows[0]!.assignment)).toBeGreaterThan(detached!.assignment);
    // So the detach's retraction cannot hide B's site.
    await retractHostPointer(store, detached!);
    await published(h.b, b.id, "Tenant B after the race");
    const page = await visit(host);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Tenant B after the race");
  });
});

describe("tenant isolation", () => {
  it("serves each tenant's host from its own release only", async () => {
    const a = await createSite(h.a);
    const b = await createSite(h.b);
    const hostA = hostName();
    const hostB = hostName();
    await attach(h.a, a.id, hostA);
    await attach(h.b, b.id, hostB);
    await published(h.a, a.id, "Tenant A shop");
    await published(h.b, b.id, "Tenant B shop");
    expect((await visit(hostA)).text).toContain("Tenant A shop");
    expect((await visit(hostB)).text).toContain("Tenant B shop");
    expect((await visit(hostA)).text).not.toContain("Tenant B");
  });

  it("hides one tenant's sites and releases from the other, over HTTP and under the runtime role", async () => {
    const site = await createSite(h.a);
    const release = await published(h.a, site.id, "Private");
    const id = release.result.release.id;
    expect((await call(h.app, "GET", `/v1/sites/${site.id}`, { token: h.b.token })).status).toBe(404);
    expect((await call(h.app, "GET", `/v1/sites/${site.id}/releases`, { token: h.b.token })).status).toBe(404);
    expect((await call(h.app, "GET", `/v1/sites/${site.id}/releases/${id}`, { token: h.b.token })).status).toBe(404);
    expect((await call(h.app, "POST", `/v1/sites/${site.id}/sync`, { token: h.b.token })).status).toBe(404);
    expect([403, 404]).toContain((await publish(h.b, site.id, "Hijack")).status);
    expect([403, 404]).toContain((await activate(h.b, site.id, id, id)).status);
    const listed = siteListSchema.parse((await call(h.app, "GET", "/v1/sites", { token: h.b.token })).body);
    expect(listed.items.map((item) => item.id)).not.toContain(site.id);

    for (const table of ["sites", "site_releases", "site_release_files", "site_pointers", "site_activations", "site_hosts"]) {
      const seen = await h.fixture.b.run(async (tx) => (await tx.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1`, [h.a.tenantId])).rowCount);
      expect(seen, table).toBe(0);
    }
    await expect(h.fixture.b.run((tx) => tx.query(
      "UPDATE site_pointers SET release_id=release_id WHERE tenant_id=$1", [h.a.tenantId],
    )).then((result) => result.rowCount)).resolves.toBe(0);
  });

  it("keeps release history append-only for every role", async () => {
    await expect(h.fixture.a.run((tx) => tx.query("UPDATE site_releases SET entry='x'"))).rejects.toMatchObject({ code: "42501" });
    await expect(h.fixture.a.run((tx) => tx.query("DELETE FROM site_release_files"))).rejects.toMatchObject({ code: "42501" });
    await expect(h.fixture.service((tx) => tx.query("DELETE FROM site_activations"))).rejects.toMatchObject({ code: "42501" });
    await expect(h.fixture.a.run((tx) => tx.query("INSERT INTO site_hosts (tenant_id, host, site_id, created_at) VALUES ($1,'x.example.com',$2,now())",
      [h.a.tenantId, randomUUID()]))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("permissions", () => {
  it("keeps sites to owners", async () => {
    const staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
    const site = await createSite(h.a);
    expect((await call(h.app, "GET", "/v1/sites", { token: staff.token })).status).toBe(403);
    expect((await call(h.app, "POST", "/v1/sites", { token: staff.token, key: randomUUID(), body: { name: "Mine" } })).status).toBe(403);
    expect((await publish(staff, site.id, "Staff edit")).status).toBe(403);
  });
});
