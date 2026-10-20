// M4b site actions. They run inside the shared dispatcher transaction and touch only the
// database: file bytes are already in object storage (content-addressed) before a publish is
// dispatched, and the edge objects are written from committed state afterwards (sync.ts).
import {
  activateSiteReleaseCommandSchema,
  Conflict,
  createSiteCommandSchema,
  NotFound,
  publishSiteReleaseCommandSchema,
  siteReleaseDigest,
  TenantDenied,
  ValidationFailed,
  type SiteRecord,
  type SiteReleaseRecord,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { parseOrFail } from "../crm/rows.js";
import { findRelease, getSite } from "./reads.js";

async function resolveSite(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== "site") throw new ValidationFailed("Site actions require a site target");
  const owned = await tx.query("SELECT 1 FROM sites WHERE tenant_id=$1 AND id=$2", [target.tenantId, target.id]);
  return owned.rowCount === 1 ? { tenantId: target.tenantId, type: "site", id: target.id } : null;
}

/**
 * Lock the site row: publishes and activations of one site run one at a time, so versions
 * never repeat and the expected-current check sees the latest pointer. Returns the pointer.
 */
async function lockSite(tx: Transaction, tenantId: string, siteId: string) {
  const site = await tx.query("SELECT 1 FROM sites WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, siteId]);
  if (site.rowCount !== 1) throw new TenantDenied();
  return (await tx.query<{ release_id: string; version: string }>(
    "SELECT release_id, version FROM site_pointers WHERE tenant_id=$1 AND site_id=$2", [tenantId, siteId],
  )).rows[0] ?? null;
}

/** Point the site at a release: one row write, plus the activation log entry. */
async function activate(tx: Transaction, input: {
  tenantId: string; siteId: string; releaseId: string; version: number; actorId: string; now: Date;
}): Promise<void> {
  const { tenantId, siteId, releaseId, version, actorId, now } = input;
  await tx.query(
    `INSERT INTO site_pointers (tenant_id, site_id, release_id, version, updated_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, site_id) DO UPDATE SET release_id=EXCLUDED.release_id, version=EXCLUDED.version, updated_at=EXCLUDED.updated_at`,
    [tenantId, siteId, releaseId, version, now],
  );
  await tx.query(
    "INSERT INTO site_activations (tenant_id, site_id, version, release_id, actor_id, activated_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [tenantId, siteId, version, releaseId, actorId, now],
  );
  await tx.query("UPDATE sites SET updated_at=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, siteId, now]);
}

async function releaseResult(tx: Transaction, tenantId: string, siteId: string, releaseId: string, version: number) {
  const site: SiteRecord = await getSite(tx, tenantId, siteId);
  const release: SiteReleaseRecord | null = await findRelease(tx, tenantId, siteId, releaseId);
  if (!release) throw new TenantDenied();
  return {
    result: { site: { ...site }, release: { ...release } },
    // A projector (or the delivery worker) moves the edge to this version.
    event: { type: "site.edge.changed", payload: { siteId, releaseId, version } },
  };
}

export const createSiteHandler: ActionHandler = {
  // The site does not exist yet: the edge minted its ID from the key, so the target is the tenant's by construction.
  async resolveTarget(_tx, target) {
    if (target.type !== "site") throw new ValidationFailed("Site actions require a site target");
    return { tenantId: target.tenantId, type: "site", id: target.id };
  },
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(createSiteCommandSchema, command);
    const inserted = await tx.query(
      `INSERT INTO sites (tenant_id, id, name, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)
       ON CONFLICT (tenant_id, id) DO NOTHING`,
      [binding.tenantId, payload.siteId, payload.name, now],
    );
    if (inserted.rowCount !== 1) throw new Conflict("Site ID is already in use", { reason: "id_in_use" });
    return { result: { ...(await getSite(tx, binding.tenantId, payload.siteId)) } };
  },
};

export const publishSiteReleaseHandler: ActionHandler = {
  resolveTarget: resolveSite,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(publishSiteReleaseCommandSchema, command);
    const tenantId = binding.tenantId;
    if (await siteReleaseDigest(payload.files) !== payload.digest)
      throw new ValidationFailed("Release digest does not match its files");
    const pointer = await lockSite(tx, tenantId, payload.siteId);
    // The edit started from this live release (null: from no release). Absent: no check.
    if (payload.expectedCurrentReleaseId !== undefined && (pointer?.release_id ?? null) !== payload.expectedCurrentReleaseId)
      throw new Conflict("Another release went live since this edit started", { reason: "stale_release" });
    const totalBytes = payload.files.reduce((sum, file) => sum + file.bytes, 0);
    // The site lock makes max + 1 safe; the unique key rejects a repeat anyway.
    const inserted = await tx.query(
      `INSERT INTO site_releases (tenant_id, id, site_id, number, spec, entry, digest, file_count, total_bytes, created_by, created_at)
       SELECT $1,$2,$3, coalesce((SELECT max(number) FROM site_releases WHERE tenant_id=$1 AND site_id=$3), 0) + 1,
         $4,$5,$6,$7,$8,$9,$10
       ON CONFLICT (tenant_id, id) DO NOTHING`,
      [tenantId, payload.releaseId, payload.siteId, JSON.stringify(payload.spec), payload.entry, payload.digest,
        payload.files.length, totalBytes, binding.actorId, now],
    );
    if (inserted.rowCount !== 1) throw new Conflict("Release ID is already in use", { reason: "id_in_use" });
    await tx.query(
      `INSERT INTO site_release_files (tenant_id, release_id, path, media_type, sha256, bytes)
       SELECT $1, $2, f.path, f.media_type, f.sha256, f.bytes
         FROM unnest($3::text[], $4::text[], $5::text[], $6::int4[]) AS f(path, media_type, sha256, bytes)`,
      [tenantId, payload.releaseId, payload.files.map((f) => f.path), payload.files.map((f) => f.mediaType),
        payload.files.map((f) => f.sha256), payload.files.map((f) => f.bytes)],
    );
    const version = Number(pointer?.version ?? 0) + 1;
    await activate(tx, { tenantId, siteId: payload.siteId, releaseId: payload.releaseId, version, actorId: binding.actorId, now });
    return releaseResult(tx, tenantId, payload.siteId, payload.releaseId, version);
  },
};

export const activateSiteReleaseHandler: ActionHandler = {
  resolveTarget: resolveSite,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(activateSiteReleaseCommandSchema, command);
    const tenantId = binding.tenantId;
    const pointer = await lockSite(tx, tenantId, payload.siteId);
    if ((pointer?.release_id ?? null) !== payload.expectedCurrentReleaseId)
      throw new Conflict("Another release went live since this view was loaded", { reason: "stale_release" });
    if (!await findRelease(tx, tenantId, payload.siteId, payload.releaseId)) throw new NotFound("Release not found");
    const current = Number(pointer?.version ?? 0);
    // Already live: nothing moves, so the edge keeps its version.
    if (pointer?.release_id === payload.releaseId) return releaseResult(tx, tenantId, payload.siteId, payload.releaseId, current);
    await activate(tx, { tenantId, siteId: payload.siteId, releaseId: payload.releaseId, version: current + 1, actorId: binding.actorId, now });
    return releaseResult(tx, tenantId, payload.siteId, payload.releaseId, current + 1);
  },
};

export const siteHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  "site.create": createSiteHandler,
  "site.release.publish": publishSiteReleaseHandler,
  "site.release.activate": activateSiteReleaseHandler,
});
