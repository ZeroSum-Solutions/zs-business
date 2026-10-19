-- M3a public intake (docs/requirements/public-intake.md P-13): booking pages, intake items
-- and their consent, and the website source on bookings. Every relationship includes
-- tenant_id; every table forces RLS. Runtime writes go through the dispatcher.

CREATE TABLE public.booking_pages (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  title text NOT NULL CONSTRAINT booking_pages_title_length CHECK (char_length(title) BETWEEN 1 AND 200),
  description text CONSTRAINT booking_pages_description_length CHECK (char_length(description) BETWEEN 1 AND 2000),
  published boolean NOT NULL DEFAULT false,
  disclosure_version text NOT NULL DEFAULT 'v1'
    CONSTRAINT booking_pages_disclosure_version_length CHECK (char_length(disclosure_version) BETWEEN 1 AND 50),
  disclosure_text text NOT NULL DEFAULT 'We may send you occasional updates. You can opt out at any time.'
    CONSTRAINT booking_pages_disclosure_text_length CHECK (char_length(disclosure_text) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- P-8: a disclosure version names one text. Changing the text without a new version would
-- let consent given against version N be read as agreement to words the visitor never saw,
-- so the text is immutable per version.
CREATE FUNCTION public.booking_pages_disclosure_versioned() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.disclosure_text IS DISTINCT FROM OLD.disclosure_text
     AND NEW.disclosure_version IS NOT DISTINCT FROM OLD.disclosure_version THEN
    RAISE EXCEPTION 'A changed disclosure text needs a new disclosure version'
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'booking_pages',
        COLUMN = 'disclosure_text', CONSTRAINT = 'booking_pages_disclosure_versioned';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER booking_pages_disclosure_versioned
  BEFORE UPDATE OF disclosure_text, disclosure_version ON public.booking_pages
  FOR EACH ROW EXECUTE FUNCTION public.booking_pages_disclosure_versioned();
REVOKE ALL ON FUNCTION public.booking_pages_disclosure_versioned() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.booking_pages_disclosure_versioned() FROM anon;
  END IF;
END $$;
-- Same owner as every invoker function (20261018090000); CREATE only for the transfer.
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.booking_pages_disclosure_versioned() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;

CREATE TABLE public.booking_page_resources (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  page_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  position integer NOT NULL DEFAULT 0 CONSTRAINT booking_page_resources_position CHECK (position >= 0),
  PRIMARY KEY (tenant_id, page_id, resource_id),
  FOREIGN KEY (tenant_id, page_id) REFERENCES public.booking_pages(tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES public.booking_resources(tenant_id, id)
);

CREATE TABLE public.intake_items (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'booking_request' CONSTRAINT intake_items_kind CHECK (kind IN ('booking_request')),
  status text NOT NULL DEFAULT 'possible_match'
    CONSTRAINT intake_items_status CHECK (status IN ('new_contact', 'possible_match', 'linked', 'rejected')),
  channel text NOT NULL DEFAULT 'booking_page' CONSTRAINT intake_items_channel CHECK (channel IN ('booking_page', 'widget')),
  page_id uuid NOT NULL,
  submitted_name text NOT NULL CONSTRAINT intake_items_name_length CHECK (char_length(submitted_name) BETWEEN 1 AND 200),
  -- As on crm_contacts: the default only applies when an INSERT omits the column (the
  -- catalog isolation fixture does). The intake handler always supplies the address.
  submitted_email text NOT NULL DEFAULT ('unset-' || gen_random_uuid()::text || '@placeholder.invalid')
    CONSTRAINT intake_items_email_canonical CHECK (
      char_length(submitted_email) <= 254
      AND submitted_email = lower(submitted_email)
      AND submitted_email ~ '^(?!\.)(?!.*\.\.)[a-z0-9_''+.-]*[a-z0-9_+-]@([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}$'
    ),
  submitted_phone text CONSTRAINT intake_items_phone_e164 CHECK (submitted_phone ~ '^\+[1-9][0-9]{1,14}$'),
  notes text CONSTRAINT intake_items_notes_length CHECK (char_length(notes) BETWEEN 1 AND 1000),
  matched_contact_ids uuid[] NOT NULL DEFAULT '{}',
  contact_id uuid,
  reviewed_at timestamptz,
  reviewed_by uuid,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, page_id) REFERENCES public.booking_pages(tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES public.crm_contacts(tenant_id, id),
  -- new_contact and linked name their contact; possible_match and rejected have none yet.
  CONSTRAINT intake_items_contact_state CHECK (
    (status IN ('new_contact', 'linked')) = (contact_id IS NOT NULL)),
  CONSTRAINT intake_items_review_state CHECK (
    (status IN ('linked', 'rejected')) = (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL))
);
CREATE INDEX intake_items_tenant_status ON public.intake_items (tenant_id, status, created_at DESC);

CREATE TABLE public.intake_item_consent (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  intake_item_id uuid NOT NULL,
  channel public.crm_consent_channel NOT NULL,
  status public.crm_consent_status NOT NULL,
  purpose text NOT NULL CONSTRAINT intake_item_consent_purpose_length CHECK (char_length(purpose) BETWEEN 1 AND 100),
  disclosure_version text NOT NULL
    CONSTRAINT intake_item_consent_disclosure_length CHECK (char_length(disclosure_version) BETWEEN 1 AND 50),
  -- The exact text shown with that version (P-8), so the evidence never depends on the page row.
  disclosure_text text NOT NULL
    CONSTRAINT intake_item_consent_disclosure_text_length CHECK (char_length(disclosure_text) BETWEEN 1 AND 2000),
  source text NOT NULL CONSTRAINT intake_item_consent_source_length CHECK (char_length(source) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, intake_item_id, channel),
  FOREIGN KEY (tenant_id, intake_item_id) REFERENCES public.intake_items(tenant_id, id)
);

-- Website bookings name the intake item that holds the visitor's details (P-9). Both
-- columns are optional for B-28 inserts: the defaults describe an owner booking.
ALTER TABLE public.bookings ADD COLUMN source text NOT NULL DEFAULT 'owner'
  CONSTRAINT bookings_source CHECK (source IN ('owner', 'website'));
ALTER TABLE public.bookings ADD COLUMN intake_item_id uuid;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_intake_item_fk
  FOREIGN KEY (tenant_id, intake_item_id) REFERENCES public.intake_items(tenant_id, id);
ALTER TABLE public.bookings ADD CONSTRAINT bookings_source_intake
  CHECK ((source = 'website') = (intake_item_id IS NOT NULL));
CREATE INDEX bookings_tenant_intake_item ON public.bookings (tenant_id, intake_item_id)
  WHERE intake_item_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['booking_pages','booking_page_resources','intake_items','intake_item_consent'] LOOP
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

-- Runtime: read pages, record intake, and change only the review columns of an item.
GRANT SELECT ON public.booking_pages, public.booking_page_resources TO authenticated;
GRANT SELECT, INSERT ON public.intake_items, public.intake_item_consent TO authenticated;
GRANT UPDATE (status, contact_id, reviewed_at, reviewed_by) ON public.intake_items TO authenticated;
