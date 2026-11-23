-- delivery.md D-6 revision 6, approvals.md A-16 (ZSB-41): a send binds the address the approver
-- saw. The send event carries it (`destination`), ingest copies it here, and the worker sends only
-- while the contact's current address is still this one; any other address blocks the delivery
-- `destination_changed` with no provider call.
--
-- Rows from before this column keep NULL: their events carried no destination, so they keep the
-- old rule (the contact's current address). No backfill: nothing recorded what their approver saw.
ALTER TABLE public.message_deliveries ADD COLUMN bound_address text
  CONSTRAINT message_deliveries_bound_address_length CHECK (char_length(bound_address) BETWEEN 1 AND 254);
