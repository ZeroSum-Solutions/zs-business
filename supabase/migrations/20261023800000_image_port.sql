-- Image port (docs/requirements/image-port.md IM-1, IM-2, IM-15), revision 1 of the first slice.
-- media_assets: images a tenant may publish. image_variants: one image job each. Both are tenant
-- tables with a tenant FK, forced RLS and the shared tenant_scope policy. Runtime writes come from
-- the media.* actions through the dispatcher; the service role runs the job and promotion workers.

CREATE TABLE public.media_assets (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  -- IM-3: the server's SHA-256 of the stored bytes; one asset per digest per tenant.
  sha256 text NOT NULL CONSTRAINT media_assets_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content_type text NOT NULL CONSTRAINT media_assets_content_type CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  -- SITE_LIMITS.fileBytes, MEDIA_LIMITS in packages/contracts/src/media.ts.
  byte_length integer NOT NULL CONSTRAINT media_assets_byte_length CHECK (byte_length BETWEEN 1 AND 10485760),
  width integer NOT NULL CONSTRAINT media_assets_width CHECK (width BETWEEN 1 AND 8192),
  height integer NOT NULL CONSTRAINT media_assets_height CHECK (height BETWEEN 1 AND 8192),
  CONSTRAINT media_assets_pixels CHECK (width::bigint * height <= 40000000),
  origin text NOT NULL CONSTRAINT media_assets_origin CHECK (origin IN ('upload', 'variant')),
  -- Null for an upload; the promoted variant otherwise (foreign key added below).
  variant_id uuid,
  CONSTRAINT media_assets_origin_variant CHECK ((origin = 'variant') = (variant_id IS NOT NULL)),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT media_assets_tenant_sha256 UNIQUE (tenant_id, sha256)
);

CREATE TABLE public.image_variants (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  source_asset_id uuid NOT NULL,
  source_sha256 text NOT NULL CONSTRAINT image_variants_source_sha256 CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  -- IM-4: the fixed presets (IMAGE_PRESETS in packages/contracts/src/media.ts).
  preset text NOT NULL CONSTRAINT image_variants_preset CHECK (preset IN ('background_remove', 'studio_background_swap', 'upscale_2k')),
  params jsonb NOT NULL CONSTRAINT image_variants_params CHECK (jsonb_typeof(params) = 'object'),
  -- IM-2
  status text NOT NULL DEFAULT 'queued'
    CONSTRAINT image_variants_status CHECK (status IN ('queued', 'running', 'staged', 'approved', 'promoted', 'failed', 'expired')),
  failure_reason text CONSTRAINT image_variants_failure_reason CHECK (failure_reason IN (
    'model_not_allowed', 'insufficient_funds', 'adapter_error', 'digest_mismatch', 'matte_invalid',
    'product_pixels_changed', 'size_changed', 'outcome_unknown', 'source_undecodable', 'output_invalid')),
  -- IM-5, IM-9, IM-11: the staged output, the matte and the generated background, by SHA-256.
  sha256 text CONSTRAINT image_variants_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  matte_sha256 text CONSTRAINT image_variants_matte_sha256 CHECK (matte_sha256 ~ '^[0-9a-f]{64}$'),
  background_sha256 text CONSTRAINT image_variants_background_sha256 CHECK (background_sha256 ~ '^[0-9a-f]{64}$'),
  -- IM-5, IM-15: provenance. Each is set once (the guard below).
  adapter text CONSTRAINT image_variants_adapter CHECK (adapter IN ('kie', 'fal', 'higgsfield', 'comfyui', 'fake')),
  model_id text CONSTRAINT image_variants_model_id CHECK (char_length(model_id) BETWEEN 1 AND 200),
  model_license text CONSTRAINT image_variants_model_license CHECK (char_length(model_license) BETWEEN 1 AND 200),
  workflow_hash text CONSTRAINT image_variants_workflow_hash CHECK (char_length(workflow_hash) BETWEEN 1 AND 200),
  prompt_text text CONSTRAINT image_variants_prompt_text CHECK (char_length(prompt_text) BETWEEN 1 AND 2000),
  provider_job_id text CONSTRAINT image_variants_provider_job_id CHECK (char_length(provider_job_id) BETWEEN 1 AND 200),
  -- IM-7: the server's price in the wallet's currency, fixed when the variant is queued.
  price_minor integer NOT NULL CONSTRAINT image_variants_price CHECK (price_minor > 0),
  currency text NOT NULL CONSTRAINT image_variants_currency CHECK (currency ~ '^[a-z]{3}$'),
  vendor_cost_micros bigint CONSTRAINT image_variants_vendor_cost CHECK (vendor_cost_micros >= 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  staged_at timestamptz,
  expires_at timestamptz,
  approved_at timestamptz,
  promoted_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, source_asset_id) REFERENCES public.media_assets (tenant_id, id),
  -- IM-2: each state is tied to its columns. IS NOT NULL answers true or false, so no CHECK passes on NULL.
  CONSTRAINT image_variants_staged_columns CHECK (status NOT IN ('staged', 'approved', 'promoted', 'expired') OR (
    sha256 IS NOT NULL AND staged_at IS NOT NULL AND expires_at IS NOT NULL
    AND adapter IS NOT NULL AND model_id IS NOT NULL AND model_license IS NOT NULL AND workflow_hash IS NOT NULL)),
  CONSTRAINT image_variants_expiry_after_stage CHECK (expires_at IS NULL OR (staged_at IS NOT NULL AND expires_at > staged_at)),
  CONSTRAINT image_variants_failed_reason CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  CONSTRAINT image_variants_approved_columns CHECK (status NOT IN ('approved', 'promoted') OR approved_at IS NOT NULL),
  CONSTRAINT image_variants_promoted_columns CHECK (status <> 'promoted' OR promoted_at IS NOT NULL)
);

