-- Company enrichment with Treg (docs/requirements/enrichment.md E-1..E-18, crm.md revision for the
-- contact profile). Three tenant tables: tenant_id, tenant FK, forced RLS with the shared tenant_scope
-- policy. Requests are created by the enrichment.request action through the dispatcher; the worker
-- (service role) moves them and records results; the profile is written by the apply, block and
-- attest actions. A contact's deletion cascades to all three.

-- crm.md revision (E-14): one profile row per contact. The eight company fields are filled only by an
-- approved contact.profile.apply; country, the do-not-enrich flag and the owner's region mark are
-- set by their own actions. Enrichment never writes crm_contacts or consent (crm.md C-9).
CREATE TABLE public.crm_contact_profile (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  contact_id uuid NOT NULL,
  company_name text CONSTRAINT crm_contact_profile_company_name CHECK (char_length(company_name) BETWEEN 1 AND 200),
  company_domain text CONSTRAINT crm_contact_profile_company_domain CHECK (char_length(company_domain) BETWEEN 1 AND 253),
  company_industry text CONSTRAINT crm_contact_profile_company_industry CHECK (char_length(company_industry) BETWEEN 1 AND 200),
  company_description text CONSTRAINT crm_contact_profile_company_description CHECK (char_length(company_description) BETWEEN 1 AND 1000),
  company_employees integer CONSTRAINT crm_contact_profile_company_employees CHECK (company_employees >= 0),
  company_founded integer CONSTRAINT crm_contact_profile_company_founded CHECK (company_founded BETWEEN 1000 AND 9999),
  company_location text CONSTRAINT crm_contact_profile_company_location CHECK (char_length(company_location) BETWEEN 1 AND 200),
  company_linkedin_url text CONSTRAINT crm_contact_profile_company_linkedin CHECK (
    char_length(company_linkedin_url) <= 300 AND company_linkedin_url ~ '^https://([a-z0-9-]+\.)?linkedin\.com/company/[^[:space:]]+$'),
  -- E-7, E-13: an ISO 3166-1 alpha-2 code the owner or a result's location gave.
  country text CONSTRAINT crm_contact_profile_country CHECK (country ~ '^[A-Z]{2}$'),
  -- E-6: set with a reason, cleared with both.
  do_not_enrich_at timestamptz,
  do_not_enrich_reason text CONSTRAINT crm_contact_profile_reason CHECK (char_length(do_not_enrich_reason) BETWEEN 1 AND 200),
  -- E-7: the owner says this contact is outside the EU, EEA and UK.
  outside_eu_uk_attested_by uuid,
  outside_eu_uk_attested_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CONSTRAINT crm_contact_profile_revision CHECK (revision >= 1),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, contact_id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES public.crm_contacts(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT crm_contact_profile_block_pair CHECK ((do_not_enrich_at IS NULL) = (do_not_enrich_reason IS NULL)),
  CONSTRAINT crm_contact_profile_attest_pair CHECK ((outside_eu_uk_attested_by IS NULL) = (outside_eu_uk_attested_at IS NULL))
);

-- E-4, E-10..E-12: one request is one Treg call (retried under one key). The domain and price are what
-- the first attempt sent, and every retry repeats them. The worker owns every column but the first
-- block; the runtime role inserts a request and reads.
CREATE TABLE public.enrichment_requests (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  contact_id uuid NOT NULL,
  op text NOT NULL DEFAULT 'company.enrich' CONSTRAINT enrichment_requests_op CHECK (op = 'company.enrich'),
  domain text NOT NULL CONSTRAINT enrichment_requests_domain CHECK (
    char_length(domain) BETWEEN 1 AND 253 AND domain ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'),
  price_cents integer NOT NULL CONSTRAINT enrichment_requests_price CHECK (price_cents > 0),
  status text NOT NULL DEFAULT 'pending' CONSTRAINT enrichment_requests_status CHECK (status IN (
    'pending', 'leased', 'uncertain', 'succeeded', 'no_match', 'rejected', 'failed', 'blocked',
    'insufficient_funds', 'daily_cap', 'answer_lost', 'region_blocked_after_call', 'dead')),
  -- Why a request ended without a hit (a tenant-safe code), or why the last attempt did not settle.
  final_reason text CONSTRAINT enrichment_requests_final_reason CHECK (char_length(final_reason) BETWEEN 1 AND 200),
  attempts integer NOT NULL DEFAULT 0 CONSTRAINT enrichment_requests_attempts CHECK (attempts >= 0),
  -- True from the moment a call may have left until a definite answer (as message_deliveries).
  outcome_unknown boolean NOT NULL DEFAULT false,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL,
  lease_token uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  provider text CONSTRAINT enrichment_requests_provider CHECK (char_length(provider) BETWEEN 1 AND 100),
  treg_call_id text CONSTRAINT enrichment_requests_call_id CHECK (char_length(treg_call_id) BETWEEN 1 AND 200),
  treg_cost_micro bigint CONSTRAINT enrichment_requests_cost CHECK (treg_cost_micro >= 0),
  last_error text CONSTRAINT enrichment_requests_last_error CHECK (char_length(last_error) BETWEEN 1 AND 200),
  step_errors integer NOT NULL DEFAULT 0 CONSTRAINT enrichment_requests_step_errors CHECK (step_errors >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES public.crm_contacts(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT enrichment_requests_lease_state CHECK ((status = 'leased') = (lease_token IS NOT NULL))
);
CREATE INDEX enrichment_requests_contact ON public.enrichment_requests (tenant_id, contact_id, created_at DESC);
-- E-9: the tenant's requests of one UTC day, counted under a tenant-keyed lock.
CREATE INDEX enrichment_requests_tenant_day ON public.enrichment_requests (tenant_id, created_at);
-- E-9: requests whose first attempt started in one UTC day, across tenants, for the global cap.
CREATE INDEX enrichment_requests_first_attempt ON public.enrichment_requests (first_attempt_at)
  WHERE first_attempt_at IS NOT NULL;
-- E-10: the worker's claim.
CREATE INDEX enrichment_requests_due ON public.enrichment_requests (next_attempt_at, id)
  WHERE status IN ('pending', 'uncertain');
CREATE INDEX enrichment_requests_leased ON public.enrichment_requests (lease_expires_at) WHERE status = 'leased';

-- E-13: one immutable row per kept field. The purge (E-15) deletes rows past expires_at; applied values
-- live on in crm_contact_profile with their source record.
CREATE TABLE public.enrichment_results (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  request_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  field text NOT NULL CONSTRAINT enrichment_results_field CHECK (field IN (
    'name', 'domain', 'industry', 'description', 'employees', 'founded', 'location', 'linkedin_url')),
  value text NOT NULL CONSTRAINT enrichment_results_value CHECK (char_length(value) BETWEEN 1 AND 1000),
  provider text NOT NULL CONSTRAINT enrichment_results_provider CHECK (char_length(provider) BETWEEN 1 AND 100),
  treg_call_id text NOT NULL CONSTRAINT enrichment_results_call_id CHECK (char_length(treg_call_id) BETWEEN 1 AND 200),
  -- E-14: the approval that proposes this field. Set in the transaction that inserts the row.
  approval_id uuid,
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES public.enrichment_requests(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES public.crm_contacts(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT enrichment_results_request_field UNIQUE (tenant_id, request_id, field),
  CONSTRAINT enrichment_results_expiry CHECK (expires_at > fetched_at)
);
CREATE INDEX enrichment_results_contact ON public.enrichment_results (tenant_id, contact_id, fetched_at DESC);
CREATE INDEX enrichment_results_expiry ON public.enrichment_results (expires_at);

ALTER TABLE public.crm_contact_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_contact_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.crm_contact_profile TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE public.enrichment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enrichment_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.enrichment_requests TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE public.enrichment_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enrichment_results FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.enrichment_results TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);

REVOKE ALL ON public.crm_contact_profile, public.enrichment_requests, public.enrichment_results
  FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.crm_contact_profile, public.enrichment_requests, public.enrichment_results FROM anon;
  END IF;
END $$;

-- Service role: the worker moves requests and records results; the purge deletes expired results. A
-- result row is never updated (E-13).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_contact_profile TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.enrichment_requests TO service_role;
GRANT SELECT, INSERT, DELETE ON public.enrichment_results TO service_role;
-- Runtime: reads everywhere; inserts a request (the worker owns every later change); writes the
-- profile through the apply, block and attest actions. Results and request state are never written by it.
GRANT SELECT ON public.crm_contact_profile, public.enrichment_requests, public.enrichment_results TO authenticated;
GRANT INSERT, UPDATE ON public.crm_contact_profile TO authenticated;
GRANT INSERT (tenant_id, id, contact_id, op, domain, price_cents, next_attempt_at, created_at, updated_at)
  ON public.enrichment_requests TO authenticated;

-- E-7 (crm.md revision): a change to the contact's email or phone clears the owner's region mark, so
-- the mark never outlives the facts it was made on. Invoker function; the runtime role holds UPDATE
-- on the profile and the tenant policy keeps it to the tenant in context.
CREATE FUNCTION public.crm_contacts_clear_region_attest() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE public.crm_contact_profile
     SET outside_eu_uk_attested_by = NULL, outside_eu_uk_attested_at = NULL, revision = revision + 1
   WHERE tenant_id = NEW.tenant_id AND contact_id = NEW.id AND outside_eu_uk_attested_at IS NOT NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER crm_contacts_clear_region_attest
  AFTER UPDATE OF normalized_email, e164_phone ON public.crm_contacts
  FOR EACH ROW WHEN (NEW.normalized_email IS DISTINCT FROM OLD.normalized_email OR NEW.e164_phone IS DISTINCT FROM OLD.e164_phone)
  EXECUTE FUNCTION public.crm_contacts_clear_region_attest();
REVOKE ALL ON FUNCTION public.crm_contacts_clear_region_attest() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.crm_contacts_clear_region_attest() FROM anon;
  END IF;
END $$;
-- Same owner as every invoker function (20261018090000); CREATE only for the transfer.
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.crm_contacts_clear_region_attest() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;
