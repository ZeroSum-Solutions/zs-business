-- M3d prepaid wallet and message delivery (docs/requirements/delivery.md D-1..D-10).
-- Every relationship includes tenant_id; every table forces RLS. The delivery worker runs as
-- the service role (outbox processing); runtime roles read, and write suppressions only
-- through the dispatcher.

-- D-4: one wallet per tenant. The constraints are the overdraw guard: no update can leave
-- the balance or the reserved amount negative, or reserve more than the balance.
CREATE TABLE public.wallets (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(tenant_id),
  currency text NOT NULL DEFAULT 'usd' CONSTRAINT wallets_currency CHECK (currency ~ '^[a-z]{3}$'),
  balance bigint NOT NULL DEFAULT 0 CONSTRAINT wallets_balance_nonnegative CHECK (balance >= 0),
  reserved bigint NOT NULL DEFAULT 0 CONSTRAINT wallets_reserved_nonnegative CHECK (reserved >= 0),
  updated_at timestamptz NOT NULL,
  CONSTRAINT wallets_reserved_within_balance CHECK (reserved <= balance)
);

-- D-4: every balance change, append-only. Credits add, captures subtract the reservation they
-- settle; one row per idempotency key, so a retried credit or capture cannot apply twice.
CREATE TABLE public.wallet_ledger (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'credit' CONSTRAINT wallet_ledger_kind CHECK (kind IN ('credit', 'capture', 'adjustment')),
  amount bigint NOT NULL CONSTRAINT wallet_ledger_amount_nonzero CHECK (amount <> 0),
  reservation_id uuid,
  idempotency_key text NOT NULL CONSTRAINT wallet_ledger_key_length CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  note text CONSTRAINT wallet_ledger_note_length CHECK (char_length(note) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT wallet_ledger_tenant_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT wallet_ledger_kind_sign CHECK (
    (kind <> 'credit' OR amount > 0) AND (kind <> 'capture' OR (amount < 0 AND reservation_id IS NOT NULL)))
);

-- D-1..D-3, D-7, D-8: one row per message to send, with its lease and outcome state.
CREATE TABLE public.message_deliveries (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  message_id uuid NOT NULL,
  channel public.crm_consent_channel NOT NULL,
  purpose text NOT NULL DEFAULT 'transactional' CONSTRAINT message_deliveries_purpose CHECK (purpose IN ('transactional', 'marketing')),
  contact_id uuid NOT NULL,
  -- The action that committed the event; its approval is re-checked before every attempt (D-6).
  action_id uuid NOT NULL,
  -- The contracts schema requires a subject for email; SQL keeps SMS without one.
  subject text CONSTRAINT message_deliveries_subject_length CHECK (char_length(subject) BETWEEN 1 AND 998),
  body text NOT NULL CONSTRAINT message_deliveries_body_length CHECK (char_length(body) BETWEEN 1 AND 20000),
  status text NOT NULL DEFAULT 'pending'
    CONSTRAINT message_deliveries_status CHECK (status IN ('pending', 'leased', 'uncertain', 'sent', 'blocked', 'dead')),
  -- An attempt started and no definite answer is recorded: a send may have happened (D-7).
  outcome_unknown boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0 CONSTRAINT message_deliveries_attempts CHECK (attempts BETWEEN 0 AND 1000),
  next_attempt_at timestamptz NOT NULL,
  first_attempt_at timestamptz,
  lease_token uuid,
  lease_owner text CONSTRAINT message_deliveries_lease_owner_length CHECK (char_length(lease_owner) BETWEEN 1 AND 200),
  lease_expires_at timestamptz,
  -- The provider key is the same for every attempt of one delivery (D-8).
  idempotency_key text NOT NULL CONSTRAINT message_deliveries_key_length CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  -- Pinned when the first attempt starts, so a retry goes where the first try went.
  recipient_address text CONSTRAINT message_deliveries_recipient_length CHECK (char_length(recipient_address) BETWEEN 1 AND 254),
  provider text CONSTRAINT message_deliveries_provider_length CHECK (char_length(provider) BETWEEN 1 AND 100),
  -- D-8: what the first attempt sent (subject, text, headers). Later attempts under the same key
  -- replay it exactly, so a config change (an unsubscribe secret rotation) never alters a resend.
  -- json, not jsonb, keeps the stored text as written.
  request json CONSTRAINT message_deliveries_request_shape
    CHECK (json_typeof(request) = 'object' AND octet_length(request::text) <= 65536),
  -- Steps that threw inside the worker; at the cap the delivery is a dead letter `worker_error`.
  step_errors integer NOT NULL DEFAULT 0 CONSTRAINT message_deliveries_step_errors CHECK (step_errors BETWEEN 0 AND 1000),
  provider_message_id text CONSTRAINT message_deliveries_provider_id_length CHECK (char_length(provider_message_id) BETWEEN 1 AND 500),
  last_error text CONSTRAINT message_deliveries_last_error_length CHECK (char_length(last_error) BETWEEN 1 AND 500),
  final_reason text CONSTRAINT message_deliveries_final_reason_length CHECK (char_length(final_reason) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT message_deliveries_tenant_outbox UNIQUE (tenant_id, outbox_id),
  CONSTRAINT message_deliveries_tenant_message UNIQUE (tenant_id, message_id),
  CONSTRAINT message_deliveries_tenant_key UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, outbox_id) REFERENCES public.outbox(tenant_id, id),
  FOREIGN KEY (tenant_id, action_id) REFERENCES public.actions(tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES public.crm_contacts(tenant_id, id),
  CONSTRAINT message_deliveries_sms_subject CHECK (channel <> 'sms' OR subject IS NULL),
  CONSTRAINT message_deliveries_lease_state CHECK (
    (status = 'leased') = (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CONSTRAINT message_deliveries_sent_state CHECK ((status = 'sent') = (provider_message_id IS NOT NULL)),
  CONSTRAINT message_deliveries_final_state CHECK ((status IN ('blocked', 'dead')) = (final_reason IS NOT NULL)),
  -- Only a leased, uncertain or dead delivery may hold an unknown outcome; dead keeps it
  -- until an operator settles the held reservation (D-8).
  CONSTRAINT message_deliveries_unknown_state CHECK (
    (status <> 'uncertain' OR outcome_unknown) AND (status NOT IN ('pending', 'sent', 'blocked') OR NOT outcome_unknown))
);
-- The worker claims across tenants as the service role.
CREATE INDEX message_deliveries_due ON public.message_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'uncertain');
CREATE INDEX message_deliveries_lease_expiry ON public.message_deliveries (lease_expires_at)
  WHERE status = 'leased';
CREATE INDEX message_deliveries_tenant_status ON public.message_deliveries (tenant_id, status, created_at DESC);

-- D-7: one row per provider attempt; an attempt with no outcome was cut off mid-send.
CREATE TABLE public.message_delivery_attempts (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  delivery_id uuid NOT NULL,
  attempt integer NOT NULL CONSTRAINT message_delivery_attempts_number CHECK (attempt BETWEEN 1 AND 1000),
  kind text NOT NULL DEFAULT 'send' CONSTRAINT message_delivery_attempts_kind CHECK (kind IN ('send', 'lookup')),
  started_at timestamptz NOT NULL,
  outcome text CONSTRAINT message_delivery_attempts_outcome
    CHECK (outcome IN ('accepted', 'rejected', 'failed', 'uncertain', 'not_found', 'unknown')),
  error_code text CONSTRAINT message_delivery_attempts_error_length CHECK (char_length(error_code) BETWEEN 1 AND 200),
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, delivery_id, attempt),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES public.message_deliveries(tenant_id, id),
  CONSTRAINT message_delivery_attempts_finished CHECK ((outcome IS NULL) = (finished_at IS NULL))
);

-- D-5, D-8: money held for one delivery's send. It settles once: held -> captured | released.
CREATE TABLE public.wallet_reservations (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  amount bigint NOT NULL CONSTRAINT wallet_reservations_amount_positive CHECK (amount > 0),
  status text NOT NULL DEFAULT 'held' CONSTRAINT wallet_reservations_status CHECK (status IN ('held', 'captured', 'released')),
  created_at timestamptz NOT NULL,
  settled_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES public.message_deliveries(tenant_id, id),
  CONSTRAINT wallet_reservations_settled CHECK ((status = 'held') = (settled_at IS NULL))
);
CREATE UNIQUE INDEX wallet_reservations_one_held ON public.wallet_reservations (tenant_id, delivery_id)
  WHERE status = 'held';
CREATE UNIQUE INDEX wallet_reservations_one_capture ON public.wallet_reservations (tenant_id, delivery_id)
  WHERE status = 'captured';
ALTER TABLE public.wallet_ledger ADD CONSTRAINT wallet_ledger_reservation_fk
  FOREIGN KEY (tenant_id, reservation_id) REFERENCES public.wallet_reservations(tenant_id, id);
CREATE UNIQUE INDEX wallet_ledger_one_capture ON public.wallet_ledger (tenant_id, reservation_id)
  WHERE kind = 'capture';

-- D-9: addresses that must not be messaged. The contracts schema validates the address; SQL
-- keeps it canonical and an SMS address in E.164.
CREATE TABLE public.suppressions (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  channel public.crm_consent_channel NOT NULL,
  address text NOT NULL CONSTRAINT suppressions_address_canonical
    CHECK (char_length(address) BETWEEN 1 AND 254 AND address = lower(address)),
  reason text NOT NULL DEFAULT 'unsubscribe'
    CONSTRAINT suppressions_reason CHECK (reason IN ('unsubscribe', 'stop', 'bounce', 'complaint', 'manual')),
  source text NOT NULL CONSTRAINT suppressions_source_length CHECK (char_length(source) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, channel, address),
  CONSTRAINT suppressions_sms_e164 CHECK (channel <> 'sms' OR address ~ '^\+[1-9][0-9]{1,14}$')
);

-- D-2: the ingest reads unprocessed rows of one event type.
CREATE INDEX outbox_unprocessed ON public.outbox (event_type, seq) WHERE processed_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wallets','wallet_ledger','wallet_reservations','message_deliveries',
    'message_delivery_attempts','suppressions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO authenticated
      USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$p$, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, authenticated, service_role', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    -- Runtime reads its own tenant's rows (wallet balance, delivery state, suppressions).
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

-- The worker (service role) moves state forward; nothing deletes delivery or money history.
GRANT SELECT, INSERT, UPDATE ON public.wallets, public.wallet_reservations, public.message_deliveries,
  public.message_delivery_attempts TO service_role;
-- D-4: the ledger is append-only for every role.
GRANT SELECT, INSERT ON public.wallet_ledger TO service_role;
-- D-9: suppressions are added and lifted through the dispatcher (runtime) or by provider
-- feedback (service role, M5). A lasting reason may replace `stop` on an existing row.
GRANT SELECT, INSERT, DELETE, UPDATE (reason, source) ON public.suppressions TO service_role;
GRANT INSERT (tenant_id, channel, address, reason, source, created_at), UPDATE (reason, source), DELETE
  ON public.suppressions TO authenticated;
