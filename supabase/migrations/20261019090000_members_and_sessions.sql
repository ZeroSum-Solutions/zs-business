-- M2a auth model: who may act for a tenant, and whether the session behind a token is live.
-- The API maps a token's `sub` to a tenant_members row on every request and refuses a tenant
-- claim without one. It also asks auth_session_is_live() about the token's `session_id`, so a
-- signed-out access token is refused at once instead of at expiry.

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

-- Session liveness. auth.sessions lives in Supabase's auth schema, which runtime roles cannot
-- read. A SECURITY DEFINER function owned by a NOLOGIN role that may read three columns of
-- auth.sessions and three of auth.users answers one question: is this session of this user
-- live now? CREATE ROLE names NOLOGIN only (supautils; see 20261017155900).
DO $$ BEGIN
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zs_session_reader') THEN
      CREATE ROLE zs_session_reader NOLOGIN;
    END IF;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zs_session_reader' AND
    (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member='zs_session_reader'::regrole) THEN
    RAISE EXCEPTION 'zs_session_reader must be an unprivileged standalone NOLOGIN role';
  END IF;
  -- ALTER ... OWNER needs SET ROLE on the new owner (see 20261018090000).
  IF current_setting('server_version_num')::int >= 160000 THEN
    IF NOT (pg_has_role(current_user, 'zs_session_reader', 'SET') AND pg_has_role(current_user, 'zs_session_reader', 'USAGE')) THEN
      EXECUTE format('GRANT zs_session_reader TO %I WITH INHERIT TRUE, SET TRUE', current_user);
    END IF;
  ELSIF NOT pg_has_role(current_user, 'zs_session_reader', 'MEMBER') THEN
    EXECUTE format('GRANT zs_session_reader TO %I', current_user);
  END IF;
END $$;

-- On hosted Supabase the auth tables exist and the grants are made here; the check makes a
-- migrator without grant option fail loudly instead of leaving a function that always errors.
-- Plain Postgres has no auth schema: nothing is granted, and the function fails closed (the
-- relation does not exist) until a local-only stub is installed (@zs/db/testing installAuthStub).
DO $$ BEGIN
  IF to_regclass('auth.sessions') IS NOT NULL AND to_regclass('auth.users') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA auth TO zs_session_reader;
    GRANT SELECT (id, user_id, not_after) ON auth.sessions TO zs_session_reader;
    GRANT SELECT (id, banned_until, deleted_at) ON auth.users TO zs_session_reader;
    IF NOT (has_column_privilege('zs_session_reader', 'auth.sessions', 'user_id', 'SELECT')
      AND has_column_privilege('zs_session_reader', 'auth.users', 'banned_until', 'SELECT')) THEN
      RAISE EXCEPTION 'The migrator could not grant zs_session_reader read access to auth.sessions and auth.users';
    END IF;
  END IF;
END $$;

-- PL/pgSQL, so creating it needs no auth schema; every call resolves auth.* at run time.
-- p_now is the API's injected clock.
CREATE FUNCTION public.auth_session_is_live(p_session uuid, p_user uuid, p_now timestamptz)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_session IS NULL OR p_user IS NULL OR p_now IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM auth.sessions s JOIN auth.users u ON u.id = s.user_id
    WHERE s.id = p_session AND s.user_id = p_user
      AND (s.not_after IS NULL OR s.not_after > p_now)
      AND (u.banned_until IS NULL OR u.banned_until <= p_now)
      AND u.deleted_at IS NULL
  );
END $$;
REVOKE ALL ON FUNCTION public.auth_session_is_live(uuid, uuid, timestamptz) FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.auth_session_is_live(uuid, uuid, timestamptz) FROM anon;
  END IF;
END $$;
-- Ownership transfer requires CREATE briefly; the role cannot create replacements afterward.
GRANT CREATE ON SCHEMA public TO zs_session_reader;
ALTER FUNCTION public.auth_session_is_live(uuid, uuid, timestamptz) OWNER TO zs_session_reader;
REVOKE CREATE ON SCHEMA public FROM zs_session_reader;
GRANT EXECUTE ON FUNCTION public.auth_session_is_live(uuid, uuid, timestamptz) TO authenticated;
