-- The owner's action log (backlog B05) lists one tenant's actions newest first and pages by
-- (created_at, id). This index serves that order without sorting the tenant's whole history.
CREATE INDEX IF NOT EXISTS actions_tenant_created ON public.actions (tenant_id, created_at DESC, id DESC);
