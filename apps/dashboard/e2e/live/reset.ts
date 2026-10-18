/**
 * Seeded-row snapshot and reset for e2e:live. The snapshot lives in its own schema in the
 * throwaway database (the API's runtime role cannot see it). Resetting removes bookings and
 * customers created after setup and puts every seeded deal back in its seeded stage.
 */
import pg from "pg";
import { THROWAWAY_DATABASE } from "./child-env";

export const SNAPSHOT_SQL = `
  CREATE SCHEMA zs_e2e;
  CREATE TABLE zs_e2e.bookings AS SELECT tenant_id, id FROM public.bookings;
  CREATE TABLE zs_e2e.contacts AS SELECT tenant_id, id FROM public.crm_contacts;
  CREATE TABLE zs_e2e.deals AS SELECT tenant_id, id, stage_id, revision, updated_at FROM public.crm_deals;
`;

export const RESET_SQL = `
  BEGIN;
  DELETE FROM public.bookings b WHERE NOT EXISTS (SELECT 1 FROM zs_e2e.bookings s WHERE s.tenant_id = b.tenant_id AND s.id = b.id);
  DELETE FROM public.crm_deals d WHERE NOT EXISTS (SELECT 1 FROM zs_e2e.deals s WHERE s.tenant_id = d.tenant_id AND s.id = d.id);
  DELETE FROM public.crm_contact_consent c WHERE NOT EXISTS (SELECT 1 FROM zs_e2e.contacts s WHERE s.tenant_id = c.tenant_id AND s.id = c.contact_id);
  DELETE FROM public.crm_contacts c WHERE NOT EXISTS (SELECT 1 FROM zs_e2e.contacts s WHERE s.tenant_id = c.tenant_id AND s.id = c.id);
  UPDATE public.crm_deals d SET stage_id = s.stage_id, revision = s.revision, updated_at = s.updated_at
    FROM zs_e2e.deals s
    WHERE s.tenant_id = d.tenant_id AND s.id = d.id AND (d.stage_id <> s.stage_id OR d.revision <> s.revision);
  COMMIT;
`;

/** Put the seeded rows back. Refuses any database that is not a zs_e2e_* throwaway on loopback. */
export async function resetLiveRows(url = process.env.ZS_LIVE_RESET_DB_URL): Promise<void> {
  if (!url) throw new Error("Run through e2e:live so global setup can pass the reset database");
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || !THROWAWAY_DATABASE.test(parsed.pathname.slice(1))) {
    throw new Error("e2e:live only resets its own zs_e2e_* database on loopback");
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(RESET_SQL);
  } finally {
    await client.end();
  }
}