ALTER TABLE public.media_assets ADD CONSTRAINT media_assets_variant_fk
  FOREIGN KEY (tenant_id, variant_id) REFERENCES public.image_variants (tenant_id, id);
CREATE INDEX media_assets_variant ON public.media_assets (tenant_id, variant_id) WHERE variant_id IS NOT NULL;
CREATE INDEX image_variants_source ON public.image_variants (tenant_id, source_asset_id);
-- The workers scan by state across tenants as the service role.
CREATE INDEX image_variants_queued ON public.image_variants (created_at, tenant_id, id) WHERE status = 'queued';
CREATE INDEX image_variants_running ON public.image_variants (created_at, tenant_id, id) WHERE status = 'running';
CREATE INDEX image_variants_expiry ON public.image_variants (expires_at, tenant_id, id) WHERE status = 'staged';
CREATE INDEX image_variants_approved ON public.image_variants (approved_at, tenant_id, id) WHERE status = 'approved';

-- IM-2, IM-15: the only moves are queued -> running -> staged -> approved -> promoted,
-- queued | running -> failed and staged -> expired. A row that has reached a settled state
-- (staged and later, failed) changes only by moving on. The identity, source, preset, params and
-- price never change; each provenance column and time is set once. Every role, as for agent_runs_guard.
CREATE FUNCTION public.image_variants_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.source_asset_id IS DISTINCT FROM OLD.source_asset_id OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
     OR NEW.preset IS DISTINCT FROM OLD.preset OR NEW.params IS DISTINCT FROM OLD.params
     OR NEW.price_minor IS DISTINCT FROM OLD.price_minor OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'An image variant keeps its source, preset, params and price'
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'image_variants', CONSTRAINT = 'image_variants_immutable';
  END IF;
  IF (OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256)
     OR (OLD.matte_sha256 IS NOT NULL AND NEW.matte_sha256 IS DISTINCT FROM OLD.matte_sha256)
     OR (OLD.background_sha256 IS NOT NULL AND NEW.background_sha256 IS DISTINCT FROM OLD.background_sha256)
     OR (OLD.adapter IS NOT NULL AND NEW.adapter IS DISTINCT FROM OLD.adapter)
     OR (OLD.model_id IS NOT NULL AND NEW.model_id IS DISTINCT FROM OLD.model_id)
     OR (OLD.model_license IS NOT NULL AND NEW.model_license IS DISTINCT FROM OLD.model_license)
     OR (OLD.workflow_hash IS NOT NULL AND NEW.workflow_hash IS DISTINCT FROM OLD.workflow_hash)
     OR (OLD.prompt_text IS NOT NULL AND NEW.prompt_text IS DISTINCT FROM OLD.prompt_text)
     OR (OLD.provider_job_id IS NOT NULL AND NEW.provider_job_id IS DISTINCT FROM OLD.provider_job_id)
     OR (OLD.vendor_cost_micros IS NOT NULL AND NEW.vendor_cost_micros IS DISTINCT FROM OLD.vendor_cost_micros)
     OR (OLD.failure_reason IS NOT NULL AND NEW.failure_reason IS DISTINCT FROM OLD.failure_reason)
     OR (OLD.staged_at IS NOT NULL AND NEW.staged_at IS DISTINCT FROM OLD.staged_at)
     OR (OLD.expires_at IS NOT NULL AND NEW.expires_at IS DISTINCT FROM OLD.expires_at)
     OR (OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at)
     OR (OLD.promoted_at IS NOT NULL AND NEW.promoted_at IS DISTINCT FROM OLD.promoted_at) THEN
    RAISE EXCEPTION 'An image variant''s provenance is set once'
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'image_variants', CONSTRAINT = 'image_variants_provenance_once';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF (OLD.status, NEW.status) NOT IN (
      ('queued', 'running'), ('running', 'staged'), ('staged', 'approved'), ('approved', 'promoted'),
      ('queued', 'failed'), ('running', 'failed'), ('staged', 'expired')) THEN
      RAISE EXCEPTION 'An image variant cannot move from % to %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'image_variants', CONSTRAINT = 'image_variants_transition';
    END IF;
  ELSIF OLD.status NOT IN ('queued', 'running') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'A % image variant does not change', OLD.status
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'image_variants', CONSTRAINT = 'image_variants_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER image_variants_guard
  BEFORE UPDATE ON public.image_variants
  FOR EACH ROW EXECUTE FUNCTION public.image_variants_guard();

