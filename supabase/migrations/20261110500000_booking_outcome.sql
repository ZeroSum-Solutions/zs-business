-- Booking outcomes (docs/requirements/booking.md revision 4, B-37..B-46). An owner or staff member marks a
-- booking that has started as `completed` or `no_show`; a review request waits for `completed` (B-43).
-- Additive: three nullable columns and two checks. No data changes: every existing booking has no mark, which the
-- reads call `unknown`, so none of them gets a review request (B-44). A review request already queued but not yet sent is
-- also stopped at delivery (D-6, B-43, B-44).
--
-- Deploy order (B-47): (1) the dashboard that parses `outcome` as optional, (2) this migration and the API. The deployed
-- dashboard parses a booking strictly and rejects an `outcome` key it does not know. The API therefore sends the key
-- only on a marked booking, so the deployed dashboard keeps working until the first mark; the new dashboard must be live
-- before anyone can mark one (the control is in it) and open tabs need a reload after that.

ALTER TABLE public.bookings
  ADD COLUMN outcome text,
  ADD COLUMN outcome_set_at timestamptz,
  ADD COLUMN outcome_set_by uuid;

-- B-37: the stored values are the two marks; `unknown` is the absence of one.
-- B-40: the three columns are set together (the actor stamp included), and a cancelled booking has none (B-39, B-41).
-- Every existing row has all three null, so the checks cannot fail; they are added NOT VALID and then validated, so the
-- scan runs under a weaker lock than the ADD CONSTRAINT itself would hold.
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_outcome CHECK (outcome IS NULL OR outcome IN ('completed', 'no_show')) NOT VALID,
  ADD CONSTRAINT bookings_outcome_fields CHECK (
    (outcome IS NULL) = (outcome_set_at IS NULL)
    AND (outcome IS NULL) = (outcome_set_by IS NULL)
    AND (outcome IS NULL OR status = 'confirmed')) NOT VALID;
ALTER TABLE public.bookings VALIDATE CONSTRAINT bookings_outcome;
ALTER TABLE public.bookings VALIDATE CONSTRAINT bookings_outcome_fields;

-- B-40: the runtime role may write these three columns (and, from 20261110200000, the four cancel columns), through
-- the action. A cancelled row stays frozen for the runtime role by booking_cancel_guard (B-30); nothing else changes.
GRANT UPDATE (outcome, outcome_set_at, outcome_set_by) ON public.bookings TO authenticated;
