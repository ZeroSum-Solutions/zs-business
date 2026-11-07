-- Hub access (docs/requirements/hub-access.md H-1, H-2, H-8, H-11, H-12): automation tokens may
-- also hold read scopes, a token with a read scope must expire within a year, and every
-- authenticated request to the remote MCP edge is counted per token per hour.

-- H-2: the six read scopes beside the three propose scopes (W-10).
ALTER TYPE public.automation_token_scope ADD VALUE IF NOT EXISTS 'contacts:read';
ALTER TYPE public.automation_token_scope ADD VALUE IF NOT EXISTS 'deals:read';
ALTER TYPE public.automation_token_scope ADD VALUE IF NOT EXISTS 'bookings:read';
ALTER TYPE public.automation_token_scope ADD VALUE IF NOT EXISTS 'inbox:read';
ALTER TYPE public.automation_token_scope ADD VALUE IF NOT EXISTS 'results:read';
ALTER TYPE public.automation_token_scope ADD VALUE IF NOT EXISTS 'business:read';

-- A token may hold all nine scopes.
ALTER TABLE public.automation_tokens DROP CONSTRAINT automation_tokens_scopes_size;
ALTER TABLE public.automation_tokens
  ADD CONSTRAINT automation_tokens_scopes_size CHECK (cardinality(scopes) <= 9);

-- H-1: a token with any read scope has an expiry of 1 to 365 days after it was created. The
-- scopes are compared as text: a value added in this transaction cannot be used as an enum
-- literal until the transaction commits. Hours, not days, so the session zone cannot shift it.
-- No existing row holds a read scope, so the check needs no NOT VALID.
ALTER TABLE public.automation_tokens
  ADD CONSTRAINT automation_tokens_read_expiry CHECK (
    NOT (scopes::text[] && ARRAY['contacts:read', 'deals:read', 'bookings:read', 'inbox:read', 'results:read', 'business:read'])
    OR (expires_at IS NOT NULL
        AND expires_at >= created_at + interval '24 hours'
        AND expires_at <= created_at + interval '8760 hours'));

-- H-8: one row per token per hour. Written by the API after each authenticated request; read by
-- owners; rows older than 30 days are deleted by the Activepieces worker pass (service role).
CREATE TABLE public.automation_token_usage (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  token_id uuid NOT NULL,
  hour timestamptz NOT NULL
    CONSTRAINT automation_token_usage_hour CHECK (mod(extract(epoch FROM hour)::numeric, 3600) = 0),
  requests integer NOT NULL DEFAULT 0 CONSTRAINT automation_token_usage_requests CHECK (requests >= 0),
  reads integer NOT NULL DEFAULT 0 CONSTRAINT automation_token_usage_reads CHECK (reads >= 0),
  proposals integer NOT NULL DEFAULT 0 CONSTRAINT automation_token_usage_proposals CHECK (proposals >= 0),
  refusals integer NOT NULL DEFAULT 0 CONSTRAINT automation_token_usage_refusals CHECK (refusals >= 0),
  PRIMARY KEY (tenant_id, token_id, hour),
  FOREIGN KEY (tenant_id, token_id) REFERENCES public.automation_tokens(tenant_id, id)
);
-- The cleanup scans across tenants by age.
CREATE INDEX automation_token_usage_hour ON public.automation_token_usage (hour);

-- Counters only grow (H-8): a decrease is refused, so a bug or a replayed write cannot erase use.
CREATE FUNCTION public.automation_token_usage_grow_only() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.requests < OLD.requests OR NEW.reads < OLD.reads
     OR NEW.proposals < OLD.proposals OR NEW.refusals < OLD.refusals THEN
    RAISE EXCEPTION 'automation_token_usage counters only grow' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER automation_token_usage_grow_only BEFORE UPDATE ON public.automation_token_usage
  FOR EACH ROW EXECUTE FUNCTION public.automation_token_usage_grow_only();

ALTER TABLE public.automation_token_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_token_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.automation_token_usage TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON public.automation_token_usage FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.automation_token_usage FROM anon;
  END IF;
END $$;
GRANT SELECT ON public.automation_token_usage TO authenticated, service_role;
-- The API counts through the runtime role: new rows and counter increments, nothing else.
GRANT INSERT ON public.automation_token_usage TO authenticated, service_role;
GRANT UPDATE (requests, reads, proposals, refusals) ON public.automation_token_usage TO authenticated;
-- The worker prunes old rows as the service role.
GRANT DELETE ON public.automation_token_usage TO service_role;
