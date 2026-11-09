-- Outreach sequencer review fixes (docs/requirements/outreach-sequencer.md, "As built"): the runtime role can no longer
-- start a campaign or reopen a stopped prospect by writing the rows directly, the inbound reader keeps a resume point,
-- the worker rotates mailboxes by their last attempt, and a follow-up remembers when its Message-ID lookup first failed.
-- Additive only: three nullable columns, one grant and two invoker triggers. Nothing schedules or sends anything.

-- OS-19: the Gmail page token the inbound reader resumes from when one run cannot read all of a mailbox's new history.
-- OS-13: when a run last leased the mailbox, so a mailbox that keeps failing cannot starve the others.
ALTER TABLE public.outreach_mailboxes
  ADD COLUMN history_resume_token text CONSTRAINT outreach_mailboxes_resume_token CHECK (char_length(history_resume_token) BETWEEN 1 AND 2000),
  ADD COLUMN last_attempt_at timestamptz;
-- OS-14: when a follow-up first failed to read the previous step's Message-ID; the 24 hour wait counts from it.
ALTER TABLE public.outreach_sends ADD COLUMN message_id_first_failed_at timestamptz;

-- OS-19: after a history gap the worker pauses the mailbox; reconnecting it (the operator command) clears the pause.
GRANT UPDATE (paused_until, pause_reason) ON public.outreach_mailboxes TO authenticated;

-- OS-8, OS-24: the runtime role (the owner path and PostgREST alike) may start a campaign only against an approved
-- activation approval of this very campaign, may never complete or un-draft one, and may not swap the approval of an
-- active one. Invoker function: current_user is the role running the statement.
CREATE FUNCTION public.outreach_campaigns_runtime_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user <> 'authenticated' OR TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (NEW.status IN ('draft', 'completed') OR OLD.status = 'completed') THEN
    RAISE EXCEPTION 'The runtime role may not set an outreach campaign %', NEW.status
      USING ERRCODE = 'insufficient_privilege', SCHEMA = 'public', TABLE = 'outreach_campaigns', COLUMN = 'status';
  END IF;
  IF NEW.activation_approval_id IS DISTINCT FROM OLD.activation_approval_id AND NEW.status <> 'active' THEN
    RAISE EXCEPTION 'The runtime role may change the activation approval of an active outreach campaign only'
      USING ERRCODE = 'insufficient_privilege', SCHEMA = 'public', TABLE = 'outreach_campaigns', COLUMN = 'activation_approval_id';
  END IF;
  IF NEW.status = 'active' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.activation_approval_id IS DISTINCT FROM OLD.activation_approval_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.approvals a
        WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.activation_approval_id AND a.status = 'approved'
          AND a.action_type = 'outreach.campaign.activate' AND a.target_type = 'outreach_campaign' AND a.target_id = NEW.id) THEN
    RAISE EXCEPTION 'An outreach campaign starts only with an approved activation of that campaign'
      USING ERRCODE = 'insufficient_privilege', SCHEMA = 'public', TABLE = 'outreach_campaigns', COLUMN = 'status';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outreach_campaigns_runtime_guard
  BEFORE UPDATE ON public.outreach_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.outreach_campaigns_runtime_guard();

-- OS-7, OS-9: the runtime role may start a pending prospect or stop an open one, and nothing else: a replied, bounced,
-- unsubscribed, completed or stopped prospect never reopens, and a running schedule is not rewritten.
CREATE FUNCTION public.outreach_prospects_runtime_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user <> 'authenticated' OR TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'pending' AND NEW.status IN ('active', 'stopped')) OR (OLD.status = 'active' AND NEW.status = 'stopped')) THEN
    RAISE EXCEPTION 'The runtime role may not move an outreach prospect from % to %', OLD.status, NEW.status
      USING ERRCODE = 'insufficient_privilege', SCHEMA = 'public', TABLE = 'outreach_prospects', COLUMN = 'status';
  END IF;
  IF NEW.status = OLD.status AND OLD.status <> 'pending'
     AND (NEW.next_step IS DISTINCT FROM OLD.next_step OR NEW.next_due_on IS DISTINCT FROM OLD.next_due_on) THEN
    RAISE EXCEPTION 'The runtime role may not reschedule an outreach prospect'
      USING ERRCODE = 'insufficient_privilege', SCHEMA = 'public', TABLE = 'outreach_prospects', COLUMN = 'next_due_on';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outreach_prospects_runtime_guard
  BEFORE UPDATE ON public.outreach_prospects
  FOR EACH ROW EXECUTE FUNCTION public.outreach_prospects_runtime_guard();

REVOKE ALL ON FUNCTION public.outreach_campaigns_runtime_guard(), public.outreach_prospects_runtime_guard() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.outreach_campaigns_runtime_guard(), public.outreach_prospects_runtime_guard() FROM anon;
  END IF;
END $$;
-- Same owner as every invoker function (20261018090000); CREATE only for the transfer.
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.outreach_campaigns_runtime_guard() OWNER TO zs_function_owner;
ALTER FUNCTION public.outreach_prospects_runtime_guard() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;
