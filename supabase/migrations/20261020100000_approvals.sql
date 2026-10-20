-- M3b approval record (docs/requirements/approvals.md A-1..A-4). One row is one proposed
-- action: the dispatcher binding without its actor. An owner's decision makes it runnable;
-- the approved action then commits once through the shared dispatcher (A-7).

CREATE TABLE public.approvals (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  action_type text NOT NULL CONSTRAINT approvals_action_type_length CHECK (char_length(action_type) BETWEEN 1 AND 100),
  target_type text NOT NULL CONSTRAINT approvals_target_type_length CHECK (char_length(target_type) BETWEEN 1 AND 100),
  target_id uuid NOT NULL,
  payload jsonb NOT NULL,
  summary text NOT NULL CONSTRAINT approvals_summary_length CHECK (char_length(summary) BETWEEN 1 AND 500),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CONSTRAINT approvals_status CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text CONSTRAINT approvals_decision_note_length CHECK (char_length(decision_note) BETWEEN 1 AND 500),
  revoked_by uuid,
  revoked_at timestamptz,
  revoke_note text CONSTRAINT approvals_revoke_note_length CHECK (char_length(revoke_note) BETWEEN 1 AND 500),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT approvals_expiry CHECK (expires_at > requested_at),
  -- A-2: pending has no decision; approved and rejected have one; a revoked approval keeps
  -- the decision it had (none when a pending request was withdrawn).
  CONSTRAINT approvals_decision_state CHECK (CASE status
    WHEN 'pending' THEN decided_by IS NULL AND decided_at IS NULL AND decision_note IS NULL
    WHEN 'revoked' THEN (decided_by IS NULL) = (decided_at IS NULL)
    ELSE decided_by IS NOT NULL AND decided_at IS NOT NULL END),
  CONSTRAINT approvals_revocation_state CHECK (
    (status = 'revoked') = (revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
    AND (status = 'revoked' OR revoke_note IS NULL))
);
CREATE INDEX approvals_tenant_status ON public.approvals (tenant_id, status, requested_at DESC, id);
CREATE INDEX approvals_tenant_requested ON public.approvals (tenant_id, requested_at DESC, id);
CREATE INDEX approvals_tenant_requester ON public.approvals (tenant_id, requested_by, requested_at DESC, id);

-- A-2: only the allowed transitions, and a decision once made stays made. Column grants
-- already keep the runtime role off the binding columns (A-4); this holds for every role
-- that can UPDATE, so a handler bug cannot reopen a rejected or revoked approval.
CREATE FUNCTION public.approvals_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT (OLD.status = NEW.status
      OR (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'revoked'))
      OR (OLD.status = 'approved' AND NEW.status = 'revoked'))
    OR (OLD.status IN ('rejected', 'revoked') AND NEW IS DISTINCT FROM OLD)
    OR (OLD.decided_by IS NOT NULL AND (NEW.decided_by, NEW.decided_at, NEW.decision_note)
      IS DISTINCT FROM (OLD.decided_by, OLD.decided_at, OLD.decision_note)) THEN
    RAISE EXCEPTION 'Approval % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'approvals',
        CONSTRAINT = 'approvals_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approvals_transition
  BEFORE UPDATE ON public.approvals
  FOR EACH ROW EXECUTE FUNCTION public.approvals_transition();
REVOKE ALL ON FUNCTION public.approvals_transition() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.approvals_transition() FROM anon;
  END IF;
END $$;
-- Same owner as every invoker function (20261018090000); CREATE only for the transfer.
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.approvals_transition() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;

ALTER TABLE public.approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.approvals TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON public.approvals FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.approvals FROM anon;
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.approvals TO service_role;
-- Runtime writes come only from the approval actions, through the dispatcher (A-4).
GRANT SELECT ON public.approvals TO authenticated;
GRANT INSERT (tenant_id, id, action_type, target_type, target_id, payload, summary, requested_by, requested_at, expires_at)
  ON public.approvals TO authenticated;
GRANT UPDATE (status, decided_by, decided_at, decision_note, revoked_by, revoked_at, revoke_note)
  ON public.approvals TO authenticated;
