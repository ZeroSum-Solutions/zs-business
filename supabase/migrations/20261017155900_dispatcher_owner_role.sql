-- Prerequisite for 20261017160000, which is frozen as applied (the runner checksums it).
-- On a fresh database this runs first: the role exists before 160000 tries to create it,
-- and the migrator can SET ROLE to it before 160000 transfers ownership. A database that
-- applied 160000 earlier runs this afterwards; every step is idempotent there.
-- CREATE ROLE names NOLOGIN only: hosted Supabase (supautils) refuses a non-superuser
-- CREATE ROLE that names SUPERUSER, REPLICATION or BYPASSRLS, even as NO*. The defaults
-- are already off; the check below asserts them.
DO $$ BEGIN
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zs_dispatcher') THEN
      CREATE ROLE zs_dispatcher NOLOGIN;
    END IF;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zs_dispatcher' AND
    (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member='zs_dispatcher'::regrole) THEN
    RAISE EXCEPTION 'zs_dispatcher must be an unprivileged standalone NOLOGIN role';
  END IF;
END $$;
-- ALTER ... OWNER needs SET ROLE on the new owner. On PostgreSQL 16+ a non-superuser
-- CREATEROLE migrator (postgres on hosted Supabase) can be a member with SET and INHERIT
-- off, so membership alone is not enough. INHERIT lets it act as owner for the grants in
-- 160000. PostgreSQL 15 has neither the SET privilege nor the grant options: membership
-- allows SET ROLE there and inherits per the member's rolinherit. Dynamic SQL keeps 15
-- from parsing the 16-only GRANT syntax.
DO $$ BEGIN
  IF current_setting('server_version_num')::int >= 160000 THEN
    IF NOT (pg_has_role(current_user, 'zs_dispatcher', 'SET') AND pg_has_role(current_user, 'zs_dispatcher', 'USAGE')) THEN
      EXECUTE format('GRANT zs_dispatcher TO %I WITH INHERIT TRUE, SET TRUE', current_user);
    END IF;
  ELSIF NOT pg_has_role(current_user, 'zs_dispatcher', 'MEMBER') THEN
    EXECUTE format('GRANT zs_dispatcher TO %I', current_user);
  END IF;
END $$;
