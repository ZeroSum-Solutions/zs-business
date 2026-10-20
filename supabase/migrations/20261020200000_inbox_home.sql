-- M3c Inbox v1 and Home (docs/requirements/inbox-home.md I-9, H-7). Inbox threads are read
-- from intake items and replies, so the only inbox table holds the business's replies. Home
-- reads deal value, lead source and won date. Every table has tenant_id, a tenant FK, forced
-- RLS with the shared tenant_scope policy, and tenant-qualified FKs.

-- H-2: a stage says whether a deal in it is open, won or lost. Pipelines and stages are
-- service-role setup, so existing stages named as a win or a loss are marked once here.
ALTER TABLE public.crm_stages ADD COLUMN outcome text NOT NULL DEFAULT 'open'
  CONSTRAINT crm_stages_outcome CHECK (outcome IN ('open', 'won', 'lost'));
-- Under FORCE ROW LEVEL SECURITY a migrator that is not a superuser sees no rows (see
-- 20261018090000), so the owner lifts FORCE for this one update; the ACCESS EXCLUSIVE lock
-- ALTER TABLE takes holds until commit, so no other session sees the table without it.
ALTER TABLE public.crm_stages NO FORCE ROW LEVEL SECURITY;
UPDATE public.crm_stages SET outcome = CASE
    WHEN lower(btrim(name)) IN ('won', 'closed won', 'closed - won', 'closed-won') THEN 'won'
    ELSE 'lost' END
  WHERE lower(btrim(name)) IN ('won', 'closed won', 'closed - won', 'closed-won',
    'lost', 'closed lost', 'closed - lost', 'closed-lost');
ALTER TABLE public.crm_stages FORCE ROW LEVEL SECURITY;

-- H-1: what a deal is worth, where the lead came from, and when it was won. All nullable, so
-- the C-24 seed INSERTs that list only the C-20 columns keep working.
ALTER TABLE public.crm_deals ADD COLUMN value_minor bigint
  CONSTRAINT crm_deals_value_range CHECK (value_minor BETWEEN 0 AND 9007199254740991);
ALTER TABLE public.crm_deals ADD COLUMN currency text
  CONSTRAINT crm_deals_currency_code CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE public.crm_deals ADD CONSTRAINT crm_deals_value_currency
  CHECK ((value_minor IS NULL) = (currency IS NULL));
ALTER TABLE public.crm_deals ADD COLUMN lead_source text
  CONSTRAINT crm_deals_lead_source CHECK (lead_source IN
    ('website', 'referral', 'phone', 'email', 'walk_in', 'social', 'ads', 'other'));
ALTER TABLE public.crm_deals ADD COLUMN won_at timestamptz;

-- H-2: won_at follows the stage. Entering a won stage stamps the write's own updated_at (the
-- dispatcher's injected clock, never the database clock); moving between won stages keeps the
-- first date; leaving the won outcome clears it. A trigger, so every write path agrees; it also
-- fires on a direct won_at write, so no role can set the date by hand.
CREATE FUNCTION public.crm_deals_won_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  stage_outcome text;
BEGIN
  SELECT s.outcome INTO stage_outcome FROM public.crm_stages s
   WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.stage_id;
  IF stage_outcome IS DISTINCT FROM 'won' THEN
    NEW.won_at := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD.won_at IS NULL THEN
    NEW.won_at := NEW.updated_at;
  ELSE
    NEW.won_at := OLD.won_at;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_deals_won_at
  BEFORE INSERT OR UPDATE OF stage_id, won_at ON public.crm_deals
  FOR EACH ROW EXECUTE FUNCTION public.crm_deals_won_at();

-- I-4: replies the business drafts. A reply names one customer; its text, customer and author
-- never change once drafted, so an approval of the reply is an approval of these exact words.
CREATE TABLE public.inbox_replies (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  contact_id uuid NOT NULL,
  channel text NOT NULL DEFAULT 'email' CONSTRAINT inbox_replies_channel CHECK (channel IN ('email')),
  subject text NOT NULL CONSTRAINT inbox_replies_subject_length CHECK (char_length(subject) BETWEEN 1 AND 200),
  body text NOT NULL CONSTRAINT inbox_replies_body_length CHECK (char_length(body) BETWEEN 1 AND 5000),
  status text NOT NULL DEFAULT 'draft'
    CONSTRAINT inbox_replies_status CHECK (status IN ('draft', 'approved', 'sent', 'failed', 'discarded')),
  drafted_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  approved_by uuid,
  approved_at timestamptz,
  discarded_by uuid,
  discarded_at timestamptz,
  settled_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES public.crm_contacts(tenant_id, id),
  CONSTRAINT inbox_replies_approval_state CHECK (
    (status IN ('approved', 'sent', 'failed')) = (approved_at IS NOT NULL AND approved_by IS NOT NULL)),
  CONSTRAINT inbox_replies_discard_state CHECK (
    (status = 'discarded') = (discarded_at IS NOT NULL AND discarded_by IS NOT NULL)),
  CONSTRAINT inbox_replies_settle_state CHECK ((status IN ('sent', 'failed')) = (settled_at IS NOT NULL))
);
CREATE INDEX inbox_replies_tenant_contact ON public.inbox_replies (tenant_id, contact_id, created_at);

