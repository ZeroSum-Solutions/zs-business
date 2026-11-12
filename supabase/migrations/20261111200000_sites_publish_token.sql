-- Hub access revision 4 (docs/requirements/hub-access.md H-13, H-14): the scope `sites:publish`
-- and the sites an automation token may publish. A token holding the scope names 1 to 10 sites at
-- creation; the list never changes afterwards (a change is a new token).

ALTER TYPE public.automation_token_scope ADD VALUE IF NOT EXISTS 'sites:publish';

-- A token may hold all eleven scopes.
ALTER TABLE public.automation_tokens DROP CONSTRAINT automation_tokens_scopes_size;
ALTER TABLE public.automation_tokens
  ADD CONSTRAINT automation_tokens_scopes_size CHECK (cardinality(scopes) <= 11);

-- H-1 with the new scope. Compared as text: a value added in this transaction cannot be used as
-- an enum literal until the transaction commits. No existing row holds the new scope.
ALTER TABLE public.automation_tokens DROP CONSTRAINT automation_tokens_read_expiry;
ALTER TABLE public.automation_tokens
  ADD CONSTRAINT automation_tokens_read_expiry CHECK (
    NOT (scopes::text[] && ARRAY['contacts:read', 'deals:read', 'bookings:read', 'inbox:read', 'results:read', 'business:read', 'connections:read', 'sites:publish'])
    OR (expires_at IS NOT NULL
        AND expires_at >= created_at + interval '24 hours'
        AND expires_at <= created_at + interval '8760 hours'));

-- H-14: the sites a token is bound to. Both keys are composite so a row cannot name another
-- tenant's token or site.
CREATE TABLE public.automation_token_sites (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  token_id uuid NOT NULL,
  site_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, token_id, site_id),
  FOREIGN KEY (tenant_id, token_id) REFERENCES public.automation_tokens(tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES public.sites(tenant_id, id)
);
-- The sites foreign key leads with its own columns (the primary key serves the token key).
CREATE INDEX automation_token_sites_site ON public.automation_token_sites (tenant_id, site_id, token_id);

ALTER TABLE public.automation_token_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_token_sites FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.automation_token_sites TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);
REVOKE ALL ON public.automation_token_sites FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.automation_token_sites FROM anon;
  END IF;
END $$;
-- Read and insert only: no update, delete or truncate for any role.
GRANT SELECT, INSERT ON public.automation_token_sites TO authenticated, service_role;

-- H-14: rows may be inserted only by the transaction that inserted the token row (the token's
-- creation). Grants alone would let a later insert widen an existing token.
CREATE FUNCTION public.automation_token_sites_creation_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.automation_tokens t
    WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.token_id
      -- A token row this statement can see whose writer is still running was written by this
      -- transaction (or one of its savepoints): another transaction's uncommitted row is invisible.
      AND pg_catalog.pg_xact_status(
        (((pg_catalog.pg_current_xact_id()::text::bigint >> 32) << 32) + t.xmin::text::bigint)::text::xid8) = 'in progress') THEN
    RAISE EXCEPTION 'The sites of a token are set when the token is created (insert refused)'
      USING ERRCODE = 'insufficient_privilege', SCHEMA = 'public', TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER automation_token_sites_creation_only BEFORE INSERT ON public.automation_token_sites
  FOR EACH ROW EXECUTE FUNCTION public.automation_token_sites_creation_only();

-- H-14: a token with the scope holds 1 to 10 sites; a token without it holds none. Checked at
-- commit, because the token row goes in before its site rows.
CREATE FUNCTION public.automation_token_sites_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_token uuid;
  v_has boolean;
  v_count integer;
BEGIN
  IF TG_TABLE_NAME = 'automation_tokens' THEN v_token := NEW.id; ELSE v_token := NEW.token_id; END IF;
  SELECT COALESCE(t.scopes::text[] @> ARRAY['sites:publish'], false) INTO v_has
    FROM public.automation_tokens t WHERE t.tenant_id = NEW.tenant_id AND t.id = v_token;
  SELECT count(*) INTO v_count FROM public.automation_token_sites s
    WHERE s.tenant_id = NEW.tenant_id AND s.token_id = v_token;
  IF (COALESCE(v_has, false) AND v_count NOT BETWEEN 1 AND 10) OR (NOT COALESCE(v_has, false) AND v_count > 0) THEN
    RAISE EXCEPTION 'A token with sites:publish names 1 to 10 sites, and any other token names none'
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER automation_tokens_sites_check AFTER INSERT ON public.automation_tokens
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.automation_token_sites_check();
CREATE CONSTRAINT TRIGGER automation_token_sites_check AFTER INSERT ON public.automation_token_sites
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.automation_token_sites_check();

-- H-14: the creation-only check above reads the token row's writer (`xmin`), and a no-op update of
-- the token would give a committed token a new writer. The only update the runtime role holds is
-- `revoked_at, revoked_by`, and its only legitimate use is the one-way revoke: refuse any other use.
CREATE FUNCTION public.automation_tokens_revoke_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'A token can only be revoked once (update refused)'
      USING ERRCODE = 'insufficient_privilege', SCHEMA = 'public', TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER automation_tokens_revoke_only BEFORE UPDATE OF revoked_at, revoked_by ON public.automation_tokens
  FOR EACH ROW EXECUTE FUNCTION public.automation_tokens_revoke_only();

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['automation_token_sites_creation_only', 'automation_token_sites_check', 'automation_tokens_revoke_only'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM anon', f);
    END IF;
  END LOOP;
END $$;
-- Same owner as every invoker function (20261018090000); CREATE only for the transfer.
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.automation_token_sites_creation_only() OWNER TO zs_function_owner;
ALTER FUNCTION public.automation_token_sites_check() OWNER TO zs_function_owner;
ALTER FUNCTION public.automation_tokens_revoke_only() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;
