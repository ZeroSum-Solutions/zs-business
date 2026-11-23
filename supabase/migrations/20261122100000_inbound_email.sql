-- Inbound email, slice 1: receive, dark (docs/requirements/inbound-email.md IE-2, IE-3, IE-9, IE-31, IE-35).
-- Two tenant tables: the hub-issued addresses mail is routed by, and one row per received message. Forced RLS
-- with the shared tenant_scope policy. Only the service role writes addresses. The runtime role inserts a
-- received row through the dispatcher (inbound.email.receive) and, from slice 2 on, settles and links it.
-- Nothing here fetches, stores or shows a message body.

-- IE-2: handles are 16 characters of lower-case base32, 80 random bits. The database has no pgcrypto, so the
-- bits come from gen_random_uuid() (a version 4 UUID): bytes 0..5 and 10..13 are random in full (the version
-- and variant bits sit in bytes 6 and 8).
CREATE FUNCTION public.inbound_email_new_handle() RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  raw bytea := uuid_send(gen_random_uuid());
  bits bytea;
  alphabet constant text := 'abcdefghijklmnopqrstuvwxyz234567';
  handle text := '';
  chunk bigint;
BEGIN
  bits := substring(raw FROM 1 FOR 6) || substring(raw FROM 11 FOR 4);
  FOR half IN 0..1 LOOP
    chunk := 0;
    FOR i IN 0..4 LOOP
      chunk := chunk * 256 + get_byte(bits, half * 5 + i);
    END LOOP;
    FOR shift IN REVERSE 7..0 LOOP
      handle := handle || substr(alphabet, ((chunk >> (shift * 5)) & 31)::integer + 1, 1);
    END LOOP;
  END LOOP;
  RETURN handle;
END $$;

CREATE TABLE public.inbound_email_addresses (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  handle text NOT NULL CONSTRAINT inbound_email_addresses_handle CHECK (handle ~ '^[a-z2-7]{16}$'),
  kind text NOT NULL DEFAULT 'reply' CONSTRAINT inbound_email_addresses_kind CHECK (kind IN ('reply')),
  status text NOT NULL DEFAULT 'active' CONSTRAINT inbound_email_addresses_status CHECK (status IN ('active', 'retiring', 'disabled')),
  created_at timestamptz NOT NULL,
  retire_after timestamptz,
  disabled_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  -- A handle names one tenant, across all tenants (IE-3 routes on it alone).
  CONSTRAINT inbound_email_addresses_handle_unique UNIQUE (handle),
  CONSTRAINT inbound_email_addresses_retiring CHECK ((status = 'retiring') = (retire_after IS NOT NULL)),
  CONSTRAINT inbound_email_addresses_disabled CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);
-- IE-2: at most one active reply address per tenant.
CREATE UNIQUE INDEX inbound_email_addresses_one_active ON public.inbound_email_addresses (tenant_id)
  WHERE status = 'active' AND kind = 'reply';

