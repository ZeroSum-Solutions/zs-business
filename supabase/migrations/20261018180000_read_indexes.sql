-- Read paths (audit W8): each list orders and filters on these columns, so a page is an
-- index range scan instead of a sort of the whole tenant. Plain CREATE INDEX: the runner
-- applies migrations in one transaction, and pilot tables are small enough for the lock.

-- GET /v1/crm/contacts: newest first (the default), or by name for the dashboard list.
-- The name expression must stay identical to the ORDER BY in packages/core/src/reads/crm.ts.
CREATE INDEX crm_contacts_tenant_recent ON public.crm_contacts (tenant_id, created_at DESC, id);
CREATE INDEX crm_contacts_tenant_name ON public.crm_contacts
  (tenant_id, lower(coalesce(display_name, normalized_email, e164_phone)), id);

-- GET /v1/crm/deals: most recently updated first, for the tenant or one pipeline. One contact's
-- deals use crm_deals_tenant_contact.
CREATE INDEX crm_deals_tenant_recent ON public.crm_deals (tenant_id, updated_at DESC, id);
CREATE INDEX crm_deals_tenant_pipeline_recent ON public.crm_deals (tenant_id, pipeline_id, updated_at DESC, id);

-- GET /v1/booking/bookings in start order: a range is a starts_at range on these, plus the latest
-- booking before it per resource (see listBookings). RLS keeps the planner from using range
-- operators on the occupied-range exclusion index, so ranged reads need btree columns.
CREATE INDEX bookings_tenant_resource_start ON public.bookings (tenant_id, resource_id, starts_at, id);
CREATE INDEX bookings_tenant_start ON public.bookings (tenant_id, starts_at, id);
