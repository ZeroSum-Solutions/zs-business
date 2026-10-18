-- M1: a tenant may own several bookable resources (for example a showroom calendar and a
-- repair-intake calendar). Locking (B-21) and the exclusion constraint (B-20) are already
-- per resource, so dropping the one-per-tenant rule changes no booking guarantee.
ALTER TABLE public.booking_resources DROP CONSTRAINT booking_resources_one_per_tenant;
-- Optional display label; B-28 fixtures may omit it.
ALTER TABLE public.booking_resources ADD COLUMN name text
  CONSTRAINT booking_resources_name_length CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 200);
