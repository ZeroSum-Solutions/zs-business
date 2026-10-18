-- Function owner is neither a table owner nor a role that can bypass forced RLS.
DO $$ BEGIN
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zs_dispatcher') THEN
      CREATE ROLE zs_dispatcher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zs_dispatcher' AND
    (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member='zs_dispatcher'::regrole) THEN
    RAISE EXCEPTION 'zs_dispatcher must be an unprivileged standalone NOLOGIN role';
  END IF;
END $$;

REVOKE UPDATE (name) ON public.tenants FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.actions, public.outbox FROM authenticated;
GRANT USAGE ON SCHEMA public TO zs_dispatcher;
GRANT SELECT, INSERT ON public.actions, public.outbox TO zs_dispatcher;
ALTER POLICY tenant_scope ON public.actions TO authenticated, zs_dispatcher;
ALTER POLICY tenant_scope ON public.outbox TO authenticated, zs_dispatcher;

CREATE UNIQUE INDEX actions_tenant_approval ON public.actions
  (tenant_id, ((approval_reference->>'id')::uuid)) WHERE approval_reference IS NOT NULL;
ALTER TABLE public.outbox ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE public.outbox ADD COLUMN processed_at timestamptz;
REVOKE ALL ON SEQUENCE public.outbox_seq_seq FROM PUBLIC, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.outbox_seq_seq TO zs_dispatcher, service_role;

-- One narrow write path commits the record and its event together. Context checks
-- are explicit as well as enforced by RLS on both inserts under zs_dispatcher.
CREATE FUNCTION public.record_action_and_event(
  p_tenant uuid, p_id uuid, p_actor uuid, p_type text, p_target jsonb,
  p_payload jsonb, p_approval jsonb, p_key text, p_result jsonb,
  p_created_at timestamptz, p_event_id uuid, p_event_type text, p_event_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE saved_result jsonb;
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
    OR (p_target->>'tenantId')::uuid IS DISTINCT FROM p_tenant
    OR (p_approval->>'tenantId')::uuid IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'Action tenant context mismatch' USING ERRCODE='42501';
  END IF;
  IF p_approval->>'id' IS NULL OR p_target->>'id' IS NULL THEN
    RAISE EXCEPTION 'Approval and target IDs are required' USING ERRCODE='22023';
  END IF;
  PERFORM (p_approval->>'id')::uuid, (p_target->>'id')::uuid;
  INSERT INTO public.actions(tenant_id,id,actor_id,action_type,target,payload,
    approval_reference,idempotency_key,result,created_at)
    VALUES(p_tenant,p_id,p_actor,p_type,p_target,p_payload,p_approval,p_key,p_result,p_created_at)
    RETURNING result INTO saved_result;
  INSERT INTO public.outbox(tenant_id,id,action_id,event_type,payload,created_at)
    VALUES(p_tenant,p_event_id,p_id,p_event_type,p_event_payload,p_created_at);
  RETURN saved_result;
END $$;
-- ALTER ... OWNER needs SET ROLE on the new owner. On PostgreSQL 16+ a non-superuser
-- CREATEROLE migrator (postgres on hosted Supabase) can be a member with SET and INHERIT
-- off, so membership alone is not enough. INHERIT lets it act as owner for the grants below.
-- PostgreSQL 15 has neither the SET privilege nor the grant options: membership allows
-- SET ROLE there and inherits per the member's rolinherit. Dynamic SQL keeps 15 from
-- parsing the 16-only GRANT syntax.
DO $$ BEGIN
  IF current_setting('server_version_num')::int >= 160000 THEN
    IF NOT (pg_has_role(current_user, 'zs_dispatcher', 'SET') AND pg_has_role(current_user, 'zs_dispatcher', 'USAGE')) THEN
      EXECUTE format('GRANT zs_dispatcher TO %I WITH INHERIT TRUE, SET TRUE', current_user);
    END IF;
  ELSIF NOT pg_has_role(current_user, 'zs_dispatcher', 'MEMBER') THEN
    EXECUTE format('GRANT zs_dispatcher TO %I', current_user);
  END IF;
END $$;
-- Ownership transfer requires CREATE briefly; the role cannot create replacements afterward.
GRANT CREATE ON SCHEMA public TO zs_dispatcher;
ALTER FUNCTION public.record_action_and_event(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,text,jsonb,timestamptz,uuid,text,jsonb) OWNER TO zs_dispatcher;
REVOKE CREATE ON SCHEMA public FROM zs_dispatcher;
REVOKE ALL ON FUNCTION public.record_action_and_event(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,text,jsonb,timestamptz,uuid,text,jsonb) FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.record_action_and_event(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,text,jsonb,timestamptz,uuid,text,jsonb) FROM anon;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.record_action_and_event(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,text,jsonb,timestamptz,uuid,text,jsonb) TO authenticated;
