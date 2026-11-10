-- Booking cancellation (docs/requirements/booking.md revision 3, B-29..B-35). A booking can now be
-- `confirmed` or `cancelled`. A cancelled booking keeps its row, its ID and its customer link, but
-- takes no part in the overlap constraint, so its slot is free for the next booking.
-- Additive for readers: three nullable columns and a wider status check. No data changes.

ALTER TABLE public.bookings
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by uuid,
  ADD COLUMN cancel_reason text;

ALTER TABLE public.bookings DROP CONSTRAINT bookings_status_confirmed;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_status CHECK (status IN ('confirmed', 'cancelled')),
  ADD CONSTRAINT bookings_cancelled_fields CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
    AND (cancelled_by IS NULL OR status = 'cancelled')
    AND (cancel_reason IS NULL OR (status = 'cancelled' AND char_length(cancel_reason) BETWEEN 1 AND 500)));

-- B-20: the constraint arbitrates confirmed rows only (booking.md B-20 said cancellation "requires WHERE status='confirmed'").
ALTER TABLE public.bookings DROP CONSTRAINT bookings_resource_occupied_excl;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_resource_occupied_excl EXCLUDE USING gist (
  tenant_id WITH =,
  resource_id WITH =,
  tstzrange(occupied_starts_at, occupied_ends_at, '[)') WITH &&
) WHERE (status = 'confirmed');

-- B-35: the runtime role may cancel (and nothing else): these four columns, through the action.
GRANT UPDATE (status, cancelled_at, cancelled_by, cancel_reason) ON public.bookings TO authenticated;

-- B-30: a cancellation is final. The runtime role cannot reopen a cancelled booking or change what a
-- cancelled booking says. Invoker function: current_user is the role running the statement.
CREATE FUNCTION public.booking_cancel_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'A cancelled booking cannot change'
      USING ERRCODE = 'insufficient_privilege', SCHEMA = 'public', TABLE = 'bookings', COLUMN = 'status';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER booking_cancel_guard BEFORE UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.booking_cancel_guard();
REVOKE ALL ON FUNCTION public.booking_cancel_guard() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.booking_cancel_guard() FROM anon;
  END IF;
END $$;
-- Same owner as every invoker function (20261018090000); CREATE only for the transfer.
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.booking_cancel_guard() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;
