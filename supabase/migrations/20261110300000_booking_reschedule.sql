-- Booking self-service (docs/requirements/booking-self-service.md revision 1, BS-11). A customer who
-- moves their booking through their own link gets a new booking; this column ties it to the one it
-- replaced. Additive: one nullable column, one foreign key, one check and one partial index. No grants
-- change: the runtime role already inserts bookings (booking.md B-20) and cancels through four columns (B-35).

ALTER TABLE public.bookings ADD COLUMN rescheduled_from uuid;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_rescheduled_from_fk FOREIGN KEY (tenant_id, rescheduled_from)
    REFERENCES public.bookings (tenant_id, id),
  ADD CONSTRAINT bookings_rescheduled_from_other CHECK (rescheduled_from IS NULL OR rescheduled_from <> id);
-- Foreign keys carry a full index (20261108600000_fk_full_indexes); the view of a moved booking reads by it.
CREATE INDEX bookings_tenant_rescheduled_from ON public.bookings (tenant_id, rescheduled_from)
  WHERE rescheduled_from IS NOT NULL;
