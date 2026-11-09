-- Outreach sequencer (docs/requirements/outreach-sequencer.md OS-3, OS-4, OS-7, OS-15, OS-19, OS-24): cold email
-- sent from the tenant's own Google Workspace mailboxes. Seven tenant tables: tenant_id, tenant FK, every relationship
-- keyed with tenant_id, forced RLS with the shared tenant_scope policy. Owner intent (mailbox connect, campaign create,
-- prospect import, activate, pause, stop) is written through the dispatcher as the runtime role. The worker (service
-- role) leases mailboxes, records every send attempt before the Gmail call, settles it, and records inbound events.
-- Nothing here schedules or sends anything.

-- OS-3: one row per connected mailbox. The sealed refresh token is a calendar-format `zsg1` token (OS-21): only the
-- outreach worker's private key opens it, and the runtime role cannot read the column at all.
CREATE TABLE public.outreach_mailboxes (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  email text NOT NULL CONSTRAINT outreach_mailboxes_email CHECK (
    char_length(email) BETWEEN 3 AND 254 AND email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  -- Written into the From header (OS-17): no quote, angle bracket or line break.
  display_name text NOT NULL CONSTRAINT outreach_mailboxes_display_name CHECK (
    char_length(display_name) BETWEEN 1 AND 100 AND display_name !~ '["<>[:cntrl:]]'),
  status text NOT NULL DEFAULT 'active' CONSTRAINT outreach_mailboxes_status CHECK (status IN ('active', 'reauthorize', 'disconnected')),
  sealed_refresh_token text CONSTRAINT outreach_mailboxes_sealed_shape CHECK (
    char_length(sealed_refresh_token) <= 2866
    AND sealed_refresh_token ~ '^zsg1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}[A-Za-z0-9_-]*$'),
  granted_scopes text[] NOT NULL DEFAULT '{}',
  daily_limit integer NOT NULL DEFAULT 20 CONSTRAINT outreach_mailboxes_daily_limit CHECK (daily_limit BETWEEN 1 AND 50),
  -- OS-19: the Gmail history cursor, and when it was last read.
  history_id text CONSTRAINT outreach_mailboxes_history_id CHECK (char_length(history_id) BETWEEN 1 AND 40),
  history_checked_at timestamptz,
  paused_until timestamptz,
  pause_reason text CONSTRAINT outreach_mailboxes_pause_reason CHECK (char_length(pause_reason) BETWEEN 1 AND 100),
  -- OS-13: the worker's lease; every later write for the mailbox checks the token.
  lease_token uuid,
  lease_expires_at timestamptz,
  last_send_at timestamptz,
  connected_by uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT outreach_mailboxes_email_unique UNIQUE (tenant_id, email),
  CONSTRAINT outreach_mailboxes_token_state CHECK ((status = 'disconnected') = (sealed_refresh_token IS NULL)),
  CONSTRAINT outreach_mailboxes_lease_pair CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);
-- OS-13: the worker's lease query reads active mailboxes only.
CREATE INDEX outreach_mailboxes_active ON public.outreach_mailboxes (tenant_id, id) WHERE status = 'active';

-- OS-4: a campaign never changes after create except its status fields; a new version is a new campaign.
CREATE TABLE public.outreach_campaigns (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  name text NOT NULL CONSTRAINT outreach_campaigns_name CHECK (char_length(name) BETWEEN 1 AND 120 AND btrim(name) <> ''),
  status text NOT NULL DEFAULT 'draft' CONSTRAINT outreach_campaigns_status CHECK (status IN ('draft', 'active', 'paused', 'completed')),
  paused_reason text CONSTRAINT outreach_campaigns_paused_reason CHECK (char_length(paused_reason) BETWEEN 1 AND 100),
  window_start_min integer NOT NULL CONSTRAINT outreach_campaigns_window_start CHECK (window_start_min BETWEEN 0 AND 1439),
  window_end_min integer NOT NULL CONSTRAINT outreach_campaigns_window_end CHECK (window_end_min BETWEEN 0 AND 1439),
  daily_cap_per_mailbox integer NOT NULL DEFAULT 20 CONSTRAINT outreach_campaigns_cap CHECK (daily_cap_per_mailbox BETWEEN 1 AND 50),
  content_digest text NOT NULL CONSTRAINT outreach_campaigns_digest CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  activation_approval_id uuid,
  activated_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, activation_approval_id) REFERENCES public.approvals(tenant_id, id),
  CONSTRAINT outreach_campaigns_window CHECK (window_end_min - window_start_min >= 30),
  CONSTRAINT outreach_campaigns_paused_state CHECK (status = 'paused' OR paused_reason IS NULL),
  CONSTRAINT outreach_campaigns_active_state CHECK (status IN ('draft') OR activation_approval_id IS NOT NULL)
);
CREATE INDEX outreach_campaigns_approval ON public.outreach_campaigns (tenant_id, activation_approval_id);
CREATE INDEX outreach_campaigns_status ON public.outreach_campaigns (tenant_id, status);

