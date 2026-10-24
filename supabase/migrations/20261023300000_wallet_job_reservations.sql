-- delivery.md D-11 (revision 5): a wallet reservation names a job by kind and id, not only a
-- message delivery. Enrichment calls, image jobs, voice minutes and browser runs hold funds the
-- same way a send does (D-4, D-5). wallet_reservations is already a tenant table with forced RLS,
-- the tenant_scope policy and its grants (20261020300000); new columns inherit the table grants.

ALTER TABLE public.wallet_reservations
  ADD COLUMN job_kind text,
  ADD COLUMN job_id uuid;

-- Existing reservations are all message deliveries. Under FORCE ROW LEVEL SECURITY a migrator that
-- is not a superuser (postgres on hosted Supabase) sees no rows and would backfill nothing, and
-- SET NOT NULL would then fail the batch; the table owner lifts FORCE for the copy only (ALTER
-- TABLE holds an ACCESS EXCLUSIVE lock until commit, so no other session sees the table without it).
ALTER TABLE public.wallet_reservations NO FORCE ROW LEVEL SECURITY;
UPDATE public.wallet_reservations SET job_kind = 'message_delivery', job_id = delivery_id;
ALTER TABLE public.wallet_reservations FORCE ROW LEVEL SECURITY;

ALTER TABLE public.wallet_reservations
  ALTER COLUMN job_kind SET NOT NULL,
  ALTER COLUMN job_id SET NOT NULL,
  -- The kinds of D-11. A new kind needs a revision of delivery.md and a contract that names its
  -- job table and price (WALLET_JOB_KINDS in packages/contracts/src/delivery.ts, kept in step by a test).
  ADD CONSTRAINT wallet_reservations_job_kind CHECK (
    job_kind IN ('message_delivery', 'enrichment', 'image_job', 'voice_minutes', 'browser_run')),
  -- delivery_id stays for message deliveries, with its foreign key to message_deliveries; other
  -- kinds have no foreign key (reserveForJob locks the job's own row instead).
  ALTER COLUMN delivery_id DROP NOT NULL,
  ADD CONSTRAINT wallet_reservations_job_delivery CHECK (
    (job_kind = 'message_delivery') = (delivery_id IS NOT NULL) AND (delivery_id IS NULL OR delivery_id = job_id));

-- One hold and one capture per job, whatever its kind. Same names as before, so errors read the same.
DROP INDEX public.wallet_reservations_one_held;
DROP INDEX public.wallet_reservations_one_capture;
CREATE UNIQUE INDEX wallet_reservations_one_held ON public.wallet_reservations (tenant_id, job_kind, job_id)
  WHERE status = 'held';
CREATE UNIQUE INDEX wallet_reservations_one_capture ON public.wallet_reservations (tenant_id, job_kind, job_id)
  WHERE status = 'captured';

-- The stale-hold sweep reads held reservations by age across tenants as the service role.
CREATE INDEX wallet_reservations_held_age ON public.wallet_reservations (created_at)
  WHERE status = 'held';
