-- Operator-granted plan (docs/requirements/plans.md PL-21..PL-24). Additive: five nullable columns on
-- tenant_plans. While a grant is active its plan's limits win over the provider subscription and the
-- tenant is never read-only (read in code with the injected clock; nothing here expires a grant).
-- Only the service role writes them (the owner-run db:hosted-plan-grant script). The runtime role
-- keeps its table-level SELECT of its own tenant's row and no write privilege on tenant_plans.
ALTER TABLE public.tenant_plans
  ADD COLUMN granted_plan public.hub_plan,
  ADD COLUMN granted_until timestamptz,
  ADD COLUMN grant_note text CONSTRAINT tenant_plans_grant_note CHECK (char_length(grant_note) BETWEEN 1 AND 200 AND grant_note = btrim(grant_note)),
  ADD COLUMN granted_at timestamptz,
  ADD COLUMN granted_by text CONSTRAINT tenant_plans_granted_by CHECK (char_length(granted_by) BETWEEN 1 AND 80 AND granted_by = btrim(granted_by)),
  -- PL-21: the four required fields are all set or all null; an end date needs a grant.
  ADD CONSTRAINT tenant_plans_grant_all_or_none CHECK (
    (granted_plan IS NULL) = (grant_note IS NULL)
    AND (granted_plan IS NULL) = (granted_at IS NULL)
    AND (granted_plan IS NULL) = (granted_by IS NULL)
    AND (granted_until IS NULL OR granted_plan IS NOT NULL));

-- PL-23: belt and braces. authenticated holds SELECT only on tenant_plans; these revokes keep the
-- grant columns closed even if a later migration widens the table-level privilege to UPDATE.
REVOKE INSERT (granted_plan, granted_until, grant_note, granted_at, granted_by) ON public.tenant_plans FROM PUBLIC, authenticated;
REVOKE UPDATE (granted_plan, granted_until, grant_note, granted_at, granted_by) ON public.tenant_plans FROM PUBLIC, authenticated;