-- IE-12: at most the last 20 Message-IDs of at most 255 characters, one line each.
CREATE FUNCTION public.inbound_emails_references_valid(refs text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT cardinality(refs) <= 20 AND array_ndims(refs) IS NOT DISTINCT FROM 1 AND NOT EXISTS (
    SELECT 1 FROM unnest(refs) AS r(v) WHERE v IS NULL OR char_length(v) NOT BETWEEN 1 AND 255 OR v ~ '[\r\n]')
$$;

CREATE TABLE public.inbound_emails (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  address_id uuid,
  mailbox_id uuid,
  provider text NOT NULL CONSTRAINT inbound_emails_provider CHECK (provider IN ('resend', 'gmail')),
  provider_email_id text NOT NULL CONSTRAINT inbound_emails_provider_email_id CHECK (
    char_length(provider_email_id) BETWEEN 1 AND 200 AND provider_email_id !~ '[[:cntrl:]]'),
  -- IE-6: the reply reference after `+` in the recipient, as received (it picks no tenant).
  reply_ref text CONSTRAINT inbound_emails_reply_ref CHECK (reply_ref ~ '^[a-z2-7]{16}$'),
  status text NOT NULL DEFAULT 'received' CONSTRAINT inbound_emails_status CHECK (status IN ('received', 'ready', 'dropped')),
  drop_reason text CONSTRAINT inbound_emails_drop_reason CHECK (drop_reason IN ('bounce', 'loop')),
  kind text NOT NULL DEFAULT 'unclassified' CONSTRAINT inbound_emails_kind CHECK (kind IN ('message', 'automated', 'spam', 'unclassified')),
  from_address text NOT NULL CONSTRAINT inbound_emails_from_address CHECK (
    char_length(from_address) BETWEEN 1 AND 320 AND from_address !~ '[[:cntrl:]]'),
  from_name text CONSTRAINT inbound_emails_from_name CHECK (char_length(from_name) <= 200 AND from_name !~ '[\r\n]'),
  subject text CONSTRAINT inbound_emails_subject CHECK (char_length(subject) <= 200 AND subject !~ '[\r\n]'),
  received_at timestamptz NOT NULL,
  rfc_message_id text CONSTRAINT inbound_emails_rfc_message_id CHECK (
    char_length(rfc_message_id) BETWEEN 1 AND 255 AND rfc_message_id !~ '[\r\n]'),
  in_reply_to text CONSTRAINT inbound_emails_in_reply_to CHECK (char_length(in_reply_to) BETWEEN 1 AND 255 AND in_reply_to !~ '[\r\n]'),
  "references" text[] CONSTRAINT inbound_emails_references CHECK ("references" IS NULL OR public.inbound_emails_references_valid("references")),
  auth text CONSTRAINT inbound_emails_auth CHECK (auth IN ('pass', 'fail', 'none')),
  body_text text CONSTRAINT inbound_emails_body_text CHECK (char_length(body_text) <= 20000),
  body_state text NOT NULL DEFAULT 'none' CONSTRAINT inbound_emails_body_state CHECK (body_state IN (
    'none', 'full', 'truncated', 'too_large', 'over_limit', 'over_quota', 'unavailable', 'erased')),
  html_only boolean,
  attachments jsonb CONSTRAINT inbound_emails_attachments CHECK (
    jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 20),
  contact_id uuid,
  match text CONSTRAINT inbound_emails_match CHECK (match IN ('header', 'reply_ref', 'address', 'linked', 'none')),
  review text CONSTRAINT inbound_emails_review CHECK (review IN ('matched', 'possible_match', 'unmatched', 'linked', 'rejected')),
  candidate_contact_ids uuid[] CONSTRAINT inbound_emails_candidates CHECK (cardinality(candidate_contact_ids) <= 20),
  -- IE-21: derivedId(tenantId, "inbound-sender", normalised From); the sender thread is e_<sender_key>.
  sender_key uuid NOT NULL,
  duplicate_of uuid,
  lease_token uuid,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CONSTRAINT inbound_emails_attempts CHECK (attempts BETWEEN 0 AND 1000),
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL,
  settled_at timestamptz,
  linked_by uuid,
  linked_at timestamptz,
  erased_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  -- IE-9: Resend's email_id is the receive key; a redelivered webhook finds the row it wrote.
  CONSTRAINT inbound_emails_provider_unique UNIQUE (tenant_id, provider, provider_email_id),
  FOREIGN KEY (tenant_id, address_id) REFERENCES public.inbound_email_addresses(tenant_id, id),
  FOREIGN KEY (tenant_id, mailbox_id) REFERENCES public.outreach_mailboxes(tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES public.crm_contacts(tenant_id, id),
  FOREIGN KEY (tenant_id, duplicate_of) REFERENCES public.inbound_emails(tenant_id, id),
  CONSTRAINT inbound_emails_resend_address CHECK ((provider = 'resend') = (address_id IS NOT NULL)),
  CONSTRAINT inbound_emails_gmail_mailbox CHECK ((provider = 'gmail') = (mailbox_id IS NOT NULL)),
  CONSTRAINT inbound_emails_dropped CHECK ((status = 'dropped') = (drop_reason IS NOT NULL)),
  CONSTRAINT inbound_emails_contact_review CHECK ((contact_id IS NOT NULL) = coalesce(review IN ('matched', 'linked'), false)),
  CONSTRAINT inbound_emails_erased CHECK ((erased_at IS NOT NULL) = (body_state = 'erased')),
  CONSTRAINT inbound_emails_settled CHECK ((status = 'received') = (settled_at IS NULL)),
  CONSTRAINT inbound_emails_lease_pair CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX inbound_emails_contact ON public.inbound_emails (tenant_id, contact_id, received_at);
CREATE INDEX inbound_emails_sender ON public.inbound_emails (tenant_id, sender_key, received_at);
CREATE INDEX inbound_emails_from ON public.inbound_emails (tenant_id, from_address, received_at);
CREATE INDEX inbound_emails_rfc_message ON public.inbound_emails (tenant_id, rfc_message_id);
-- IE-17: the admission count reads one tenant's last 24 hours.
CREATE INDEX inbound_emails_received ON public.inbound_emails (tenant_id, received_at);
-- Serve the address, mailbox and duplicate foreign keys.
CREATE INDEX inbound_emails_address ON public.inbound_emails (tenant_id, address_id);
CREATE INDEX inbound_emails_mailbox ON public.inbound_emails (tenant_id, mailbox_id);
CREATE INDEX inbound_emails_duplicate ON public.inbound_emails (tenant_id, duplicate_of);

-- IE-35: the content guard holds for every role, the service role and the table owner included.
CREATE FUNCTION public.inbound_emails_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  settling boolean;
  settlement_changed boolean;
  link_changed boolean;
  lease_changed boolean;
  erasure boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user <> 'service_role' THEN
      RAISE EXCEPTION 'Only the service role deletes inbound email' USING ERRCODE = 'insufficient_privilege',
        SCHEMA = 'public', TABLE = 'inbound_emails';
    END IF;
    RETURN OLD;
  END IF;

  IF (NEW.tenant_id, NEW.id, NEW.address_id, NEW.mailbox_id, NEW.provider, NEW.provider_email_id, NEW.reply_ref,
      NEW.from_address, NEW.sender_key, NEW.received_at, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.address_id, OLD.mailbox_id, OLD.provider, OLD.provider_email_id,
      OLD.reply_ref, OLD.from_address, OLD.sender_key, OLD.received_at, OLD.created_at) THEN
    RAISE EXCEPTION 'The receive columns of an inbound email never change' USING ERRCODE = 'check_violation',
      SCHEMA = 'public', TABLE = 'inbound_emails', CONSTRAINT = 'inbound_emails_guard';
  END IF;

  settling := OLD.status = 'received' AND NEW.status IN ('ready', 'dropped');
  settlement_changed := (NEW.status, NEW.drop_reason, NEW.kind, NEW.from_name, NEW.subject, NEW.rfc_message_id,
      NEW.in_reply_to, NEW."references", NEW.auth, NEW.body_text, NEW.body_state, NEW.html_only, NEW.attachments,
      NEW.match, NEW.candidate_contact_ids, NEW.duplicate_of, NEW.settled_at)
    IS DISTINCT FROM (OLD.status, OLD.drop_reason, OLD.kind, OLD.from_name, OLD.subject, OLD.rfc_message_id,
      OLD.in_reply_to, OLD."references", OLD.auth, OLD.body_text, OLD.body_state, OLD.html_only, OLD.attachments,
      OLD.match, OLD.candidate_contact_ids, OLD.duplicate_of, OLD.settled_at);
  link_changed := (NEW.contact_id, NEW.review, NEW.linked_by, NEW.linked_at)
    IS DISTINCT FROM (OLD.contact_id, OLD.review, OLD.linked_by, OLD.linked_at);
  lease_changed := (NEW.lease_token, NEW.lease_expires_at, NEW.attempts, NEW.next_attempt_at)
    IS DISTINCT FROM (OLD.lease_token, OLD.lease_expires_at, OLD.attempts, OLD.next_attempt_at);
  -- The one erasure: these six to null, body_state to erased, erased_at set, nothing else, after settle, once.
  erasure := OLD.status <> 'received' AND OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL
    AND NEW.body_state = 'erased' AND NEW.body_text IS NULL AND NEW.from_name IS NULL AND NEW.subject IS NULL
    AND NEW.attachments IS NULL AND NEW.in_reply_to IS NULL AND NEW."references" IS NULL
    AND (NEW.status, NEW.drop_reason, NEW.kind, NEW.rfc_message_id, NEW.auth, NEW.html_only, NEW.match,
      NEW.candidate_contact_ids, NEW.duplicate_of, NEW.settled_at)
      IS NOT DISTINCT FROM (OLD.status, OLD.drop_reason, OLD.kind, OLD.rfc_message_id, OLD.auth, OLD.html_only,
      OLD.match, OLD.candidate_contact_ids, OLD.duplicate_of, OLD.settled_at)
    AND NOT link_changed AND NOT lease_changed;

  IF erasure THEN
    IF current_user <> 'service_role' THEN
      RAISE EXCEPTION 'Only the service role erases inbound email' USING ERRCODE = 'insufficient_privilege',
        SCHEMA = 'public', TABLE = 'inbound_emails';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.erased_at IS DISTINCT FROM OLD.erased_at OR (settlement_changed AND NOT settling) THEN
    RAISE EXCEPTION 'The content of an inbound email changes only at its one settle or its one erasure'
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'inbound_emails', CONSTRAINT = 'inbound_emails_guard';
  END IF;
  IF lease_changed AND OLD.status <> 'received' THEN
    RAISE EXCEPTION 'The lease of an inbound email changes only while it is received'
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'inbound_emails', CONSTRAINT = 'inbound_emails_guard';
  END IF;
  -- Link columns: at the settle, by link (possible_match or unmatched to linked), by reject (to rejected).
  IF link_changed AND NOT settling AND NOT coalesce(
       OLD.review IN ('possible_match', 'unmatched') AND NEW.review IN ('linked', 'rejected'), false) THEN
    RAISE EXCEPTION 'The link of an inbound email changes only at settle, link or reject'
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'inbound_emails', CONSTRAINT = 'inbound_emails_guard';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inbound_emails_guard
  BEFORE UPDATE OR DELETE ON public.inbound_emails
  FOR EACH ROW EXECUTE FUNCTION public.inbound_emails_guard();

-- IE-3: the only way the runtime role learns a tenant from a handle. Definer (zs_dispatcher), pinned path; it
-- returns the tenant and the address of an active or retiring address, and nothing for a disabled or unknown one.
CREATE FUNCTION public.inbound_email_route(p_handle text)
RETURNS TABLE (tenant_id uuid, address_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.tenant_id, a.id FROM public.inbound_email_addresses a
   WHERE a.handle = p_handle AND a.status IN ('active', 'retiring')
$$;

ALTER TABLE public.inbound_email_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_email_addresses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.inbound_email_addresses TO authenticated
  USING (tenant_id = nullif((SELECT current_setting('app.tenant_id',true)),'')::uuid)
  WITH CHECK (tenant_id = nullif((SELECT current_setting('app.tenant_id',true)),'')::uuid);
-- The route function reads every tenant's handles as zs_dispatcher, and only through itself.
CREATE POLICY inbound_route ON public.inbound_email_addresses FOR SELECT TO zs_dispatcher USING (true);
ALTER TABLE public.inbound_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_emails FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.inbound_emails TO authenticated
  USING (tenant_id = nullif((SELECT current_setting('app.tenant_id',true)),'')::uuid)
  WITH CHECK (tenant_id = nullif((SELECT current_setting('app.tenant_id',true)),'')::uuid);

REVOKE ALL ON public.inbound_email_addresses, public.inbound_emails FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.inbound_email_addresses, public.inbound_emails FROM anon;
  END IF;
END $$;

-- IE-31. Service role: writes addresses (provisioning, rotation, disabling), leases, erases and deletes.
GRANT SELECT, INSERT, UPDATE ON public.inbound_email_addresses TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbound_emails TO service_role;
GRANT SELECT (tenant_id, id, handle, status) ON public.inbound_email_addresses TO zs_dispatcher;
-- Runtime role: reads its tenant's addresses, and its emails without the lease columns.
GRANT SELECT ON public.inbound_email_addresses TO authenticated;
GRANT SELECT (tenant_id, id, address_id, mailbox_id, provider, provider_email_id, reply_ref, status, drop_reason, kind,
  from_address, from_name, subject, received_at, rfc_message_id, in_reply_to, "references", auth, body_text, body_state,
  html_only, attachments, contact_id, match, review, candidate_contact_ids, sender_key, duplicate_of, created_at,
  settled_at, linked_by, linked_at, erased_at) ON public.inbound_emails TO authenticated;
-- IE-9: the receive columns. Status, kind and body_state come from their defaults (received, unclassified, none),
-- so no insert can skip the settle. mailbox_id joins with slice 6.
GRANT INSERT (tenant_id, id, address_id, provider, provider_email_id, reply_ref, from_address, subject, received_at,
  sender_key, created_at) ON public.inbound_emails TO authenticated;
-- IE-11 settle and IE-25 link (slices 2 and 3); the guard limits each to its one move.
GRANT UPDATE (status, drop_reason, kind, from_name, subject, rfc_message_id, in_reply_to, "references", auth, body_text,
  body_state, html_only, attachments, match, candidate_contact_ids, duplicate_of, settled_at,
  contact_id, review, linked_by, linked_at) ON public.inbound_emails TO authenticated;

-- IE-2: one active reply address for every tenant, created with the tenant. Tenants are inserted by the service
-- role (provisioning, seeds), which may write the table.
CREATE FUNCTION public.inbound_email_addresses_create() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO public.inbound_email_addresses (tenant_id, id, handle, kind, status, created_at)
  VALUES (NEW.tenant_id, gen_random_uuid(), public.inbound_email_new_handle(), 'reply', 'active', now());
  RETURN NULL;
END $$;

-- Backfill: an address for every existing tenant. Under FORCE ROW LEVEL SECURITY a migrator that is not a
-- superuser sees no tenants; the table owner lifts FORCE for the copy only (as 20261023100000 does).
ALTER TABLE public.tenants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_email_addresses NO FORCE ROW LEVEL SECURITY;
INSERT INTO public.inbound_email_addresses (tenant_id, id, handle, kind, status, created_at)
  SELECT t.tenant_id, gen_random_uuid(), public.inbound_email_new_handle(), 'reply', 'active', now()
  FROM public.tenants t
  WHERE NOT EXISTS (SELECT 1 FROM public.inbound_email_addresses a WHERE a.tenant_id = t.tenant_id);
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_email_addresses FORCE ROW LEVEL SECURITY;

-- Created after the backfill, so a tenant inserted from here on gets its address.
CREATE TRIGGER inbound_email_addresses_create
  AFTER INSERT ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.inbound_email_addresses_create();

-- Owners as every function: invoker functions with zs_function_owner (20261018090000), the definer with
-- zs_dispatcher (20261017160000). CREATE only for the transfer.
REVOKE ALL ON FUNCTION public.inbound_email_new_handle() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inbound_emails_references_valid(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inbound_emails_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inbound_email_addresses_create() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inbound_email_route(text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.inbound_email_new_handle() FROM anon;
    REVOKE ALL ON FUNCTION public.inbound_emails_references_valid(text[]) FROM anon;
    REVOKE ALL ON FUNCTION public.inbound_emails_guard() FROM anon;
    REVOKE ALL ON FUNCTION public.inbound_email_addresses_create() FROM anon;
    REVOKE ALL ON FUNCTION public.inbound_email_route(text) FROM anon;
  END IF;
END $$;
-- The tenant-insert trigger runs as the role inserting the tenant (the service role); a CHECK runs as the writer.
GRANT EXECUTE ON FUNCTION public.inbound_email_new_handle() TO service_role;
GRANT EXECUTE ON FUNCTION public.inbound_emails_references_valid(text[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inbound_email_route(text) TO authenticated, service_role;
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.inbound_email_new_handle() OWNER TO zs_function_owner;
ALTER FUNCTION public.inbound_emails_references_valid(text[]) OWNER TO zs_function_owner;
ALTER FUNCTION public.inbound_emails_guard() OWNER TO zs_function_owner;
ALTER FUNCTION public.inbound_email_addresses_create() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;
GRANT CREATE ON SCHEMA public TO zs_dispatcher;
ALTER FUNCTION public.inbound_email_route(text) OWNER TO zs_dispatcher;
REVOKE CREATE ON SCHEMA public FROM zs_dispatcher;
