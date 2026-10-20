-- M5 Activepieces (docs/requirements/activepieces.md W-1..W-16): per-tenant outbound webhooks for
-- business events, delivered by a worker with leases, retries and dead letters, and automation
-- tokens whose holders may only propose actions through M3b's approval records. No secret is
-- stored: signing secrets and tokens derive from a server key (W-5, W-9). Every table has
-- tenant_id, a tenant FK and forced RLS.

-- W-3: the events an endpoint may subscribe to; W-10: what a token may propose.
CREATE TYPE public.automation_event_type AS ENUM ('lead.created', 'booking.created', 'deal.won', 'message.received');
CREATE TYPE public.automation_token_scope AS ENUM ('contacts:propose', 'deals:propose', 'bookings:propose');

-- W-2: one receiver URL per row. The contracts schema and the server's URL policy validate the
-- URL; SQL bounds it. `scan_from` is where the worker's next ingest starts (W-7).
CREATE TABLE public.webhook_endpoints (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  url text NOT NULL CONSTRAINT webhook_endpoints_url_length CHECK (char_length(url) BETWEEN 1 AND 2048),
  description text CONSTRAINT webhook_endpoints_description_length CHECK (char_length(description) BETWEEN 1 AND 200),
  events public.automation_event_type[] NOT NULL DEFAULT '{}'
    CONSTRAINT webhook_endpoints_events_size CHECK (cardinality(events) <= 4),
  enabled boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1 CONSTRAINT webhook_endpoints_revision CHECK (revision BETWEEN 1 AND 9007199254740991),
  -- W-5: the secret is HMAC(server key, tenant, endpoint, version); a rotation bumps the version.
  secret_version integer NOT NULL DEFAULT 1 CONSTRAINT webhook_endpoints_secret_version CHECK (secret_version BETWEEN 1 AND 1000000),
  previous_secret_version integer,
  previous_valid_until timestamptz,
  scan_from timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT webhook_endpoints_previous_secret CHECK (
    (previous_secret_version IS NULL) = (previous_valid_until IS NULL)
    AND (previous_secret_version IS NULL OR previous_secret_version < secret_version))
);
CREATE INDEX webhook_endpoints_enabled ON public.webhook_endpoints (tenant_id) WHERE enabled;

-- W-7: every outbox row one endpoint's ingest has read, so each is mapped once per endpoint.
CREATE TABLE public.webhook_ingest_marks (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  endpoint_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  ingested_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, endpoint_id, outbox_id),
  FOREIGN KEY (tenant_id, endpoint_id) REFERENCES public.webhook_endpoints(tenant_id, id),
  FOREIGN KEY (tenant_id, outbox_id) REFERENCES public.outbox(tenant_id, id)
);

