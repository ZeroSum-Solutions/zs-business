-- Release numbers. Each release of a site gets a stable number: 1 for its first publish, then
-- one more per publish. The publish handler assigns max + 1 while it holds the site lock; the
-- unique key makes a repeat fail rather than be recorded. Numbers are never reused or
-- renumbered, so "release 3" means the same release for the life of the site.

ALTER TABLE public.site_releases ADD COLUMN number integer;

-- One-time backfill of releases recorded before this migration, in the order they were made.
-- Under FORCE ROW LEVEL SECURITY a migrator that is not a superuser (postgres on hosted
-- Supabase) sees no rows, and the UPDATE would pass vacuously (as in 20261018090000). The
-- append-only trigger refuses every UPDATE, so it is off for this statement only. Both ALTERs
-- hold an ACCESS EXCLUSIVE lock until commit, so no other session sees the table without them.
ALTER TABLE public.site_releases NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.site_releases DISABLE TRIGGER site_releases_append_only;
UPDATE public.site_releases r SET number = n.number
  FROM (SELECT tenant_id, id, row_number() OVER (PARTITION BY tenant_id, site_id ORDER BY created_at, id) AS number
          FROM public.site_releases) n
 WHERE r.tenant_id = n.tenant_id AND r.id = n.id;
ALTER TABLE public.site_releases ENABLE TRIGGER site_releases_append_only;
ALTER TABLE public.site_releases FORCE ROW LEVEL SECURITY;

-- No default: the handler always supplies the number (the catalog isolation fixture fills 1).
ALTER TABLE public.site_releases ALTER COLUMN number SET NOT NULL;
ALTER TABLE public.site_releases ADD CONSTRAINT site_releases_number_positive CHECK (number >= 1);
-- Also the index behind max(number) and the newest-first list.
ALTER TABLE public.site_releases ADD CONSTRAINT site_releases_site_number UNIQUE (tenant_id, site_id, number);
