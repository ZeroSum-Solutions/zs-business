-- M5 Google Calendar busy sync (docs/requirements/google-calendar.md G-4..G-11). Tenant tables
-- include tenant_id in every relationship and force RLS. External blocks and pushes are written
-- only by the service-role calendar worker, under the B-21 resource lock.

DO $$ BEGIN
  CREATE TYPE public.calendar_connection_status AS ENUM ('active', 'reauthorize', 'disconnecting', 'disconnected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE public.calendar_push_status AS ENUM ('pending', 'pushed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- G-4: one row per Google grant for one booking resource.
CREATE TABLE public.calendar_connections (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  resource_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'google' CONSTRAINT calendar_connections_provider CHECK (provider = 'google'),
  calendar_id text NOT NULL DEFAULT 'primary' CONSTRAINT calendar_connections_calendar_length CHECK (char_length(calendar_id) BETWEEN 1 AND 255),
  account_email text CONSTRAINT calendar_connections_email_length CHECK (char_length(account_email) BETWEEN 3 AND 254),
  -- The connect action always names 'active'; the default is the state that holds no grant.
  status public.calendar_connection_status NOT NULL DEFAULT 'disconnected',
  -- G-3: zsg1.<ephemeral key>.<iv>.<ciphertext>; only the worker's private key opens it.
  refresh_token_sealed text CONSTRAINT calendar_connections_sealed_shape CHECK (refresh_token_sealed ~ '^zsg1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,2800}$'),
  scope text NOT NULL DEFAULT '' CONSTRAINT calendar_connections_scope_length CHECK (char_length(scope) <= 2000),
  created_by uuid NOT NULL,
  -- G-6: sync state, the worker's.
  sync_token text CONSTRAINT calendar_connections_sync_token_length CHECK (char_length(sync_token) BETWEEN 1 AND 2000),
  next_sync_at timestamptz NOT NULL,
  lease_until timestamptz,
  last_full_sync_at timestamptz,
  last_synced_at timestamptz,
  last_error text CONSTRAINT calendar_connections_error_length CHECK (char_length(last_error) BETWEEN 1 AND 200),
  -- G-8: the watch channel.
  channel_id uuid,
  channel_resource_id text CONSTRAINT calendar_connections_channel_resource_length CHECK (char_length(channel_resource_id) BETWEEN 1 AND 255),
  channel_expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES public.booking_resources(tenant_id, id),
  -- A grant to use exists exactly while the connection is not disconnected (G-9).
  CONSTRAINT calendar_connections_token_state CHECK ((status = 'disconnected') = (refresh_token_sealed IS NULL)),
  CONSTRAINT calendar_connections_channel_state CHECK ((channel_id IS NULL) = (channel_expires_at IS NULL))
);
CREATE UNIQUE INDEX calendar_connections_one_per_resource ON public.calendar_connections (tenant_id, resource_id)
  WHERE status <> 'disconnected';
-- Channel IDs are global: a push names only its channel (G-8).
CREATE UNIQUE INDEX calendar_connections_channel ON public.calendar_connections (channel_id) WHERE channel_id IS NOT NULL;
CREATE INDEX calendar_connections_due ON public.calendar_connections (next_sync_at) WHERE status IN ('active', 'disconnecting');

-- G-7: a block that came from a connection names it and the Google event, once per connection.
ALTER TABLE public.booking_external_blocks
  ADD COLUMN connection_id uuid,
  ADD COLUMN external_id text CONSTRAINT booking_external_blocks_external_length CHECK (char_length(external_id) BETWEEN 1 AND 1024),
  ADD CONSTRAINT booking_external_blocks_connection_pair CHECK ((connection_id IS NULL) = (external_id IS NULL)),
  ADD CONSTRAINT booking_external_blocks_connection_fk FOREIGN KEY (tenant_id, connection_id)
    REFERENCES public.calendar_connections(tenant_id, id);
CREATE UNIQUE INDEX booking_external_blocks_connection_event ON public.booking_external_blocks (tenant_id, connection_id, external_id)
  WHERE connection_id IS NOT NULL;

-- G-10: one push of one booking to one connection's calendar.
CREATE TABLE public.calendar_pushes (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  connection_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  -- G-10: the booking ID's 32 hex digits, valid as a client-chosen Google event ID (a-v, 0-9).
  google_event_id text GENERATED ALWAYS AS (replace(booking_id::text, '-', '')) STORED,
  status public.calendar_push_status NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0 CONSTRAINT calendar_pushes_attempts CHECK (attempts BETWEEN 0 AND 1000),
  next_attempt_at timestamptz NOT NULL,
  lease_until timestamptz,
  pushed_at timestamptz,
  last_error text CONSTRAINT calendar_pushes_error_length CHECK (char_length(last_error) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, connection_id, booking_id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES public.calendar_connections(tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings(tenant_id, id),
  CONSTRAINT calendar_pushes_pushed_state CHECK ((status = 'pushed') = (pushed_at IS NOT NULL))
);
CREATE INDEX calendar_pushes_due ON public.calendar_pushes (next_attempt_at) WHERE status = 'pending';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['calendar_connections','calendar_pushes'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO authenticated
      USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$p$, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, authenticated, service_role', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
  END LOOP;
END $$;
-- G-4: the runtime role reads its tenant's rows (the sealed token opens only with the worker's
-- key), inserts through the connect action and may only move a connection to disconnecting.
GRANT SELECT ON public.calendar_connections TO authenticated;
GRANT INSERT (tenant_id, id, resource_id, calendar_id, account_email, status, refresh_token_sealed, scope,
  created_by, next_sync_at, created_at, updated_at) ON public.calendar_connections TO authenticated;
GRANT UPDATE (status, updated_at) ON public.calendar_connections TO authenticated;
GRANT SELECT ON public.calendar_pushes TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.calendar_connections TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.calendar_pushes TO service_role;

-- G-4: the runtime role's one status change is to disconnecting, and a connection it creates
-- starts active; every other change is the worker's (service role).
CREATE FUNCTION public.calendar_connections_runtime_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user = 'authenticated' AND (
      (TG_OP = 'INSERT' AND NEW.status <> 'active')
      OR (TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
        AND NOT (NEW.status = 'disconnecting' AND OLD.status IN ('active', 'reauthorize')))) THEN
    RAISE EXCEPTION 'Calendar connection status % is not a runtime change', NEW.status
      USING ERRCODE = 'insufficient_privilege', SCHEMA = 'public', TABLE = 'calendar_connections';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_connections_runtime_guard
  BEFORE INSERT OR UPDATE ON public.calendar_connections
  FOR EACH ROW EXECUTE FUNCTION public.calendar_connections_runtime_guard();
REVOKE ALL ON FUNCTION public.calendar_connections_runtime_guard() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.calendar_connections_runtime_guard() FROM anon;
  END IF;
END $$;
-- Same owner as every invoker function (20261018090000); CREATE only for the transfer.
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.calendar_connections_runtime_guard() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;

-- G-8: the push inbox. A platform table, not a tenant table: the runtime role may only insert,
-- the service role reads and marks it processed.
CREATE TABLE public.calendar_push_notifications (
  channel_id uuid NOT NULL,
  message_number bigint NOT NULL CONSTRAINT calendar_push_notifications_number CHECK (message_number >= 0),
  resource_state text NOT NULL CONSTRAINT calendar_push_notifications_state_length CHECK (char_length(resource_state) BETWEEN 1 AND 40),
  received_at timestamptz NOT NULL,
  processed_at timestamptz,
  PRIMARY KEY (channel_id, message_number)
);
CREATE INDEX calendar_push_notifications_due ON public.calendar_push_notifications (received_at) WHERE processed_at IS NULL;
ALTER TABLE public.calendar_push_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_push_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY calendar_push_notifications_intake ON public.calendar_push_notifications FOR INSERT TO authenticated
  WITH CHECK (processed_at IS NULL);
REVOKE ALL ON public.calendar_push_notifications FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON public.calendar_push_notifications FROM anon; END IF;
END $$;
GRANT INSERT (channel_id, message_number, resource_state, received_at) ON public.calendar_push_notifications TO authenticated;
GRANT SELECT, UPDATE (processed_at), DELETE ON public.calendar_push_notifications TO service_role;
