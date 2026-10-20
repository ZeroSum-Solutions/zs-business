-- M5 Stripe wallet top-ups (docs/requirements/stripe.md S-1..S-7). Tenant tables include
-- tenant_id in every relationship and force RLS. Money moves only as the service role (D-4).

-- S-6: what a refund or dispute took back beyond the available balance. While it is above
-- zero the wallet reserves nothing; later credits repay it first.
ALTER TABLE public.wallets ADD COLUMN owed bigint NOT NULL DEFAULT 0
  CONSTRAINT wallets_owed_nonnegative CHECK (owed >= 0);

-- S-1, S-5: one row per top-up an owner starts.
CREATE TABLE public.wallet_topups (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  amount bigint NOT NULL CONSTRAINT wallet_topups_amount_positive CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'usd' CONSTRAINT wallet_topups_currency CHECK (currency ~ '^[a-z]{3}$'),
  status text NOT NULL DEFAULT 'pending'
    CONSTRAINT wallet_topups_status CHECK (status IN ('pending', 'paid', 'failed', 'expired', 'mismatch')),
  created_by uuid NOT NULL,
  stripe_checkout_session_id text CONSTRAINT wallet_topups_session_length CHECK (char_length(stripe_checkout_session_id) BETWEEN 1 AND 255),
  stripe_payment_intent_id text CONSTRAINT wallet_topups_intent_length CHECK (char_length(stripe_payment_intent_id) BETWEEN 1 AND 255),
  -- S-6: the refund total already debited (the charge's amount_refunded is a running total).
  refunded bigint NOT NULL DEFAULT 0 CONSTRAINT wallet_topups_refunded CHECK (refunded >= 0 AND refunded <= amount),
  created_at timestamptz NOT NULL,
  paid_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT wallet_topups_paid_state CHECK ((status = 'paid') = (paid_at IS NOT NULL))
);
-- Stripe IDs are global; the worker finds a top-up by its payment for charge and dispute events.
CREATE UNIQUE INDEX wallet_topups_session ON public.wallet_topups (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
CREATE UNIQUE INDEX wallet_topups_intent ON public.wallet_topups (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- S-6: each refund step, dispute withdrawal or reinstatement, once per Stripe reference.
DO $$ BEGIN
  CREATE TYPE public.wallet_billing_event_kind AS ENUM ('refund', 'dispute_withdrawn', 'dispute_reinstated');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE public.wallet_billing_events (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  topup_id uuid NOT NULL,
  kind public.wallet_billing_event_kind NOT NULL,
  reference text NOT NULL CONSTRAINT wallet_billing_events_reference_length CHECK (char_length(reference) BETWEEN 1 AND 300),
  -- The whole amount; `applied` came from (or went to) the balance, `owed` the rest.
  amount bigint NOT NULL CONSTRAINT wallet_billing_events_amount_positive CHECK (amount > 0),
  applied bigint NOT NULL CONSTRAINT wallet_billing_events_applied CHECK (applied >= 0 AND applied <= amount),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT wallet_billing_events_once UNIQUE (tenant_id, kind, reference),
  FOREIGN KEY (tenant_id, topup_id) REFERENCES public.wallet_topups(tenant_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wallet_topups','wallet_billing_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO authenticated
      USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$p$, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, authenticated, service_role', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;
-- S-1: the action inserts a pending top-up; money and Stripe columns are the worker's.
GRANT INSERT (tenant_id, id, amount, currency, created_by, created_at, updated_at) ON public.wallet_topups TO authenticated;
GRANT SELECT, INSERT, UPDATE (status, stripe_checkout_session_id, stripe_payment_intent_id, refunded, paid_at, updated_at)
  ON public.wallet_topups TO service_role;
GRANT SELECT, INSERT ON public.wallet_billing_events TO service_role;

-- S-3: the webhook inbox. A platform table (one Stripe account), not a tenant table: the
-- runtime role may only insert an event, the service role reads and marks it processed.
CREATE TABLE public.stripe_events (
  id text PRIMARY KEY CONSTRAINT stripe_events_id CHECK (id ~ '^evt_[A-Za-z0-9_]{1,250}$'),
  type text NOT NULL CONSTRAINT stripe_events_type_length CHECK (char_length(type) BETWEEN 1 AND 100),
  payload jsonb NOT NULL CONSTRAINT stripe_events_payload_size CHECK (octet_length(payload::text) <= 262144),
  received_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CONSTRAINT stripe_events_attempts CHECK (attempts BETWEEN 0 AND 1000),
  processed_at timestamptz,
  outcome text CONSTRAINT stripe_events_outcome_length CHECK (char_length(outcome) BETWEEN 1 AND 100),
  last_error text CONSTRAINT stripe_events_error_length CHECK (char_length(last_error) BETWEEN 1 AND 500),
  CONSTRAINT stripe_events_processed CHECK ((processed_at IS NULL) = (outcome IS NULL))
);
CREATE INDEX stripe_events_due ON public.stripe_events (next_attempt_at) WHERE processed_at IS NULL;
ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_events FORCE ROW LEVEL SECURITY;
-- Only the webhook's platform transaction (db.platform) sets app.platform; a runtime-role request
-- through the Data API cannot, so it cannot plant an unsigned event (S-3).
CREATE POLICY stripe_events_intake ON public.stripe_events FOR INSERT TO authenticated
  WITH CHECK (processed_at IS NULL AND attempts = 0 AND current_setting('app.platform', true) = 'on');
REVOKE ALL ON public.stripe_events FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON public.stripe_events FROM anon; END IF;
END $$;
GRANT INSERT (id, type, payload, received_at, next_attempt_at) ON public.stripe_events TO authenticated;
GRANT SELECT, UPDATE (attempts, next_attempt_at, processed_at, outcome, last_error) ON public.stripe_events TO service_role;
