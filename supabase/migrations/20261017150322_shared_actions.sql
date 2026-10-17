-- Cluster roles are shared by independent per-run databases. Concurrent CREATE ROLE
-- can raise either duplicate_object or unique_violation; never alter an existing role.
DO $$
BEGIN
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    END IF;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    CREATE ROLE service_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS;
    END IF;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated' AND (rolbypassrls OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
    RAISE EXCEPTION 'authenticated must be an unprivileged runtime role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role' AND rolbypassrls AND NOT rolsuper) THEN
    RAISE EXCEPTION 'service_role must have BYPASSRLS without superuser';
  END IF;
END $$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO authenticated, service_role;

CREATE TABLE public.tenants (
  tenant_id uuid PRIMARY KEY,
  name text NOT NULL CONSTRAINT tenants_name_nonempty CHECK (length(name) > 0)
);
CREATE TABLE public.actions (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  actor_id uuid NOT NULL,
  action_type text NOT NULL CONSTRAINT actions_type_nonempty CHECK (length(action_type) > 0),
  target jsonb NOT NULL,
  payload jsonb NOT NULL,
  approval_reference jsonb,
  idempotency_key text NOT NULL CONSTRAINT actions_key_nonempty CHECK (length(idempotency_key) > 0),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  CONSTRAINT actions_tenant_key UNIQUE (tenant_id,idempotency_key)
);
CREATE TABLE public.outbox (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  action_id uuid NOT NULL,
  event_type text NOT NULL CONSTRAINT outbox_type_nonempty CHECK (length(event_type) > 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  CONSTRAINT outbox_one_per_action UNIQUE (tenant_id,action_id),
  FOREIGN KEY (tenant_id,action_id) REFERENCES public.actions(tenant_id,id)
);

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.tenants TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE public.actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.actions TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE public.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.outbox TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);

-- Runtime cannot delete/modify history or provision tenants. Provisioning and
-- outbox processing use the explicitly privileged service entry point.
REVOKE ALL ON public.tenants, public.actions, public.outbox FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.tenants, public.actions, public.outbox FROM anon;
  END IF;
END $$;
GRANT SELECT, UPDATE (name) ON public.tenants TO authenticated;
GRANT SELECT, INSERT ON public.actions, public.outbox TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenants, public.actions, public.outbox TO service_role;
