// M4b reads. All run in a tenant transaction under the runtime role, so RLS hides other
// tenants' sites; a site ID from another tenant reads as not found.
import {
  NotFound,
  siteFileSchema,
  siteRecordSchema,
  siteReleaseDetailSchema,
  siteReleaseRecordSchema,
  type SiteFile,
  type SiteRecord,
  type SiteReleaseDetail,
  type SiteReleaseRecord,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";

/** At most this many releases per list; a site keeps every release it ever made. */
export const SITE_RELEASE_LIST_LIMIT = 100;
export const SITE_LIST_LIMIT = 100;

const SITE_COLUMNS = `s.id, s.name, p.release_id AS current_release_id, coalesce(p.version, 0)::int8 AS pointer_version,
  array(SELECT h.host FROM site_hosts h WHERE h.tenant_id=s.tenant_id AND h.site_id=s.id ORDER BY h.host) AS hosts,
  s.created_at, s.updated_at`;
const SITE_FROM = "sites s LEFT JOIN site_pointers p ON p.tenant_id=s.tenant_id AND p.site_id=s.id";

interface SiteRow {
  id: string; name: string; current_release_id: string | null; pointer_version: string;
  hosts: string[]; created_at: Date; updated_at: Date;
}
const siteRecord = (row: SiteRow): SiteRecord => siteRecordSchema.parse({
  id: row.id, name: row.name, currentReleaseId: row.current_release_id,
  pointerVersion: Number(row.pointer_version), hosts: row.hosts,
  createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
});

export async function findSite(tx: Transaction, tenantId: string, siteId: string): Promise<SiteRecord | null> {
  const row = (await tx.query<SiteRow>(`SELECT ${SITE_COLUMNS} FROM ${SITE_FROM} WHERE s.tenant_id=$1 AND s.id=$2`, [tenantId, siteId])).rows[0];
  return row ? siteRecord(row) : null;
}
export async function getSite(tx: Transaction, tenantId: string, siteId: string): Promise<SiteRecord> {
  const site = await findSite(tx, tenantId, siteId);
  if (!site) throw new NotFound();
  return site;
}
export async function listSites(tx: Transaction, tenantId: string): Promise<SiteRecord[]> {
  return (await tx.query<SiteRow>(
    `SELECT ${SITE_COLUMNS} FROM ${SITE_FROM} WHERE s.tenant_id=$1 ORDER BY s.created_at, s.id LIMIT ${SITE_LIST_LIMIT}`, [tenantId],
  )).rows.map(siteRecord);
}

const RELEASE_COLUMNS = "id, site_id, number, entry, digest, file_count, total_bytes, created_by, created_at";
interface ReleaseRow {
  id: string; site_id: string; number: number; entry: string; digest: string; file_count: number;
  total_bytes: string; created_by: string; created_at: Date;
}
const releaseRecord = (row: ReleaseRow): SiteReleaseRecord => siteReleaseRecordSchema.parse({
  id: row.id, siteId: row.site_id, number: row.number, entry: row.entry, digest: row.digest, fileCount: row.file_count,
  totalBytes: Number(row.total_bytes), createdBy: row.created_by, createdAt: row.created_at.toISOString(),
});

export async function findRelease(tx: Transaction, tenantId: string, siteId: string, releaseId: string): Promise<SiteReleaseRecord | null> {
  const row = (await tx.query<ReleaseRow>(
    `SELECT ${RELEASE_COLUMNS} FROM site_releases WHERE tenant_id=$1 AND site_id=$2 AND id=$3`, [tenantId, siteId, releaseId],
  )).rows[0];
  return row ? releaseRecord(row) : null;
}
/** Newest first: the highest release number first. */
export async function listReleases(tx: Transaction, tenantId: string, siteId: string): Promise<SiteReleaseRecord[]> {
  await getSite(tx, tenantId, siteId);
  return (await tx.query<ReleaseRow>(
    `SELECT ${RELEASE_COLUMNS} FROM site_releases WHERE tenant_id=$1 AND site_id=$2
      ORDER BY number DESC LIMIT ${SITE_RELEASE_LIST_LIMIT}`, [tenantId, siteId],
  )).rows.map(releaseRecord);
}

export async function loadReleaseFiles(tx: Transaction, tenantId: string, releaseId: string): Promise<SiteFile[]> {
  return (await tx.query<{ path: string; media_type: string; sha256: string; bytes: number }>(
    // COLLATE "C": byte order, the order the manifest and the digest use.
    `SELECT path, media_type, sha256, bytes FROM site_release_files WHERE tenant_id=$1 AND release_id=$2 ORDER BY path COLLATE "C"`,
    [tenantId, releaseId],
  )).rows.map((row) => siteFileSchema.parse({ path: row.path, mediaType: row.media_type, sha256: row.sha256, bytes: row.bytes }));
}

/** One release with the spec it was built from and its files. */
export async function getRelease(tx: Transaction, tenantId: string, siteId: string, releaseId: string): Promise<SiteReleaseDetail> {
  const release = await findRelease(tx, tenantId, siteId, releaseId);
  if (!release) throw new NotFound();
  const spec = (await tx.query<{ spec: Record<string, unknown> }>(
    "SELECT spec FROM site_releases WHERE tenant_id=$1 AND id=$2", [tenantId, releaseId],
  )).rows[0]!.spec;
  return siteReleaseDetailSchema.parse({ ...release, spec, files: await loadReleaseFiles(tx, tenantId, releaseId) });
}
