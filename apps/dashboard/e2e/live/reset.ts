/**
 * Seeded-row snapshot and reset for e2e:live. The snapshot lives in its own schema in the
 * throwaway database (the API's runtime role cannot see it). Resetting removes inbox replies,
 * bookings, website requests, customers and consent created after setup and puts every seeded
 * deal back in its seeded stage, with its seeded value and lead source (the won date follows
 * the stage, inbox-home.md H-2).
 */
import pg from "pg";
import { THROWAWAY_DATABASE } from "./child-env";

export const SNAPSHOT_SQL = `
  CREATE SCHEMA zs_e2e;
  CREATE TABLE zs_e2e.bookings AS SELECT tenant_id, id FROM public.bookings;
  CREATE TABLE zs_e2e.contacts AS SELECT tenant_id, id FROM public.crm_contacts;
  CREATE TABLE zs_e2e.consent AS SELECT tenant_id, contact_id, channel FROM public.crm_contact_consent;
  CREATE TABLE zs_e2e.deals AS SELECT tenant_id, id, stage_id, revision, updated_at, value_minor, currency, lead_source FROM public.crm_deals;
`;

export const RESET_SQL = `
  BEGIN;
  DELETE FROM public.inbox_replies;
  DELETE FROM public.bookings b WHERE NOT EXISTS (SELECT 1 FROM zs_e2e.bookings s WHERE s.tenant_id = b.tenant_id AND s.id = b.id);
  DELETE FROM public.intake_item_consent;
  DELETE FROM public.intake_items;
  DELETE FROM public.crm_deals d WHERE NOT EXISTS (SELECT 1 FROM zs_e2e.deals s WHERE s.tenant_id = d.tenant_id AND s.id = d.id);
  DELETE FROM public.crm_contact_consent c
    WHERE NOT EXISTS (SELECT 1 FROM zs_e2e.consent s WHERE s.tenant_id = c.tenant_id AND s.contact_id = c.contact_id AND s.channel = c.channel);
  DELETE FROM public.crm_contacts c WHERE NOT EXISTS (SELECT 1 FROM zs_e2e.contacts s WHERE s.tenant_id = c.tenant_id AND s.id = c.id);
  UPDATE public.crm_deals d SET stage_id = s.stage_id, revision = s.revision, updated_at = s.updated_at,
         value_minor = s.value_minor, currency = s.currency, lead_source = s.lead_source
    FROM zs_e2e.deals s
    WHERE s.tenant_id = d.tenant_id AND s.id = d.id AND (d.stage_id <> s.stage_id OR d.revision <> s.revision
      OR d.value_minor IS DISTINCT FROM s.value_minor OR d.currency IS DISTINCT FROM s.currency OR d.lead_source IS DISTINCT FROM s.lead_source);
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
