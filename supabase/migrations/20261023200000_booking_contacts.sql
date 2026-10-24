-- Booking customer link (docs/requirements/booking-customer.md BC-1..BC-10): who an owner-made
-- booking is for. Tenant table: tenant_id, composite foreign keys, forced RLS with the shared
-- tenant_scope policy. Writes come only from booking.contact.link and booking.contact.unlink,
-- through the dispatcher. bookings itself does not change (booking.md B-17).

CREATE TABLE public.booking_contacts (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  booking_id uuid NOT NULL,
  -- BC-1: null while the booking has no customer. The row stays once created, so revision only grows.
  contact_id uuid,
  -- Who made the latest change (a link, a change or an unlink) and when. A member's user ID, as
  -- business_profiles.updated_by keeps it: not a foreign key, since members leave.
  linked_by uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  -- BC-3, BC-4: compare-and-set. 0 on the wire means "no row yet"; the first row is revision 1.
  revision integer NOT NULL DEFAULT 1 CONSTRAINT booking_contacts_revision CHECK (revision >= 1),
  -- BC-1: at most one contact per booking.
  PRIMARY KEY (tenant_id, booking_id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings(tenant_id, id),
  -- MATCH SIMPLE: a null contact_id is not checked, so a cleared link needs no contact.
  CONSTRAINT booking_contacts_contact_fk FOREIGN KEY (tenant_id, contact_id) REFERENCES public.crm_contacts(tenant_id, id)
);
-- The contact page lists its bookings, and the contact-delete trigger below finds its rows here.
CREATE INDEX booking_contacts_tenant_contact ON public.booking_contacts (tenant_id, contact_id)
  WHERE contact_id IS NOT NULL;

-- BC-1, BC-2, BC-4 at the database, whatever writes the row:
--  * the first row is revision 1 and every update adds exactly one, so a revision read earlier can
--    never match again (an unlink does not reset it);
--  * a website booking (it has an intake item) never gets a contact: its customer comes from the
--    intake review (public-intake.md P-12).
CREATE FUNCTION public.booking_contacts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 THEN
      RAISE EXCEPTION 'A booking contact starts at revision 1' USING ERRCODE = 'check_violation',
        SCHEMA = 'public', TABLE = 'booking_contacts', CONSTRAINT = 'booking_contacts_revision_step';
    END IF;
  ELSIF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'A booking contact revision grows by one: % to %', OLD.revision, NEW.revision
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'booking_contacts', CONSTRAINT = 'booking_contacts_revision_step';
  END IF;
  IF NEW.contact_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.booking_id AND b.source <> 'owner'
  ) THEN
    RAISE EXCEPTION 'A website booking takes its customer from the intake review' USING ERRCODE = 'check_violation',
      SCHEMA = 'public', TABLE = 'booking_contacts', CONSTRAINT = 'booking_contacts_owner_made';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER booking_contacts_guard
  BEFORE INSERT OR UPDATE ON public.booking_contacts
  FOR EACH ROW EXECUTE FUNCTION public.booking_contacts_guard();

-- BC-7: deleting a contact clears the link and keeps the booking, in the same transaction. The row
-- stays with a null contact_id and one more revision. No contact delete action exists yet; a later
-- erasure action inherits this trigger. It runs as whoever deletes (the runtime role holds the
-- UPDATE below), so it never reaches another tenant's rows.
CREATE FUNCTION public.booking_contacts_contact_deleted() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE public.booking_contacts
    SET contact_id = NULL, revision = revision + 1
    WHERE tenant_id = OLD.tenant_id AND contact_id = OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER booking_contacts_contact_deleted
  BEFORE DELETE ON public.crm_contacts
  FOR EACH ROW EXECUTE FUNCTION public.booking_contacts_contact_deleted();

ALTER TABLE public.booking_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.booking_contacts TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON public.booking_contacts FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.booking_contacts FROM anon;
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.booking_contacts TO service_role;
-- Runtime: read, create the row, and change the link columns. Never the keys, never a delete.
GRANT SELECT, INSERT ON public.booking_contacts TO authenticated;
GRANT UPDATE (contact_id, linked_by, linked_at, revision) ON public.booking_contacts TO authenticated;

-- Same owners as every function: invoker functions with zs_function_owner (20261018090000).
-- CREATE only for the transfer.
REVOKE ALL ON FUNCTION public.booking_contacts_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.booking_contacts_contact_deleted() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.booking_contacts_guard() FROM anon;
    REVOKE ALL ON FUNCTION public.booking_contacts_contact_deleted() FROM anon;
  END IF;
END $$;
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.booking_contacts_guard() OWNER TO zs_function_owner;
ALTER FUNCTION public.booking_contacts_contact_deleted() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;
