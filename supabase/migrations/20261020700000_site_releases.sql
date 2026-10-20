-- M4b site releases. A site has immutable releases (the compiled files of one publish) and a
-- pointer naming the live one. Publishing records a release and moves the pointer; rollback
-- moves it back. Every relationship includes tenant_id; every table forces RLS. Runtime
-- writes go through the dispatcher. File bytes live in object storage, addressed by SHA-256.

CREATE TABLE public.sites (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  name text NOT NULL CONSTRAINT sites_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE public.site_releases (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  site_id uuid NOT NULL,
  -- The compiler input this release was built from, so an editor can start from any release.
  spec jsonb NOT NULL CONSTRAINT site_releases_spec_object CHECK (jsonb_typeof(spec) = 'object'),
  entry text NOT NULL CONSTRAINT site_releases_entry_length CHECK (char_length(entry) BETWEEN 1 AND 200),
  -- Defaults on digest and sha256 serve the catalog isolation fixture only; the handler always
  -- supplies the real value.
  digest text NOT NULL DEFAULT repeat('0', 64) CONSTRAINT site_releases_digest_hex CHECK (digest ~ '^[0-9a-f]{64}$'),
  file_count integer NOT NULL CONSTRAINT site_releases_file_count CHECK (file_count BETWEEN 1 AND 500),
  total_bytes bigint NOT NULL CONSTRAINT site_releases_total_bytes CHECK (total_bytes BETWEEN 0 AND 52428800),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  -- The pointer and activation log name (site, release) pairs, so a site never points at another site's release.
  CONSTRAINT site_releases_site_release UNIQUE (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES public.sites(tenant_id, id)
);
CREATE INDEX site_releases_tenant_site_created ON public.site_releases (tenant_id, site_id, created_at DESC, id DESC);

CREATE TABLE public.site_release_files (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  release_id uuid NOT NULL,
  path text NOT NULL CONSTRAINT site_release_files_path CHECK (
    char_length(path) BETWEEN 1 AND 200
    AND path ~ '^[A-Za-z0-9._~-]+(/[A-Za-z0-9._~-]+)*$'
    AND path !~ '(^|/)\.\.?(/|$)'),
  media_type text NOT NULL CONSTRAINT site_release_files_media_type_length CHECK (char_length(media_type) BETWEEN 3 AND 100),
  sha256 text NOT NULL DEFAULT repeat('0', 64) CONSTRAINT site_release_files_sha256_hex CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes integer NOT NULL CONSTRAINT site_release_files_bytes CHECK (bytes BETWEEN 0 AND 10485760),
  PRIMARY KEY (tenant_id, release_id, path),
  FOREIGN KEY (tenant_id, release_id) REFERENCES public.site_releases(tenant_id, id)
);

-- The live release. One row per site once it has published; activation is one UPDATE of it,
-- so readers see the old pointer or the new one and nothing in between.
CREATE TABLE public.site_pointers (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  site_id uuid NOT NULL,
  release_id uuid NOT NULL,
  -- Bumps on every activation. The edge projection only ever moves to a higher version.
  version bigint NOT NULL CONSTRAINT site_pointers_version_positive CHECK (version >= 1),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, site_id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES public.sites(tenant_id, id),
  FOREIGN KEY (tenant_id, site_id, release_id) REFERENCES public.site_releases(tenant_id, site_id, id)
);

-- Who made which release live, and when: the history behind rollback.
CREATE TABLE public.site_activations (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  site_id uuid NOT NULL,
  version bigint NOT NULL CONSTRAINT site_activations_version_positive CHECK (version >= 1),
  release_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  activated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, site_id, version),
  FOREIGN KEY (tenant_id, site_id, release_id) REFERENCES public.site_releases(tenant_id, site_id, id)
);

-- Host names a site answers on. A host belongs to one site in the whole system, so hosts are
-- attached by the service role after the Mac verifies the domain; runtime only reads them.
CREATE TABLE public.site_hosts (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  -- As on intake_items: the default only applies when an INSERT omits the column (the
  -- catalog isolation fixture does). Attaching a host always supplies it.
  host text NOT NULL DEFAULT ('unset-' || gen_random_uuid()::text || '.invalid')
    CONSTRAINT site_hosts_host_dns CHECK (
      char_length(host) <= 253
      AND host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'),
  site_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, host),
  CONSTRAINT site_hosts_host_unique UNIQUE (host),
  FOREIGN KEY (tenant_id, site_id) REFERENCES public.sites(tenant_id, id)
);
CREATE INDEX site_hosts_tenant_site ON public.site_hosts (tenant_id, site_id);

-- Releases, their files and the activation log are history: no role may rewrite or drop them.
CREATE FUNCTION public.site_history_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Site release history is append-only (% on % refused)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege', SCHEMA = 'public', TABLE = TG_TABLE_NAME;
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['site_releases','site_release_files','site_activations'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.site_history_append_only()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I
      FOR EACH STATEMENT EXECUTE FUNCTION public.site_history_append_only()', t || '_no_truncate', t);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.site_history_append_only() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.site_history_append_only() FROM anon;
  END IF;
END $$;
-- Same owner as every invoker function (20261018090000); CREATE only for the transfer.
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.site_history_append_only() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sites','site_releases','site_release_files','site_pointers','site_activations','site_hosts'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO authenticated
      USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$p$, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, authenticated, service_role', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
  END LOOP;
END $$;
REVOKE UPDATE, DELETE ON public.site_releases, public.site_release_files, public.site_activations FROM service_role;

-- Runtime: create sites and rename them, record releases, and move the pointer. Hosts are read-only.
GRANT SELECT, INSERT ON public.sites, public.site_releases, public.site_release_files, public.site_pointers, public.site_activations TO authenticated;
GRANT UPDATE (name, updated_at) ON public.sites TO authenticated;
GRANT UPDATE (release_id, version, updated_at) ON public.site_pointers TO authenticated;
GRANT SELECT ON public.site_hosts TO authenticated;
