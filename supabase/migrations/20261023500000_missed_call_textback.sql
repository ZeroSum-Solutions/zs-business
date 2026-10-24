-- Missed-call text-back, first slice (docs/requirements/twilio.md T-10..T-14). Every relationship
-- includes tenant_id; every table forces RLS with the tenant_scope policy. An operator sets the
-- voice number and the disclosure wording as the service role; calls, consents and voicemails are
-- written through the dispatcher (runtime role). Consent evidence and disclosure wording are
-- append-only for every role, the table owner included (as public-intake.md P-8 does).

-- T-10: the voice number is the tenant's SMS number, so the text comes from the number the caller
-- rang. A composite key lets voice_numbers name it with tenant_id inside the reference.
ALTER TABLE public.sms_numbers ADD CONSTRAINT sms_numbers_tenant_phone_unique UNIQUE (tenant_id, phone_number);

CREATE TABLE public.voice_textback_disclosures (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  version text NOT NULL CONSTRAINT voice_textback_disclosures_version CHECK (version ~ '^[A-Za-z0-9._-]{1,40}$'),
  text text NOT NULL CONSTRAINT voice_textback_disclosures_text_length CHECK (char_length(text) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, version)
);

CREATE TABLE public.voice_numbers (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(tenant_id),
  phone_number text NOT NULL CONSTRAINT voice_numbers_e164 CHECK (phone_number ~ '^\+[1-9][0-9]{1,14}$'),
  forward_to_e164 text NOT NULL CONSTRAINT voice_numbers_forward_e164 CHECK (forward_to_e164 ~ '^\+[1-9][0-9]{1,14}$'),
  ring_seconds integer NOT NULL DEFAULT 20 CONSTRAINT voice_numbers_ring_seconds CHECK (ring_seconds BETWEEN 5 AND 45),
  textback_enabled boolean NOT NULL DEFAULT false,
  booking_url text CONSTRAINT voice_numbers_booking_url CHECK (booking_url ~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]+)?([/?#][^[:space:]<>"]*)?$' AND char_length(booking_url) <= 300),
  disclosure_version text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT voice_numbers_phone_unique UNIQUE (phone_number),
  -- Turning the text-back on needs the link it sends and the words the caller hears.
  CONSTRAINT voice_numbers_textback_complete CHECK (NOT textback_enabled OR (booking_url IS NOT NULL AND disclosure_version IS NOT NULL)),
  FOREIGN KEY (tenant_id, phone_number) REFERENCES public.sms_numbers(tenant_id, phone_number) ON UPDATE CASCADE,
  FOREIGN KEY (tenant_id, disclosure_version) REFERENCES public.voice_textback_disclosures(tenant_id, version)
);

-- T-14: one row per tenant and CallSid. The dial step fills the decision columns once.
CREATE TABLE public.voice_calls (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  call_sid text NOT NULL CONSTRAINT voice_calls_call_sid CHECK (call_sid ~ '^CA[0-9a-f]{32}$'),
  from_e164 text CONSTRAINT voice_calls_from_e164 CHECK (from_e164 ~ '^\+[1-9][0-9]{1,14}$'),
  to_e164 text NOT NULL CONSTRAINT voice_calls_to_e164 CHECK (to_e164 ~ '^\+[1-9][0-9]{1,14}$'),
  dial_status text CONSTRAINT voice_calls_dial_status CHECK (dial_status IN ('completed','busy','no-answer','failed','canceled')),
  offered boolean,
  offer_reason text CONSTRAINT voice_calls_offer_reason CHECK (offer_reason IN (
    'answered','canceled','disabled','no_caller_number','suppressed','sms_denied','limit','limiter_unavailable','mailbox_full','offered')),
  -- False when the voicemail limit refused this call or the limiter could not answer (T-14).
  mailbox_open boolean,
  -- The wording the caller was offered; the gather callback must name the same version (T-12).
  disclosure_version text,
  -- T-14: the answer given to the first incoming webhook; a repeat replays it exactly.
  incoming_twiml text NOT NULL CONSTRAINT voice_calls_incoming_twiml CHECK (char_length(incoming_twiml) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, call_sid),
  CONSTRAINT voice_calls_dial_decided CHECK ((dial_status IS NULL) = (offered IS NULL)
    AND (dial_status IS NULL) = (offer_reason IS NULL) AND (dial_status IS NULL) = (mailbox_open IS NULL)),
  CONSTRAINT voice_calls_offer_has_version CHECK (offered IS DISTINCT FROM true OR disclosure_version IS NOT NULL),
  FOREIGN KEY (tenant_id, disclosure_version) REFERENCES public.voice_textback_disclosures(tenant_id, version)
);

-- T-12: what the caller heard when they pressed 1. Unique per call; append-only.
CREATE TABLE public.voice_textback_consents (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  call_sid text NOT NULL,
  contact_id uuid NOT NULL,
  caller_e164 text NOT NULL CONSTRAINT voice_textback_consents_e164 CHECK (caller_e164 ~ '^\+[1-9][0-9]{1,14}$'),
  disclosure_version text NOT NULL,
  disclosure_text text NOT NULL CONSTRAINT voice_textback_consents_text_length CHECK (char_length(disclosure_text) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, call_sid),
  FOREIGN KEY (tenant_id, call_sid) REFERENCES public.voice_calls(tenant_id, call_sid),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES public.crm_contacts(tenant_id, id),
  FOREIGN KEY (tenant_id, disclosure_version) REFERENCES public.voice_textback_disclosures(tenant_id, version)
);

-- T-13: one voicemail per call. `recording_sid` is cleared when the audio is deleted at Twilio.
CREATE TABLE public.voicemails (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  call_sid text NOT NULL,
  caller_e164 text CONSTRAINT voicemails_caller_e164 CHECK (caller_e164 ~ '^\+[1-9][0-9]{1,14}$'),
  contact_id uuid,
  recording_sid text CONSTRAINT voicemails_recording_sid CHECK (recording_sid ~ '^RE[0-9a-f]{32}$'),
  duration_seconds integer NOT NULL CONSTRAINT voicemails_duration CHECK (duration_seconds BETWEEN 1 AND 600),
  status text NOT NULL DEFAULT 'new' CONSTRAINT voicemails_status CHECK (status IN ('new','reviewed')),
  recorded_at timestamptz NOT NULL,
  audio_expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT voicemails_one_per_call UNIQUE (tenant_id, call_sid),
  FOREIGN KEY (tenant_id, call_sid) REFERENCES public.voice_calls(tenant_id, call_sid),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES public.crm_contacts(tenant_id, id)
);
CREATE INDEX voicemails_tenant_recorded ON public.voicemails (tenant_id, recorded_at DESC);

-- Append-only for every role: grants already withhold UPDATE and DELETE; the triggers hold against
-- the table owner too, so recorded wording and consent cannot be rewritten.
CREATE FUNCTION public.voice_textback_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Voice text-back evidence is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege', SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME;
END $$;
CREATE TRIGGER voice_textback_disclosures_append_only
  BEFORE UPDATE OR DELETE ON public.voice_textback_disclosures
  FOR EACH ROW EXECUTE FUNCTION public.voice_textback_append_only();
CREATE TRIGGER voice_textback_disclosures_no_truncate
  BEFORE TRUNCATE ON public.voice_textback_disclosures
  FOR EACH STATEMENT EXECUTE FUNCTION public.voice_textback_append_only();
CREATE TRIGGER voice_textback_consents_append_only
  BEFORE UPDATE OR DELETE ON public.voice_textback_consents
  FOR EACH ROW EXECUTE FUNCTION public.voice_textback_append_only();
CREATE TRIGGER voice_textback_consents_no_truncate
  BEFORE TRUNCATE ON public.voice_textback_consents
  FOR EACH STATEMENT EXECUTE FUNCTION public.voice_textback_append_only();

REVOKE ALL ON FUNCTION public.voice_textback_append_only() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.voice_textback_append_only() FROM anon;
  END IF;
END $$;
-- Same owner as every invoker function (20261018090000); CREATE only for the transfer.
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.voice_textback_append_only() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['voice_textback_disclosures','voice_numbers','voice_calls','voice_textback_consents','voicemails'] LOOP
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

-- T-10: numbers and wording are set by an operator, never by a member.
GRANT SELECT, INSERT ON public.voice_textback_disclosures TO service_role;
GRANT SELECT, INSERT, UPDATE (phone_number, forward_to_e164, ring_seconds, textback_enabled, booking_url, disclosure_version, updated_at),
  DELETE ON public.voice_numbers TO service_role;
-- Calls, consents and voicemails are written by the voice actions (runtime role) only.
GRANT INSERT (tenant_id, call_sid, from_e164, to_e164, incoming_twiml, created_at) ON public.voice_calls TO authenticated;
GRANT UPDATE (dial_status, offered, offer_reason, mailbox_open, disclosure_version) ON public.voice_calls TO authenticated;
GRANT INSERT ON public.voice_textback_consents TO authenticated;
GRANT INSERT ON public.voicemails TO authenticated;
-- The service role (operators, the catalog fixtures) reads and seeds these like sms_status_events.
GRANT SELECT, INSERT ON public.voice_calls, public.voice_textback_consents, public.voicemails TO service_role;
