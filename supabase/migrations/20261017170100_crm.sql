-- F2 CRM transaction slice (docs/requirements/crm.md C-20, C-21, C-24).
-- Every relationship includes tenant_id; every table forces RLS. Runtime writes go
-- through the dispatcher; history stays behind record_action_and_event.

DO $$ BEGIN
  CREATE TYPE public.crm_consent_channel AS ENUM ('email', 'sms');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE public.crm_consent_status AS ENUM ('granted', 'denied');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE public.crm_contacts (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  display_name text CONSTRAINT crm_contacts_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 200),
  -- The default only applies when an INSERT omits the column entirely (the catalog
  -- isolation fixture does). Application writes always list both identity columns.
  -- It is a unique, syntactically valid address on the reserved .invalid TLD.
  normalized_email text DEFAULT ('unset-' || gen_random_uuid()::text || '@placeholder.invalid')
    CONSTRAINT crm_contacts_email_canonical CHECK (
      char_length(normalized_email) <= 254
      AND normalized_email = lower(normalized_email)
      AND normalized_email ~ '^(?!\.)(?!.*\.\.)[a-z0-9_''+.-]*[a-z0-9_+-]@([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}$'
    ),
  e164_phone text CONSTRAINT crm_contacts_phone_e164 CHECK (e164_phone ~ '^\+[1-9][0-9]{1,14}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT crm_contacts_identity_required CHECK (normalized_email IS NOT NULL OR e164_phone IS NOT NULL)
);
CREATE UNIQUE INDEX crm_contacts_tenant_email ON public.crm_contacts (tenant_id, normalized_email)
  WHERE normalized_email IS NOT NULL;
CREATE UNIQUE INDEX crm_contacts_tenant_phone ON public.crm_contacts (tenant_id, e164_phone)
  WHERE e164_phone IS NOT NULL;

CREATE TABLE public.crm_contact_consent (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  contact_id uuid NOT NULL,
  channel public.crm_consent_channel NOT NULL,
  status public.crm_consent_status NOT NULL,
  source text NOT NULL CONSTRAINT crm_contact_consent_source_length CHECK (char_length(source) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, contact_id, channel),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES public.crm_contacts(tenant_id, id)
);

CREATE TABLE public.crm_pipelines (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  name text NOT NULL CONSTRAINT crm_pipelines_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE public.crm_stages (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  name text NOT NULL CONSTRAINT crm_stages_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  position integer NOT NULL CONSTRAINT crm_stages_position_nonnegative CHECK (position >= 0),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT crm_stages_pipeline_member UNIQUE (tenant_id, pipeline_id, id),
  CONSTRAINT crm_stages_pipeline_position UNIQUE (tenant_id, pipeline_id, position),
  FOREIGN KEY (tenant_id, pipeline_id) REFERENCES public.crm_pipelines(tenant_id, id)
);

CREATE TABLE public.crm_deals (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  contact_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  title text NOT NULL CONSTRAINT crm_deals_title_length CHECK (char_length(title) BETWEEN 1 AND 200),
  revision bigint NOT NULL CONSTRAINT crm_deals_revision_range CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES public.crm_contacts(tenant_id, id),
  FOREIGN KEY (tenant_id, pipeline_id) REFERENCES public.crm_pipelines(tenant_id, id),
  FOREIGN KEY (tenant_id, pipeline_id, stage_id) REFERENCES public.crm_stages(tenant_id, pipeline_id, id)
);
CREATE INDEX crm_deals_tenant_contact ON public.crm_deals (tenant_id, contact_id);
CREATE INDEX crm_deals_tenant_stage ON public.crm_deals (tenant_id, pipeline_id, stage_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['crm_contacts','crm_contact_consent','crm_pipelines','crm_stages','crm_deals'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO authenticated
      USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$p$, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, authenticated, service_role', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
  END LOOP;
END $$;
REVOKE ALL ON TYPE public.crm_consent_channel, public.crm_consent_status FROM PUBLIC;
GRANT USAGE ON TYPE public.crm_consent_channel, public.crm_consent_status TO authenticated, service_role;

-- Runtime: read configuration, write only the mutable columns the three actions touch.
-- Pipelines and stages are provisioned by future actions or service-role setup.
GRANT SELECT ON public.crm_pipelines, public.crm_stages TO authenticated;
GRANT SELECT, INSERT ON public.crm_contacts, public.crm_contact_consent, public.crm_deals TO authenticated;
GRANT UPDATE (display_name, normalized_email, e164_phone, updated_at) ON public.crm_contacts TO authenticated;
GRANT UPDATE (status, source, recorded_at) ON public.crm_contact_consent TO authenticated;
GRANT UPDATE (stage_id, revision, updated_at) ON public.crm_deals TO authenticated;
