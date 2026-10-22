-- activepieces.md W-7, W-14: an owner's replay sends a delivery queued before the endpoint was
-- switched off and on only for the activation it was made under. The worker compares the replay
-- time with the endpoint's activated_at, so a later disable and enable drops the replay too,
-- until the owner replays it again. Deliveries replayed before this column existed have no time
-- and are judged by when their event happened, as an unreplayed delivery is.

ALTER TABLE public.webhook_deliveries ADD COLUMN replayed_at timestamptz;
ALTER TABLE public.webhook_deliveries ADD CONSTRAINT webhook_deliveries_replayed_at
  CHECK (replayed_at IS NULL OR replays > 0);

GRANT UPDATE (replayed_at) ON public.webhook_deliveries TO authenticated;
