-- Free-tier marker and the daily site publish limit (docs/requirements/plans.md PL-25). Additive.
-- `free_tier` marks a tenant whose publishes are limited to the free number (20 in 24 hours) when no
-- grant and no provider plan applies; a tenant without the mark and without a plan stays comped.
-- Only the service role writes it (as the grant columns, PL-23): the runtime role keeps its table-level
-- SELECT of its own tenant's row and no write privilege on tenant_plans.
ALTER TABLE public.tenant_plans ADD COLUMN free_tier boolean NOT NULL DEFAULT false;
REVOKE INSERT (free_tier) ON public.tenant_plans FROM PUBLIC, authenticated;
REVOKE UPDATE (free_tier) ON public.tenant_plans FROM PUBLIC, authenticated;

-- The publish limit counts a tenant's releases over the last 24 hours, across its sites.
CREATE INDEX site_releases_tenant_created ON public.site_releases (tenant_id, created_at DESC);