-- OS-4: step 1 has a subject and no delay; steps 2..5 reuse step 1's subject (OS-5).
CREATE TABLE public.outreach_campaign_steps (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  campaign_id uuid NOT NULL,
  step_number integer NOT NULL CONSTRAINT outreach_campaign_steps_number CHECK (step_number BETWEEN 1 AND 5),
  delay_business_days integer NOT NULL,
  subject text CONSTRAINT outreach_campaign_steps_subject CHECK (char_length(subject) BETWEEN 1 AND 150 AND subject !~ '[\r\n]'),
  body text NOT NULL CONSTRAINT outreach_campaign_steps_body CHECK (char_length(body) BETWEEN 1 AND 5000),
  PRIMARY KEY (tenant_id, campaign_id, step_number),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES public.outreach_campaigns(tenant_id, id),
  CONSTRAINT outreach_campaign_steps_shape CHECK (
    (step_number = 1 AND subject IS NOT NULL AND delay_business_days = 0)
    OR (step_number > 1 AND subject IS NULL AND delay_business_days BETWEEN 1 AND 30))
);

CREATE TABLE public.outreach_campaign_mailboxes (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  campaign_id uuid NOT NULL,
  mailbox_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, campaign_id, mailbox_id),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES public.outreach_campaigns(tenant_id, id),
  FOREIGN KEY (tenant_id, mailbox_id) REFERENCES public.outreach_mailboxes(tenant_id, id)
);
CREATE INDEX outreach_campaign_mailboxes_mailbox ON public.outreach_campaign_mailboxes (tenant_id, mailbox_id);

