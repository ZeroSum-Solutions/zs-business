-- M5 Twilio SMS provider (docs/requirements/twilio.md T-5..T-7). Every relationship includes
-- tenant_id; every table forces RLS. An operator assigns numbers as the service role; status
-- evidence is written through the dispatcher (runtime role) and read by the delivery worker
-- (service role) to settle unknown outcomes.

-- T-7: the tenant's own sending number. A number belongs to one tenant, so an inbound text to it
-- names exactly one tenant.
CREATE TABLE public.sms_numbers (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(tenant_id),
  phone_number text NOT NULL CONSTRAINT sms_numbers_e164 CHECK (phone_number ~ '^\+[1-9][0-9]{1,14}$'),
  provider text NOT NULL DEFAULT 'twilio' CONSTRAINT sms_numbers_provider_length CHECK (char_length(provider) BETWEEN 1 AND 100),
  -- T-8: the HELP reply for this number (business name and contact); null uses the default.
  help_reply text CONSTRAINT sms_numbers_help_reply_length CHECK (char_length(help_reply) BETWEEN 1 AND 320),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT sms_numbers_phone_unique UNIQUE (phone_number)
);

-- T-5: one row per provider message and status, from a signed status callback. Any row proves
-- the provider created the message; repeats of one status are dropped by the unique key.
CREATE TABLE public.sms_status_events (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  provider_message_id text NOT NULL CONSTRAINT sms_status_events_message_length CHECK (char_length(provider_message_id) BETWEEN 1 AND 64),
  status text NOT NULL CONSTRAINT sms_status_events_status_word CHECK (status ~ '^[a-z_]{1,40}$'),
  error_code text CONSTRAINT sms_status_events_error_code CHECK (error_code ~ '^[0-9]{1,10}$'),
  received_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT sms_status_events_one_per_status UNIQUE (tenant_id, provider_message_id, status),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES public.message_deliveries(tenant_id, id)
);
CREATE INDEX sms_status_events_delivery ON public.sms_status_events (tenant_id, delivery_id, received_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sms_numbers','sms_status_events'] LOOP
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

-- T-7: numbers cost money and are assigned by an operator, never by a member.
GRANT SELECT, INSERT, UPDATE (phone_number, provider, help_reply, updated_at), DELETE ON public.sms_numbers TO service_role;
-- T-5: evidence is append-only for every role. The status-callback action adds rows; the worker
-- reads them.
GRANT INSERT (tenant_id, id, delivery_id, provider_message_id, status, error_code, received_at)
  ON public.sms_status_events TO authenticated;
GRANT SELECT, INSERT ON public.sms_status_events TO service_role;