REVOKE ALL ON FUNCTION public.image_variants_guard() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.image_variants_guard() FROM anon;
  END IF;
END $$;
-- Same owner as every invoker function (20261018090000); CREATE only for the transfer.
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.image_variants_guard() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['media_assets', 'image_variants'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO authenticated
      USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$p$, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, authenticated, service_role', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

-- IM-15: no role deletes either table, and an asset never changes. Runtime inserts a queued variant
-- (status takes its default) and updates only the columns the stage, fail, approve and promote
-- steps write; the guard makes each provenance column set-once. The worker (service role) moves a
-- variant to running and records the vendor job ID.
GRANT INSERT (tenant_id, id, sha256, content_type, byte_length, width, height, origin, variant_id, created_by, created_at)
  ON public.media_assets TO authenticated;
GRANT INSERT (tenant_id, id, source_asset_id, source_sha256, preset, params, price_minor, currency, created_by, created_at)
  ON public.image_variants TO authenticated;
GRANT UPDATE (status, failure_reason, sha256, matte_sha256, background_sha256, adapter, model_id, model_license,
  workflow_hash, prompt_text, provider_job_id, vendor_cost_micros, staged_at, expires_at, approved_at, promoted_at)
  ON public.image_variants TO authenticated;
GRANT SELECT, INSERT ON public.media_assets TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.image_variants TO service_role;

-- IM-15: a promoted image is recorded as a source record of the asset. Not used in this migration.
ALTER TYPE public.source_subject_type ADD VALUE IF NOT EXISTS 'media_asset';