-- I-4: the words and who they are for are fixed, and a reply only moves forward: draft to
-- approved or discarded, approved to sent or failed. This holds for every role, the service
-- role and the table owner included; grants alone would not stop a privileged writer. Deletes
-- stay possible for the service role, which erasing a customer will need.
CREATE FUNCTION public.inbox_replies_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.subject IS DISTINCT FROM OLD.subject OR NEW.body IS DISTINCT FROM OLD.body OR NEW.drafted_by IS DISTINCT FROM OLD.drafted_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A drafted reply cannot change its subject, text, customer or author'
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'inbox_replies',
        CONSTRAINT = 'inbox_replies_guard';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('approved', 'discarded'))
    OR (OLD.status = 'approved' AND NEW.status IN ('sent', 'failed'))) THEN
    RAISE EXCEPTION 'A reply cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'inbox_replies',
        CONSTRAINT = 'inbox_replies_guard';
  END IF;
  -- A step that happened keeps its actor and time through every later step; no step changes
  -- without a status change.
  IF (OLD.approved_at IS NOT NULL
        AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at))
    OR (OLD.discarded_at IS NOT NULL
        AND (NEW.discarded_by IS DISTINCT FROM OLD.discarded_by OR NEW.discarded_at IS DISTINCT FROM OLD.discarded_at))
    OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at)
    OR (NEW.status = OLD.status AND (
       NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR NEW.discarded_by IS DISTINCT FROM OLD.discarded_by OR NEW.discarded_at IS DISTINCT FROM OLD.discarded_at
    OR NEW.settled_at IS DISTINCT FROM OLD.settled_at)) THEN
    RAISE EXCEPTION 'A reply keeps the record of each step it took'
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'inbox_replies',
        CONSTRAINT = 'inbox_replies_guard';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inbox_replies_guard
  BEFORE UPDATE ON public.inbox_replies
  FOR EACH ROW EXECUTE FUNCTION public.inbox_replies_guard();

REVOKE ALL ON FUNCTION public.crm_deals_won_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inbox_replies_guard() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.crm_deals_won_at() FROM anon;
    REVOKE ALL ON FUNCTION public.inbox_replies_guard() FROM anon;
  END IF;
END $$;
-- Same owner as every invoker function (20261018090000); CREATE only for the transfer.
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.crm_deals_won_at() OWNER TO zs_function_owner;
ALTER FUNCTION public.inbox_replies_guard() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;

ALTER TABLE public.inbox_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_replies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.inbox_replies TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON public.inbox_replies FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.inbox_replies FROM anon;
  END IF;
END $$;
-- Runtime drafts, approves and discards through the dispatcher. It inserts the draft columns
-- only, so every new row starts as a draft with no steps (status defaults to draft). Only the
-- delivery worker, with the service role, records sent or failed (settled_at), so runtime
-- cannot claim a send.
GRANT SELECT ON public.inbox_replies TO authenticated;
GRANT INSERT (tenant_id, id, contact_id, channel, subject, body, drafted_by, created_at)
  ON public.inbox_replies TO authenticated;
GRANT UPDATE (status, approved_by, approved_at, discarded_by, discarded_at) ON public.inbox_replies TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbox_replies TO service_role;

-- H-1: runtime sets value, currency and lead source through crm.deal.set-details; won_at is
-- written only by the trigger above.
GRANT UPDATE (value_minor, currency, lead_source) ON public.crm_deals TO authenticated;

-- Read paths. Inbox: a customer's website requests, and the visitors not yet linked to one.
-- Home: contacts, bookings and won deals in a week.
CREATE INDEX intake_items_tenant_contact ON public.intake_items (tenant_id, contact_id, created_at)
  WHERE contact_id IS NOT NULL;
CREATE INDEX intake_items_tenant_unlinked ON public.intake_items (tenant_id, created_at DESC, id)
  WHERE contact_id IS NULL;
CREATE INDEX bookings_tenant_created ON public.bookings (tenant_id, created_at);
CREATE INDEX crm_deals_tenant_won ON public.crm_deals (tenant_id, won_at) WHERE won_at IS NOT NULL;