-- OS-7: one row per address per tenant, across all campaigns (the unique key reserves the address for good).
CREATE TABLE public.outreach_prospects (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  mailbox_id uuid NOT NULL,
  email text NOT NULL CONSTRAINT outreach_prospects_email CHECK (
    char_length(email) BETWEEN 3 AND 254 AND email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  first_name text NOT NULL CONSTRAINT outreach_prospects_first_name CHECK (char_length(first_name) <= 100),
  last_name text CONSTRAINT outreach_prospects_last_name CHECK (char_length(last_name) BETWEEN 1 AND 100),
  company text NOT NULL CONSTRAINT outreach_prospects_company CHECK (char_length(company) <= 200),
  industry text CONSTRAINT outreach_prospects_industry CHECK (char_length(industry) <= 100),
  website text CONSTRAINT outreach_prospects_website CHECK (char_length(website) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'pending' CONSTRAINT outreach_prospects_status CHECK (status IN (
    'pending', 'excluded', 'active', 'completed', 'replied', 'owner_replied', 'bounced', 'unsubscribed', 'suppressed',
    'hard_suppressed', 'consent_denied', 'invalid_address', 'send_outcome_unknown', 'thread_unavailable', 'stopped')),
  next_step integer CONSTRAINT outreach_prospects_next_step CHECK (next_step BETWEEN 1 AND 5),
  -- OS-11: a local date in the tenant's time zone.
  next_due_on date,
  thread_id text CONSTRAINT outreach_prospects_thread CHECK (char_length(thread_id) BETWEEN 1 AND 100),
  stopped_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT outreach_prospects_email_unique UNIQUE (tenant_id, email),
  FOREIGN KEY (tenant_id, campaign_id, mailbox_id) REFERENCES public.outreach_campaign_mailboxes(tenant_id, campaign_id, mailbox_id),
  CONSTRAINT outreach_prospects_active_state CHECK (status <> 'active' OR (next_step IS NOT NULL AND next_due_on IS NOT NULL))
);
-- Also serves the foreign key above (its leading columns are tenant_id, campaign_id, mailbox_id).
CREATE INDEX outreach_prospects_campaign_mailbox ON public.outreach_prospects (tenant_id, campaign_id, mailbox_id, status);
-- OS-11, OS-14: the worker's due query.
CREATE INDEX outreach_prospects_due ON public.outreach_prospects (tenant_id, mailbox_id, status, next_due_on);

-- OS-15: every attempt is committed before the Gmail call. The partial unique index below is the at-most-once rule.
CREATE TABLE public.outreach_sends (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  prospect_id uuid NOT NULL,
  mailbox_id uuid NOT NULL,
  step_number integer NOT NULL CONSTRAINT outreach_sends_step CHECK (step_number BETWEEN 1 AND 5),
  status text NOT NULL CONSTRAINT outreach_sends_status CHECK (status IN ('sending', 'sent', 'uncertain', 'lost', 'not_sent', 'rejected')),
  recipient_address text NOT NULL CONSTRAINT outreach_sends_recipient CHECK (char_length(recipient_address) BETWEEN 3 AND 254),
  subject text NOT NULL CONSTRAINT outreach_sends_subject CHECK (char_length(subject) BETWEEN 1 AND 300 AND subject !~ '[\r\n]'),
  body text NOT NULL CONSTRAINT outreach_sends_body CHECK (char_length(body) BETWEEN 1 AND 20000),
  -- OS-12: the local date in the tenant's zone; the daily caps count by it.
  local_send_date date NOT NULL,
  attempt_started_at timestamptz NOT NULL,
  settled_at timestamptz,
  history_id_before text CONSTRAINT outreach_sends_history_before CHECK (char_length(history_id_before) BETWEEN 1 AND 40),
  gmail_message_id text CONSTRAINT outreach_sends_gmail_message CHECK (char_length(gmail_message_id) BETWEEN 1 AND 100),
  gmail_thread_id text CONSTRAINT outreach_sends_gmail_thread CHECK (char_length(gmail_thread_id) BETWEEN 1 AND 100),
  rfc_message_id text CONSTRAINT outreach_sends_rfc_message CHECK (char_length(rfc_message_id) BETWEEN 1 AND 998 AND rfc_message_id !~ '[\r\n]'),
  error_code text CONSTRAINT outreach_sends_error CHECK (char_length(error_code) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES public.outreach_campaigns(tenant_id, id),
  FOREIGN KEY (tenant_id, prospect_id) REFERENCES public.outreach_prospects(tenant_id, id),
  FOREIGN KEY (tenant_id, mailbox_id) REFERENCES public.outreach_mailboxes(tenant_id, id),
  CONSTRAINT outreach_sends_sent_state CHECK (status <> 'sent' OR gmail_message_id IS NOT NULL)
);
CREATE UNIQUE INDEX outreach_sends_one_attempt ON public.outreach_sends (tenant_id, prospect_id, step_number)
  WHERE status IN ('sending', 'sent', 'uncertain', 'lost');
-- Serves the prospect foreign key (a partial index cannot) and the previous-step lookups.
CREATE INDEX outreach_sends_prospect ON public.outreach_sends (tenant_id, prospect_id, step_number);
CREATE INDEX outreach_sends_mailbox_day ON public.outreach_sends (tenant_id, mailbox_id, local_send_date);
CREATE INDEX outreach_sends_campaign ON public.outreach_sends (tenant_id, campaign_id, status);
CREATE UNIQUE INDEX outreach_sends_gmail_message_unique ON public.outreach_sends (tenant_id, mailbox_id, gmail_message_id)
  WHERE gmail_message_id IS NOT NULL;

-- OS-19: one row per matched inbound message; the unique key makes a repeat change nothing.
CREATE TABLE public.outreach_inbound_events (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  mailbox_id uuid NOT NULL,
  gmail_message_id text NOT NULL CONSTRAINT outreach_inbound_message CHECK (char_length(gmail_message_id) BETWEEN 1 AND 100),
  gmail_thread_id text CONSTRAINT outreach_inbound_thread CHECK (char_length(gmail_thread_id) BETWEEN 1 AND 100),
  prospect_id uuid,
  kind text NOT NULL CONSTRAINT outreach_inbound_kind CHECK (kind IN ('reply', 'owner_reply', 'bounce', 'auto_reply')),
  received_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT outreach_inbound_unique UNIQUE (tenant_id, mailbox_id, gmail_message_id),
  FOREIGN KEY (tenant_id, mailbox_id) REFERENCES public.outreach_mailboxes(tenant_id, id),
  FOREIGN KEY (tenant_id, prospect_id) REFERENCES public.outreach_prospects(tenant_id, id)
);
CREATE INDEX outreach_inbound_prospect ON public.outreach_inbound_events (tenant_id, prospect_id);

-- OS-24: forced RLS with the shared tenant policy, read through a scalar subselect (rls-initplan.test.ts).
ALTER TABLE public.outreach_mailboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_mailboxes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.outreach_mailboxes TO authenticated
  USING (tenant_id = nullif((SELECT current_setting('app.tenant_id',true)),'')::uuid)
  WITH CHECK (tenant_id = nullif((SELECT current_setting('app.tenant_id',true)),'')::uuid);
ALTER TABLE public.outreach_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.outreach_campaigns TO authenticated
  USING (tenant_id = nullif((SELECT current_setting('app.tenant_id',true)),'')::uuid)
  WITH CHECK (tenant_id = nullif((SELECT current_setting('app.tenant_id',true)),'')::uuid);
ALTER TABLE public.outreach_campaign_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_campaign_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.outreach_campaign_steps TO authenticated
  USING (tenant_id = nullif((SELECT current_setting('app.tenant_id',true)),'')::uuid)
  WITH CHECK (tenant_id = nullif((SELECT current_setting('app.tenant_id',true)),'')::uuid);
ALTER TABLE public.outreach_campaign_mailboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_campaign_mailboxes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.outreach_campaign_mailboxes TO authenticated
  USING (tenant_id = nullif((SELECT current_setting('app.tenant_id',true)),'')::uuid)
  WITH CHECK (tenant_id = nullif((SELECT current_setting('app.tenant_id',true)),'')::uuid);
ALTER TABLE public.outreach_prospects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_prospects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.outreach_prospects TO authenticated
  USING (tenant_id = nullif((SELECT current_setting('app.tenant_id',true)),'')::uuid)
  WITH CHECK (tenant_id = nullif((SELECT current_setting('app.tenant_id',true)),'')::uuid);
ALTER TABLE public.outreach_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_sends FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.outreach_sends TO authenticated
  USING (tenant_id = nullif((SELECT current_setting('app.tenant_id',true)),'')::uuid)
  WITH CHECK (tenant_id = nullif((SELECT current_setting('app.tenant_id',true)),'')::uuid);
ALTER TABLE public.outreach_inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_inbound_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.outreach_inbound_events TO authenticated
  USING (tenant_id = nullif((SELECT current_setting('app.tenant_id',true)),'')::uuid)
  WITH CHECK (tenant_id = nullif((SELECT current_setting('app.tenant_id',true)),'')::uuid);

REVOKE ALL ON public.outreach_mailboxes, public.outreach_campaigns, public.outreach_campaign_steps,
  public.outreach_campaign_mailboxes, public.outreach_prospects, public.outreach_sends, public.outreach_inbound_events
  FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.outreach_mailboxes, public.outreach_campaigns, public.outreach_campaign_steps,
      public.outreach_campaign_mailboxes, public.outreach_prospects, public.outreach_sends, public.outreach_inbound_events FROM anon;
  END IF;
END $$;

-- Service role (the outreach worker): moves mailboxes, prospects and campaigns, records sends and inbound events.
-- It never updates or deletes a campaign's steps or its mailbox list (a campaign's content is fixed at create), never
-- deletes anything, and never updates an inbound event.
GRANT SELECT, INSERT, UPDATE ON public.outreach_mailboxes, public.outreach_campaigns, public.outreach_prospects,
  public.outreach_sends TO service_role;
GRANT SELECT, INSERT ON public.outreach_campaign_steps, public.outreach_campaign_mailboxes, public.outreach_inbound_events TO service_role;

-- Runtime role (OS-24). Reads everything except the sealed token, the history cursor and the lease of a mailbox.
GRANT SELECT (tenant_id, id, email, display_name, status, granted_scopes, daily_limit, paused_until, pause_reason,
  last_send_at, connected_by, created_at, updated_at) ON public.outreach_mailboxes TO authenticated;
GRANT SELECT ON public.outreach_campaigns, public.outreach_campaign_steps, public.outreach_campaign_mailboxes,
  public.outreach_prospects, public.outreach_sends, public.outreach_inbound_events TO authenticated;
-- A campaign is inserted as a draft: status and the activation columns come from defaults, so no insert can start one.
GRANT INSERT (tenant_id, id, email, display_name, status, sealed_refresh_token, granted_scopes, daily_limit, connected_by,
  created_at, updated_at) ON public.outreach_mailboxes TO authenticated;
GRANT INSERT (tenant_id, id, name, window_start_min, window_end_min, daily_cap_per_mailbox, content_digest, created_by,
  created_at, updated_at) ON public.outreach_campaigns TO authenticated;
GRANT INSERT ON public.outreach_campaign_steps, public.outreach_campaign_mailboxes TO authenticated;
GRANT INSERT (tenant_id, id, campaign_id, mailbox_id, email, first_name, last_name, company, industry, website, status,
  created_at, updated_at) ON public.outreach_prospects TO authenticated;
GRANT UPDATE (status, sealed_refresh_token, display_name, daily_limit, updated_at) ON public.outreach_mailboxes TO authenticated;
GRANT UPDATE (status, paused_reason, activation_approval_id, activated_at, updated_at) ON public.outreach_campaigns TO authenticated;
GRANT UPDATE (status, next_step, next_due_on, stopped_at, updated_at) ON public.outreach_prospects TO authenticated;

-- OS-24: the runtime role may insert a mailbox as active and set it active or disconnected; `reauthorize` is the
-- worker's word alone. Invoker function: current_user is the role running the statement.
CREATE FUNCTION public.outreach_mailboxes_runtime_status() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user = 'authenticated' AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status)
     AND NEW.status NOT IN ('active', 'disconnected') THEN
    RAISE EXCEPTION 'The runtime role may set an outreach mailbox active or disconnected only'
      USING ERRCODE = 'insufficient_privilege', SCHEMA = 'public', TABLE = 'outreach_mailboxes', COLUMN = 'status';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outreach_mailboxes_runtime_status
  BEFORE INSERT OR UPDATE OF status ON public.outreach_mailboxes
  FOR EACH ROW EXECUTE FUNCTION public.outreach_mailboxes_runtime_status();
REVOKE ALL ON FUNCTION public.outreach_mailboxes_runtime_status() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.outreach_mailboxes_runtime_status() FROM anon;
  END IF;
END $$;
-- Same owner as every invoker function (20261018090000); CREATE only for the transfer.
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.outreach_mailboxes_runtime_status() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;
