-- PL-10: a delayed `invoice.payment_failed` for an invoice that was already resolved must not reopen it
-- with the old failure time. `resolved_at` is the worker's clock when it saw the recovery; a failure
-- event Stripe created at or before it is stale. It stays set when a later failure reopens the invoice, so
-- a delayed copy of the first failure is still refused then.
--
-- Rollout: no constraint ties `resolved_at` to the status, so the billing worker from before this change
-- can still resolve invoices without it (such a row is dated by `updated_at`, which that worker sets to
-- the same moment). Apply this migration, then deploy the new worker.

ALTER TABLE public.plan_invoices ADD COLUMN resolved_at timestamptz;

-- Rows resolved before this column existed: the worker stamped `updated_at` when it resolved them. Under
-- FORCE ROW LEVEL SECURITY a migrator that is not a superuser sees no rows and would backfill nothing; the
-- table owner lifts FORCE for the copy only (ALTER TABLE holds an ACCESS EXCLUSIVE lock until commit, so
-- no other session sees the table without it).
ALTER TABLE public.plan_invoices NO FORCE ROW LEVEL SECURITY;
UPDATE public.plan_invoices SET resolved_at = updated_at WHERE status = 'resolved' AND resolved_at IS NULL;
ALTER TABLE public.plan_invoices FORCE ROW LEVEL SECURITY;