-- W-7, W-8: one business event for one endpoint, with its lease and outcome state. The body is
-- fixed at ingest, so every attempt and replay sends the same bytes under the same event ID.
CREATE TABLE public.webhook_deliveries (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  endpoint_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  event_type public.automation_event_type NOT NULL,
  event_id uuid NOT NULL,
  -- json, not jsonb, keeps the stored text as written.
  body json NOT NULL CONSTRAINT webhook_deliveries_body_size CHECK (octet_length(body::text) <= 65536),
  status text NOT NULL DEFAULT 'pending'
    CONSTRAINT webhook_deliveries_status CHECK (status IN ('pending', 'leased', 'delivered', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CONSTRAINT webhook_deliveries_attempts CHECK (attempts BETWEEN 0 AND 1000),
  step_errors integer NOT NULL DEFAULT 0 CONSTRAINT webhook_deliveries_step_errors CHECK (step_errors BETWEEN 0 AND 1000),
  replays integer NOT NULL DEFAULT 0 CONSTRAINT webhook_deliveries_replays CHECK (replays BETWEEN 0 AND 1000),
  next_attempt_at timestamptz NOT NULL,
  lease_token uuid,
  lease_owner text CONSTRAINT webhook_deliveries_lease_owner_length CHECK (char_length(lease_owner) BETWEEN 1 AND 200),
  lease_expires_at timestamptz,
  last_status_code integer CONSTRAINT webhook_deliveries_status_code CHECK (last_status_code BETWEEN 100 AND 599),
  last_error text CONSTRAINT webhook_deliveries_last_error_length CHECK (char_length(last_error) BETWEEN 1 AND 200),
  final_reason text CONSTRAINT webhook_deliveries_final_reason CHECK (final_reason IN
    ('max_attempts', 'endpoint_gone', 'endpoint_disabled', 'url_refused', 'worker_error')),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT webhook_deliveries_one_per_event UNIQUE (tenant_id, endpoint_id, outbox_id, event_type),
  FOREIGN KEY (tenant_id, endpoint_id) REFERENCES public.webhook_endpoints(tenant_id, id),
  FOREIGN KEY (tenant_id, outbox_id) REFERENCES public.outbox(tenant_id, id),
  CONSTRAINT webhook_deliveries_lease_state CHECK (
    (status = 'leased') = (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CONSTRAINT webhook_deliveries_delivered_state CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CONSTRAINT webhook_deliveries_final_state CHECK ((status = 'dead') = (final_reason IS NOT NULL))
);
-- The worker claims across tenants as the service role.
CREATE INDEX webhook_deliveries_due ON public.webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_lease_expiry ON public.webhook_deliveries (lease_expires_at) WHERE status = 'leased';
CREATE INDEX webhook_deliveries_endpoint ON public.webhook_deliveries (tenant_id, endpoint_id, created_at DESC, id);

-- W-8: one row per HTTP attempt; an attempt with no outcome was cut off mid-send.
CREATE TABLE public.webhook_delivery_attempts (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  delivery_id uuid NOT NULL,
  attempt integer NOT NULL CONSTRAINT webhook_delivery_attempts_number CHECK (attempt BETWEEN 1 AND 100000),
  started_at timestamptz NOT NULL,
  outcome text CONSTRAINT webhook_delivery_attempts_outcome CHECK (outcome IN ('delivered', 'failed', 'lost')),
  status_code integer CONSTRAINT webhook_delivery_attempts_status_code CHECK (status_code BETWEEN 100 AND 599),
  error_code text CONSTRAINT webhook_delivery_attempts_error_length CHECK (char_length(error_code) BETWEEN 1 AND 200),
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, delivery_id, attempt),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES public.webhook_deliveries(tenant_id, id),
  CONSTRAINT webhook_delivery_attempts_finished CHECK ((outcome IS NULL) = (finished_at IS NULL))
);

-- W-9, W-10: an inbound credential. The token text derives from the server key and the ID, so
-- nothing secret is stored; revocation and expiry live here.
CREATE TABLE public.automation_tokens (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  name text NOT NULL CONSTRAINT automation_tokens_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
  scopes public.automation_token_scope[] NOT NULL DEFAULT '{}'
    CONSTRAINT automation_tokens_scopes_size CHECK (cardinality(scopes) <= 3),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT automation_tokens_expiry CHECK (expires_at IS NULL OR expires_at > created_at),
  CONSTRAINT automation_tokens_revocation CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

-- W-7: the ingest reads one tenant's events of a few types after a point in time.
CREATE INDEX outbox_tenant_type_created ON public.outbox (tenant_id, event_type, created_at, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['webhook_endpoints','webhook_ingest_marks','webhook_deliveries',
    'webhook_delivery_attempts','automation_tokens'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO authenticated
      USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$p$, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, authenticated, service_role', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, service_role', t);
  END LOOP;
END $$;

-- Owners write endpoints and tokens through the dispatcher (runtime role). The binding columns
-- of a token (its tenant, ID, scopes and creator) never change; a token is only ever revoked.
GRANT INSERT ON public.webhook_endpoints, public.automation_tokens TO authenticated;
GRANT UPDATE (url, description, events, enabled, revision, secret_version, previous_secret_version,
  previous_valid_until, scan_from, updated_at) ON public.webhook_endpoints TO authenticated;
GRANT UPDATE (revoked_at, revoked_by) ON public.automation_tokens TO authenticated;
-- W-14: an owner replays a dead letter; nothing else about a delivery is the runtime's to change.
GRANT UPDATE (status, attempts, step_errors, replays, next_attempt_at, final_reason, last_error, updated_at)
  ON public.webhook_deliveries TO authenticated;
-- The worker (service role) moves deliveries forward and its own ingest point; nothing deletes history.
-- Like every tenant table, the service role (provisioning, operators) may add rows.
GRANT INSERT ON public.webhook_endpoints, public.automation_tokens TO service_role;
GRANT UPDATE (scan_from) ON public.webhook_endpoints TO service_role;
GRANT INSERT ON public.webhook_ingest_marks TO service_role;
GRANT INSERT, UPDATE ON public.webhook_deliveries, public.webhook_delivery_attempts TO service_role;
-- The enums are read by both roles.
GRANT USAGE ON TYPE public.automation_event_type, public.automation_token_scope TO authenticated, service_role;
