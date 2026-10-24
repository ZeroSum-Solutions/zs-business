-- Document intake (docs/requirements/document-intake.md DL-1..DL-16), first slice: catalog target.
-- Four tenant tables, each with tenant_id, tenant FK and forced RLS with the shared tenant_scope policy:
--  * catalog_items and knowledge_entries: the first catalog tables, minimal on purpose. Only the apply
--    action writes them (DL-2); the runtime role has no DELETE (an item retires with active = false).
--  * document_intake_jobs: the queue the Docling worker pulls, and the state the owner reviews (DL-4).
--  * document_intake_rows: one row per extracted table row, with page, box and snippet (DL-11, DL-12).
-- The worker serves every tenant, so its claim runs in the platform transaction (db.platform) as the
-- transcription queue does; the tenant of every later call comes from the job row.

CREATE TYPE public.intake_target_kind AS ENUM ('catalog', 'knowledge');
CREATE TYPE public.intake_job_status AS ENUM ('queued', 'claimed', 'review', 'applied', 'discarded', 'failed');
CREATE TYPE public.intake_diff_op AS ENUM ('insert', 'update', 'unchanged', 'invalid');

-- DL-14: the apply records a source record per written row, for these two subjects. The new labels
-- cannot be used in this file; the apply handler uses them after this migration commits.
ALTER TYPE public.source_subject_type ADD VALUE IF NOT EXISTS 'catalog_item';
ALTER TYPE public.source_subject_type ADD VALUE IF NOT EXISTS 'knowledge_entry';

