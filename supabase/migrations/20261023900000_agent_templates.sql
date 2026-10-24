-- Message templates for the templated agent kinds (docs/requirements/agents.md G-19, G-20) and
-- the standing approval of one revision (approvals.md A-15). Every tenant table has tenant_id, a
-- tenant FK, forced RLS with the shared tenant_scope policy and tenant-qualified FKs.
--
-- A revision is immutable: the runtime role may insert it and may set only standing_approval_id
-- (the grant action, A-15). A template row names its kind and its current revision; a new
-- revision becomes current in the same transaction that revokes the old revision's grants.

CREATE TABLE public.message_templates (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  -- One template per templated kind and tenant.
  agent_kind text NOT NULL CONSTRAINT message_templates_kind CHECK (agent_kind IN ('appointment_reminder', 'review_request')),
  current_revision integer NOT NULL CONSTRAINT message_templates_current_revision CHECK (current_revision >= 1),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT message_templates_kind_key UNIQUE (tenant_id, agent_kind)
);

CREATE TABLE public.message_template_revisions (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  template_id uuid NOT NULL,
  revision integer NOT NULL CONSTRAINT message_template_revisions_revision CHECK (revision >= 1),
  channel text NOT NULL CONSTRAINT message_template_revisions_channel CHECK (channel IN ('email', 'sms')),
  purpose text NOT NULL CONSTRAINT message_template_revisions_purpose CHECK (purpose IN ('transactional', 'marketing')),
  -- An email has a one-line subject; a text message has none (delivery.md D-1).
  subject text,
  body text NOT NULL CONSTRAINT message_template_revisions_body CHECK (char_length(body) BETWEEN 1 AND 20000),
  -- The variable names the wording uses, sorted (G-19 allows at most five per kind).
  variables text[] NOT NULL DEFAULT '{}' CONSTRAINT message_template_revisions_variables CHECK (cardinality(variables) <= 5),
  timing_hours integer NOT NULL CONSTRAINT message_template_revisions_timing CHECK (timing_hours BETWEEN 1 AND 720),
  -- A-15: SHA-256 over kind, channel, purpose, subject, body, variable names and timing.
  content_digest text NOT NULL CONSTRAINT message_template_revisions_digest CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  -- The approval that grants sends from this revision; set once by template.standing.grant.
  standing_approval_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT message_template_revisions_number UNIQUE (tenant_id, template_id, revision),
  FOREIGN KEY (tenant_id, template_id) REFERENCES public.message_templates(tenant_id, id),
  FOREIGN KEY (tenant_id, standing_approval_id) REFERENCES public.approvals(tenant_id, id),
  CONSTRAINT message_template_revisions_subject CHECK (
    (channel = 'email' AND subject IS NOT NULL AND char_length(subject) BETWEEN 1 AND 200 AND subject !~ '[\r\n]')
    OR (channel = 'sms' AND subject IS NULL)),
  CONSTRAINT message_template_revisions_sms_body CHECK (channel <> 'sms' OR char_length(body) <= 1530)
);
-- The current revision must exist. Checked at commit, so the first revision and its template
-- can be written in either order within one transaction.
ALTER TABLE public.message_templates
  ADD CONSTRAINT message_templates_current_fk FOREIGN KEY (tenant_id, id, current_revision)
    REFERENCES public.message_template_revisions(tenant_id, template_id, revision) DEFERRABLE INITIALLY DEFERRED;

-- A-11: the count of sends a standing approval covered.
CREATE INDEX message_template_revisions_approval ON public.message_template_revisions (tenant_id, standing_approval_id)
  WHERE standing_approval_id IS NOT NULL;

-- G-19, G-20: two more skip reasons for the templated kinds. `no_link` is a reminder with no
-- booking link to put in the text; `contact_cap` is a review request to a customer asked
-- recently (G-20's one request per customer in contactWindowDays).
ALTER TABLE public.agent_decisions DROP CONSTRAINT agent_decisions_reason;
ALTER TABLE public.agent_decisions ADD CONSTRAINT agent_decisions_reason CHECK (reason IN
  ('no_address', 'suppressed', 'consent_denied', 'consent_missing', 'template_not_approved', 'too_long',
   'model_error', 'model_invalid', 'global_killed', 'disabled', 'tenant_killed', 'quiet_hours', 'daily_cap', 'cost_cap',
   'no_link', 'contact_cap'));
-- G-19: one message per booking ever, whichever run decided it. A skip does not use it up.
CREATE UNIQUE INDEX agent_decisions_one_message ON public.agent_decisions (tenant_id, agent_kind, subject_id)
  WHERE outcome = 'queued' AND agent_kind IN ('appointment_reminder', 'review_request');
-- A-11 sends covered, G-20 customer window.
CREATE INDEX agent_decisions_approval ON public.agent_decisions (tenant_id, approval_id) WHERE approval_id IS NOT NULL;
CREATE INDEX agent_decisions_queued_contact ON public.agent_decisions (tenant_id, agent_kind, contact_id, created_at)
  WHERE outcome = 'queued';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['message_templates','message_template_revisions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO authenticated
      USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$p$, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, authenticated, service_role', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO authenticated', t);
  END LOOP;
END $$;
-- Nothing edits a revision (A-15). The grant sets standing_approval_id; a new revision moves the template's pointer.
-- FOR SHARE (the queue action's checks) needs some UPDATE column grant on the table.
GRANT UPDATE (current_revision) ON public.message_templates TO authenticated;
GRANT UPDATE (standing_approval_id) ON public.message_template_revisions TO authenticated;
