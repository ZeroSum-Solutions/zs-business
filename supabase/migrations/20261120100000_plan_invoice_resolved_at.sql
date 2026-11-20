-- PL-10: a delayed `invoice.payment_failed` created before a recovery must not reopen an invoice or start a new
-- grace from the old failure time, however many times the subscription failed and recovered before.
--
-- Two watermarks in the clock Stripe's `created` is read against (Stripe's own clock: the worker takes it from the
-- `Date` header of the answer that shows the recovery). Each only moves forward (the worker writes greatest(old, new)):
--   plan_subscriptions.recovered_at  the last time the subscription went from past_due/unpaid back to active/trialing.
--                                    A failure created at or before it is stale, even for an invoice with no row yet.
--   plan_invoices.resolved_at        the same moment for each invoice that recovery settled; it stays when a later
--                                    failure reopens the invoice.
--
-- Rows from before these columns: the worker that wrote them dated nothing, and its `updated_at` is the start of its
-- pass, which can be earlier than the moment it saw the recovery. So the backfill is the migration time, which no event
-- Stripe created before it can pass. Every subscription that has a resolved or failed invoice gets it, and every
-- resolved invoice. A genuine failure that is still queued across the migration is dropped as stale; Stripe sends a new
-- `invoice.payment_failed` with the next retry.
--
-- Rollout: stop the billing worker (the old one resolves invoices without resolved_at, and reopens them without the
-- guard), apply this migration, deploy the new worker. Webhook intake keeps queuing meanwhile. The CHECK at the end
-- makes the old worker fail loudly if it still runs: its resolving UPDATE is refused and its event is retried.

ALTER TABLE public.plan_invoices ADD COLUMN resolved_at timestamptz;
ALTER TABLE public.plan_subscriptions ADD COLUMN recovered_at timestamptz;

-- Under FORCE ROW LEVEL SECURITY a migrator that is not a superuser sees no rows and would backfill nothing; the
-- table owner lifts FORCE for the copy only (ALTER TABLE holds an ACCESS EXCLUSIVE lock until commit, so no other
-- session sees the tables without it).
ALTER TABLE public.plan_invoices NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.plan_subscriptions NO FORCE ROW LEVEL SECURITY;
UPDATE public.plan_invoices SET resolved_at = greatest(updated_at, now()) WHERE status = 'resolved';
UPDATE public.plan_subscriptions s SET recovered_at = now()
  WHERE EXISTS (SELECT 1 FROM public.plan_invoices i
                 WHERE i.tenant_id = s.tenant_id AND i.provider = s.provider AND i.stripe_subscription_id = s.id
                   AND i.status IN ('resolved', 'failed'));
ALTER TABLE public.plan_invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE public.plan_subscriptions FORCE ROW LEVEL SECURITY;

ALTER TABLE public.plan_invoices ADD CONSTRAINT plan_invoices_resolved_dated CHECK (status <> 'resolved' OR resolved_at IS NOT NULL);
