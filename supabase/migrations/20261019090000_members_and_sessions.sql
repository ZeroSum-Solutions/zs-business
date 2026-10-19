-- M2a auth model: who may act for a tenant. The API maps a token's `sub` to a tenant_members
-- row on every request and refuses a tenant claim without one.

DO $$ BEGIN
  CREATE TYPE public.member_role AS ENUM ('owner', 'staff');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- One row per person per tenant. `user_id` is NULL while an invite is pending: the invite
-- worker (M2b) creates or finds the Supabase user and binds it with the service role. Runtime
-- can never set user_id, so no member can bind an account to a membership themselves.
-- Removing a member deletes the row; the action history keeps the record.
CREATE TABLE public.tenant_members (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  -- Validated as an address by the contracts schema; SQL keeps it canonical and bounded.
  email text NOT NULL CONSTRAINT tenant_members_email_canonical
    CHECK (char_length(email) BETWEEN 3 AND 254 AND email = lower(email)),
  user_id uuid,
  role public.member_role NOT NULL,
  invited_by uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT tenant_members_tenant_email UNIQUE (tenant_id, email)
);
CREATE UNIQUE INDEX tenant_members_tenant_user ON public.tenant_members (tenant_id, user_id)
  WHERE user_id IS NOT NULL;

ALTER TABLE public.tenant_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.tenant_members TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON public.tenant_members FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.tenant_members FROM anon;
    REVOKE ALL ON TYPE public.member_role FROM anon;
  END IF;
END $$;
REVOKE ALL ON TYPE public.member_role FROM PUBLIC;
GRANT USAGE ON TYPE public.member_role TO authenticated, service_role;
-- Runtime writes come only from the member actions, through the dispatcher.
GRANT SELECT, DELETE ON public.tenant_members TO authenticated;
GRANT INSERT (tenant_id, id, email, role, invited_by, created_at, updated_at) ON public.tenant_members TO authenticated;
GRANT UPDATE (role, updated_at) ON public.tenant_members TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_members TO service_role;

-- Session liveness is not checked here. auth.sessions and auth.users on hosted Supabase belong
-- to supabase_auth_admin with RLS on and no policies, and the migrator cannot grant on them.
-- The API asks Supabase Auth instead (GET /auth/v1/user with the caller's token), so this
-- migration touches nothing in the auth schema.