-- DL-1: attributes are a flat map of string values with at most 30 keys. A CHECK cannot hold a subquery,
-- so the test is a function.
CREATE FUNCTION public.catalog_attributes_valid(attrs jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT attrs IS NOT NULL AND jsonb_typeof(attrs) = 'object'
    AND (SELECT count(*) FROM jsonb_each(attrs)) <= 30
    AND NOT EXISTS (SELECT 1 FROM jsonb_each(attrs) e WHERE jsonb_typeof(e.value) <> 'string')
$$;

-- DL-1: a catalog item. attributes is a flat string map of at most 30 keys (the contract checks the
-- values; the database checks the shape).
CREATE TABLE public.catalog_items (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  sku text NOT NULL CONSTRAINT catalog_items_sku CHECK (char_length(sku) BETWEEN 1 AND 64 AND btrim(sku) <> ''),
  title text NOT NULL CONSTRAINT catalog_items_title CHECK (char_length(title) BETWEEN 1 AND 300 AND btrim(title) <> ''),
  description text NOT NULL DEFAULT '' CONSTRAINT catalog_items_description CHECK (char_length(description) <= 2000),
  price_minor bigint NOT NULL CONSTRAINT catalog_items_price CHECK (price_minor BETWEEN 0 AND 1000000000000),
  currency text NOT NULL DEFAULT 'USD' CONSTRAINT catalog_items_currency CHECK (currency ~ '^[A-Z]{3}$'),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb CONSTRAINT catalog_items_attributes CHECK (public.catalog_attributes_valid(attributes)),
  active boolean NOT NULL DEFAULT true,
  -- DL-2: starts at 1; every update adds exactly one (trigger below).
  revision integer NOT NULL DEFAULT 1 CONSTRAINT catalog_items_revision CHECK (revision >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT catalog_items_sku_unique UNIQUE (tenant_id, sku),
  CONSTRAINT catalog_items_updated_after_created CHECK (updated_at >= created_at)
);

-- DL-1: an agent knowledge entry. No action writes it in the first slice (the knowledge target is the
-- next slice); the table exists so the contract's shape and isolation are in place.
CREATE TABLE public.knowledge_entries (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  slug text NOT NULL CONSTRAINT knowledge_entries_slug CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  section_title text NOT NULL CONSTRAINT knowledge_entries_section_title CHECK (char_length(section_title) BETWEEN 1 AND 300),
  body_text text NOT NULL CONSTRAINT knowledge_entries_body CHECK (char_length(body_text) <= 20000),
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CONSTRAINT knowledge_entries_revision CHECK (revision >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT knowledge_entries_slug_unique UNIQUE (tenant_id, slug),
  CONSTRAINT knowledge_entries_updated_after_created CHECK (updated_at >= created_at)
);

-- DL-1, DL-3, DL-4, DL-5: one uploaded PDF and its life from queue to review to applied.
CREATE TABLE public.document_intake_jobs (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  target_kind public.intake_target_kind NOT NULL DEFAULT 'catalog',
  -- DL-3: 'upload', or 'browser:<runId>' when the owner sends a browser-task artifact (a later slice).
  source text NOT NULL DEFAULT 'upload' CONSTRAINT document_intake_jobs_source CHECK (
    source = 'upload' OR source ~ '^browser:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  -- DL-3: display text only.
  filename text NOT NULL CONSTRAINT document_intake_jobs_filename CHECK (char_length(filename) BETWEEN 1 AND 200),
  file_sha256 text NOT NULL CONSTRAINT document_intake_jobs_sha CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  byte_length integer NOT NULL CONSTRAINT document_intake_jobs_bytes CHECK (byte_length BETWEEN 1 AND 20971520),
  page_count integer CONSTRAINT document_intake_jobs_pages CHECK (page_count BETWEEN 1 AND 50),
  status public.intake_job_status NOT NULL DEFAULT 'queued',
  failure_reason text CONSTRAINT document_intake_jobs_failure CHECK (
    failure_reason IN ('too_many_pages', 'timeout', 'invalid_result', 'worker_error')),
  parser_version text CONSTRAINT document_intake_jobs_parser CHECK (parser_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$'),
  diff_digest text CONSTRAINT document_intake_jobs_digest CHECK (diff_digest ~ '^[0-9a-f]{64}$'),
  -- DL-4: a claim adds one; the third lapsed lease fails the job.
  attempts integer NOT NULL DEFAULT 0 CONSTRAINT document_intake_jobs_attempts CHECK (attempts BETWEEN 0 AND 3),
  lease_token uuid,
  lease_expires_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  finished_at timestamptz,
  -- DL-16: set when the stored PDF has been deleted (30 days after the job ends).
  file_deleted_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  -- DL-5: the worker finds its job by id and lease alone; the tenant comes from the row.
  CONSTRAINT document_intake_jobs_id_unique UNIQUE (id),
  CONSTRAINT document_intake_jobs_lease_pair CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT document_intake_jobs_claimed_lease CHECK (status <> 'claimed' OR lease_token IS NOT NULL),
  CONSTRAINT document_intake_jobs_queued_lease CHECK (status <> 'queued' OR lease_token IS NULL),
  CONSTRAINT document_intake_jobs_review_fields CHECK (
    status NOT IN ('review', 'applied', 'discarded')
    OR (page_count IS NOT NULL AND parser_version IS NOT NULL AND diff_digest IS NOT NULL)),
  CONSTRAINT document_intake_jobs_failure_reason CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  CONSTRAINT document_intake_jobs_finished CHECK (
    (status IN ('applied', 'discarded', 'failed')) = (finished_at IS NOT NULL))
);
CREATE INDEX document_intake_jobs_recent ON public.document_intake_jobs (tenant_id, created_at DESC, id);
-- DL-5: the claim scan, and the lapsed-lease scan.
CREATE INDEX document_intake_jobs_due ON public.document_intake_jobs (created_at, id) WHERE status IN ('queued', 'claimed');
-- DL-16: the file sweep.
CREATE INDEX document_intake_jobs_sweep ON public.document_intake_jobs (finished_at) WHERE file_deleted_at IS NULL AND finished_at IS NOT NULL;

-- DL-12: a box is four numbers from 0 to 1 (fractions of the page, so inside it), with a positive area.
CREATE FUNCTION public.document_intake_bbox_valid(box jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  x0 numeric; y0 numeric; x1 numeric; y1 numeric;
BEGIN
  IF box IS NULL OR jsonb_typeof(box) <> 'array' OR jsonb_array_length(box) <> 4 THEN RETURN false; END IF;
  IF jsonb_typeof(box -> 0) <> 'number' OR jsonb_typeof(box -> 1) <> 'number'
     OR jsonb_typeof(box -> 2) <> 'number' OR jsonb_typeof(box -> 3) <> 'number' THEN RETURN false; END IF;
  x0 := (box ->> 0)::numeric; y0 := (box ->> 1)::numeric; x1 := (box ->> 2)::numeric; y1 := (box ->> 3)::numeric;
  RETURN x0 >= 0 AND y0 >= 0 AND x1 <= 1 AND y1 <= 1 AND x1 > x0 AND y1 > y0;
END $$;

-- DL-1, DL-11, DL-12: one extracted row and what the diff makes of it.
CREATE TABLE public.document_intake_rows (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  job_id uuid NOT NULL,
  row_index integer NOT NULL CONSTRAINT document_intake_rows_index CHECK (row_index >= 1),
  diff_op public.intake_diff_op NOT NULL,
  invalid_reason text CONSTRAINT document_intake_rows_invalid_reason CHECK (
    invalid_reason IN ('missing_key', 'missing_title', 'bad_price', 'bad_currency', 'duplicate_key', 'field_too_long')),
  existing_target_id uuid,
  existing_revision integer CONSTRAINT document_intake_rows_existing_revision CHECK (existing_revision >= 1),
  -- {proposed, current, changedFields, cells}: the contract checks the shape and the size.
  proposed_payload jsonb NOT NULL DEFAULT '{}'::jsonb CONSTRAINT document_intake_rows_payload CHECK (jsonb_typeof(proposed_payload) = 'object'),
  page_no integer NOT NULL DEFAULT 1 CONSTRAINT document_intake_rows_page CHECK (page_no BETWEEN 1 AND 50),
  bbox jsonb NOT NULL DEFAULT '[0.05,0.05,0.95,0.95]'::jsonb CONSTRAINT document_intake_rows_bbox CHECK (public.document_intake_bbox_valid(bbox)),
  source_snippet text NOT NULL DEFAULT '' CONSTRAINT document_intake_rows_snippet CHECK (char_length(source_snippet) <= 500),
  -- DL-13: the server's default (true for insert and update); the apply records what the owner approved.
  included boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT document_intake_rows_job FOREIGN KEY (tenant_id, job_id) REFERENCES public.document_intake_jobs (tenant_id, id),
  CONSTRAINT document_intake_rows_index_unique UNIQUE (tenant_id, job_id, row_index),
  CONSTRAINT document_intake_rows_invalid CHECK ((diff_op = 'invalid') = (invalid_reason IS NOT NULL)),
  CONSTRAINT document_intake_rows_existing CHECK (
    (diff_op IN ('update', 'unchanged')) = (existing_target_id IS NOT NULL)
    AND (existing_target_id IS NULL) = (existing_revision IS NULL)),
  CONSTRAINT document_intake_rows_included CHECK (NOT included OR diff_op IN ('insert', 'update'))
);

-- DL-4: the only moves a job makes. Same-status updates (a lease renewal, the file sweep) pass.
CREATE FUNCTION public.document_intake_jobs_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF (OLD.status, NEW.status) IN (
    ('queued', 'claimed'), ('claimed', 'review'), ('review', 'applied'), ('review', 'discarded'),
    ('claimed', 'queued'), ('queued', 'failed'), ('claimed', 'failed')
  ) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'An intake job cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation',
    SCHEMA = 'public', TABLE = 'document_intake_jobs', CONSTRAINT = 'document_intake_jobs_transition';
END $$;
CREATE TRIGGER document_intake_jobs_transition
  BEFORE UPDATE OF status ON public.document_intake_jobs
  FOR EACH ROW EXECUTE FUNCTION public.document_intake_jobs_transition();

-- DL-12: a row is written only into a job in review, and its page is inside the job's page count.
CREATE FUNCTION public.document_intake_rows_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  job record;
BEGIN
  SELECT status, page_count INTO job FROM public.document_intake_jobs WHERE tenant_id = NEW.tenant_id AND id = NEW.job_id;
  IF NOT FOUND OR job.status <> 'review' THEN
    RAISE EXCEPTION 'Rows are written only into a job in review' USING ERRCODE = 'check_violation',
      SCHEMA = 'public', TABLE = 'document_intake_rows', CONSTRAINT = 'document_intake_rows_job_review';
  END IF;
  IF job.page_count IS NULL OR NEW.page_no > job.page_count THEN
    RAISE EXCEPTION 'Row page % is outside the job''s % pages', NEW.page_no, job.page_count USING ERRCODE = 'check_violation',
      SCHEMA = 'public', TABLE = 'document_intake_rows', CONSTRAINT = 'document_intake_rows_page_count';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_intake_rows_guard
  BEFORE INSERT ON public.document_intake_rows
  FOR EACH ROW EXECUTE FUNCTION public.document_intake_rows_guard();

-- DL-2: revision starts at 1 and grows by exactly one on every update, for both catalog tables.
CREATE FUNCTION public.catalog_revision_step() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 THEN
      RAISE EXCEPTION 'A new row starts at revision 1' USING ERRCODE = 'check_violation',
        SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, CONSTRAINT = TG_TABLE_NAME || '_revision_step';
    END IF;
  ELSIF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'A revision grows by one: % to %', OLD.revision, NEW.revision USING ERRCODE = 'check_violation',
      SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME, CONSTRAINT = TG_TABLE_NAME || '_revision_step';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_items_revision_step BEFORE INSERT OR UPDATE ON public.catalog_items
  FOR EACH ROW EXECUTE FUNCTION public.catalog_revision_step();
CREATE TRIGGER knowledge_entries_revision_step BEFORE INSERT OR UPDATE ON public.knowledge_entries
  FOR EACH ROW EXECUTE FUNCTION public.catalog_revision_step();

ALTER TABLE public.catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_items FORCE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_intake_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_intake_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_intake_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_intake_rows FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_scope ON public.catalog_items TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON public.knowledge_entries TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON public.document_intake_jobs TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON public.document_intake_rows TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
-- DL-5: only the claim's platform transaction (db.platform) sets app.platform. It reads queued and
-- claimed jobs and leases them; a runtime request through the Data API cannot set it. The rows table
-- has no platform policy: the worker never reads or writes rows directly.
CREATE POLICY platform_claim_read ON public.document_intake_jobs FOR SELECT TO authenticated
  USING (current_setting('app.platform', true) = 'on');
CREATE POLICY platform_claim_lease ON public.document_intake_jobs FOR UPDATE TO authenticated
  USING (current_setting('app.platform', true) = 'on')
  WITH CHECK (current_setting('app.platform', true) = 'on');

REVOKE ALL ON public.catalog_items, public.knowledge_entries, public.document_intake_jobs, public.document_intake_rows
  FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.catalog_items, public.knowledge_entries, public.document_intake_jobs, public.document_intake_rows FROM anon;
  END IF;
END $$;
-- The service role (provisioning, seeds, the DL-16 sweep) may write all four, as for the other tenant tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.catalog_items, public.knowledge_entries,
  public.document_intake_jobs, public.document_intake_rows TO service_role;
-- DL-2: the runtime role reads both catalog tables and writes them only by insert and column update;
-- it has no DELETE. The tenant, id, sku and created_at never change.
GRANT SELECT ON public.catalog_items, public.knowledge_entries TO authenticated;
GRANT INSERT (tenant_id, id, sku, title, description, price_minor, currency, attributes, active, revision, created_at, updated_at)
  ON public.catalog_items TO authenticated;
GRANT UPDATE (title, description, price_minor, currency, attributes, active, revision, updated_at) ON public.catalog_items TO authenticated;
GRANT INSERT (tenant_id, id, slug, section_title, body_text, active, revision, created_at, updated_at) ON public.knowledge_entries TO authenticated;
GRANT UPDATE (section_title, body_text, active, revision, updated_at) ON public.knowledge_entries TO authenticated;
-- Jobs: the upload inserts one; the claim, result, fail, apply, discard and sweep update the state columns.
GRANT SELECT ON public.document_intake_jobs TO authenticated;
GRANT INSERT (tenant_id, id, target_kind, source, filename, file_sha256, byte_length, status, created_by, created_at)
  ON public.document_intake_jobs TO authenticated;
GRANT UPDATE (status, page_count, failure_reason, parser_version, diff_digest, attempts, lease_token, lease_expires_at, finished_at, file_deleted_at)
  ON public.document_intake_jobs TO authenticated;
-- Rows: written once by the result; the apply records which were approved.
GRANT SELECT, INSERT ON public.document_intake_rows TO authenticated;
GRANT UPDATE (included) ON public.document_intake_rows TO authenticated;

-- Same owners as every function: invoker functions with zs_function_owner (20261018090000).
REVOKE ALL ON FUNCTION public.catalog_attributes_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.document_intake_bbox_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.document_intake_jobs_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.document_intake_rows_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_revision_step() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.catalog_attributes_valid(jsonb) FROM anon;
    REVOKE ALL ON FUNCTION public.document_intake_bbox_valid(jsonb) FROM anon;
    REVOKE ALL ON FUNCTION public.document_intake_jobs_transition() FROM anon;
    REVOKE ALL ON FUNCTION public.document_intake_rows_guard() FROM anon;
    REVOKE ALL ON FUNCTION public.catalog_revision_step() FROM anon;
  END IF;
END $$;
-- The CHECK on rows calls the box function with the inserting role's rights.
GRANT EXECUTE ON FUNCTION public.catalog_attributes_valid(jsonb), public.document_intake_bbox_valid(jsonb) TO authenticated, service_role;
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.catalog_attributes_valid(jsonb) OWNER TO zs_function_owner;
ALTER FUNCTION public.document_intake_bbox_valid(jsonb) OWNER TO zs_function_owner;
ALTER FUNCTION public.document_intake_jobs_transition() OWNER TO zs_function_owner;
ALTER FUNCTION public.document_intake_rows_guard() OWNER TO zs_function_owner;
ALTER FUNCTION public.catalog_revision_step() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;
