-- Industry templates (docs/requirements/industry-templates.md IT-3, IT-4, IT-11).
-- A tenant applies one template once; the setup row records which, and what it created.

CREATE TABLE public.tenant_setups (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(tenant_id),
  template_id text NOT NULL
    CONSTRAINT tenant_setups_template_id CHECK (template_id IN ('jewelry', 'crafts', 'agency', 'fitness')),
  template_version integer NOT NULL CONSTRAINT tenant_setups_template_version CHECK (template_version >= 1),
  -- The dispatcher writes the action row after the handler, so the check waits for commit.
  action_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  booking_page_id uuid NOT NULL,
  applied_at timestamptz NOT NULL,
  CONSTRAINT tenant_setups_action_fk FOREIGN KEY (tenant_id, action_id)
    REFERENCES public.actions(tenant_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT tenant_setups_pipeline_fk FOREIGN KEY (tenant_id, pipeline_id)
    REFERENCES public.crm_pipelines(tenant_id, id),
  CONSTRAINT tenant_setups_resource_fk FOREIGN KEY (tenant_id, resource_id)
    REFERENCES public.booking_resources(tenant_id, id),
  CONSTRAINT tenant_setups_page_fk FOREIGN KEY (tenant_id, booking_page_id)
    REFERENCES public.booking_pages(tenant_id, id)
);

ALTER TABLE public.tenant_setups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_setups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.tenant_setups TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON public.tenant_setups FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.tenant_setups FROM anon;
  END IF;
END $$;
-- Written once, never changed: no role may UPDATE or DELETE it.
GRANT SELECT, INSERT ON public.tenant_setups TO authenticated, service_role;

-- IT-9: tenant:create (owner-run, service_role) stores the owner email it was started for, so a run
-- resumed after a crash with another email refuses. Nothing at runtime reads or writes it.
ALTER TABLE public.tenants ADD COLUMN provisioning_owner_email text
  CONSTRAINT tenants_provisioning_owner_email_shape CHECK (
    provisioning_owner_email IS NULL
    OR (length(provisioning_owner_email) BETWEEN 3 AND 320 AND provisioning_owner_email = lower(provisioning_owner_email)));

-- IT-4: the apply action writes these as the runtime role, under each table's forced
-- tenant_scope policy (FOR ALL, so it also scopes the column UPDATE grants).
GRANT INSERT ON public.crm_pipelines, public.crm_stages, public.booking_resources, public.booking_pages,
  public.booking_page_resources, public.message_templates, public.message_template_revisions TO authenticated;
-- The disclosure trigger runs as the invoker and records the page's first disclosure version.
GRANT INSERT ON public.booking_page_disclosures TO authenticated;
-- The confirmed zone: UPDATE (time_zone, revision, updated_by, updated_at) on business_profiles
-- is already granted by 20261023100000_business_profiles.sql under its tenant_scope policy. Not
-- restated here: a migration test replays history without that file, and this one must still apply.
-- IT-11: a page goes live or off line; nothing else on it changes.
GRANT UPDATE (published) ON public.booking_pages TO authenticated;
