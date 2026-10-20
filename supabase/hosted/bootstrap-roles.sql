-- Owner-run, once per hosted Supabase project, as the project's `postgres` login, before
-- the first migration. Idempotent: a rerun rotates both passwords and re-asserts the rules.
-- The server only ever sees SCRAM-SHA-256 verifiers, never a plaintext password: Supabase
-- runs log_statement=ddl, which logs CREATE/ALTER ROLE text. Compute them client-side with
-- scram-verifier.mjs and pass them through the environment, never argv:
--   ZS_MIGRATOR_VERIFIER  zs_migrator, the restricted role that applies supabase/migrations
--   ZS_RUNTIME_VERIFIER   zs_runtime, the API's login (member of authenticated only)
-- CREATE/ALTER ROLE name only LOGIN, CREATEROLE and PASSWORD: supautils refuses a
-- non-superuser statement that names SUPERUSER, REPLICATION or BYPASSRLS, even as NO*.
-- The checks at the end assert every attribute instead.
\set ON_ERROR_STOP 1
\getenv migrator_verifier ZS_MIGRATOR_VERIFIER
\getenv runtime_verifier ZS_RUNTIME_VERIFIER
SELECT :'migrator_verifier' ~ '^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$'
   AND :'runtime_verifier' ~ '^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$'
   AND :'migrator_verifier' <> :'runtime_verifier' AS verifiers_ok \gset
\if :verifiers_ok
\else
  \echo 'Set ZS_MIGRATOR_VERIFIER and ZS_RUNTIME_VERIFIER from scram-verifier.mjs (two different passwords)'
  \quit 3
\endif

BEGIN;
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zs_migrator') AS create_migrator,
       NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zs_runtime') AS create_runtime \gset
\if :create_migrator
  CREATE ROLE zs_migrator LOGIN CREATEROLE PASSWORD :'migrator_verifier';
\else
  ALTER ROLE zs_migrator LOGIN CREATEROLE PASSWORD :'migrator_verifier';
\endif
\if :create_runtime
  CREATE ROLE zs_runtime LOGIN PASSWORD :'runtime_verifier';
\else
  ALTER ROLE zs_runtime LOGIN NOCREATEROLE PASSWORD :'runtime_verifier';
\endif
ALTER ROLE zs_migrator RESET ALL;
ALTER ROLE zs_runtime RESET ALL;
ALTER ROLE zs_runtime INHERIT;

-- The migrator creates zs_internal and owns every table and type it creates in public.
-- GRANT OPTION lets migrations grant schema usage to authenticated and service_role and
-- lend CREATE to the function-owner roles for an ownership transfer.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CREATE ON DATABASE postgres TO zs_migrator;
GRANT USAGE, CREATE ON SCHEMA public TO zs_migrator WITH GRANT OPTION;
GRANT USAGE ON SCHEMA extensions TO zs_migrator;
-- 20261017170000 runs CREATE EXTENSION IF NOT EXISTS btree_gist; on Supabase only postgres
-- may create it, so it exists before the migrator runs.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- Runtime: a member of authenticated and nothing else.
GRANT authenticated TO zs_runtime;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zs_migrator'
      AND (NOT rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolreplication OR NOT rolcreaterole))
    OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
      WHERE m.member = 'zs_migrator'::regrole AND r.rolname NOT IN ('zs_dispatcher', 'zs_function_owner', 'zs_rate_limiter')) THEN
    RAISE EXCEPTION 'zs_migrator must be a LOGIN CREATEROLE role without superuser, BYPASSRLS or other memberships';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zs_runtime'
      AND (NOT rolcanlogin OR NOT rolinherit OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = 'zs_runtime'::regrole AND roleid <> 'authenticated'::regrole)
    OR EXISTS (SELECT 1 FROM pg_db_role_setting WHERE setrole IN ('zs_runtime'::regrole, 'zs_migrator'::regrole)) THEN
    RAISE EXCEPTION 'zs_runtime must be an unprivileged LOGIN member of authenticated only, with no role settings';
  END IF;
END $$;
COMMIT;
\echo 'bootstrap-roles: zs_migrator and zs_runtime are ready'
