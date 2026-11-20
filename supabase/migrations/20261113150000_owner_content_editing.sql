-- Owner content editing (business-profile.md BP-13..BP-15, public-intake.md P-24): the owner writes what
-- the business says about itself. Two tenant tables change and no new table is added, so tenant_id, the
-- forced RLS and the tenant_scope policies of 20261023100000 and 20261018200000 stay as they are.
-- Writes come only from the business.profile.update and booking.page.update actions, through the dispatcher.

-- BP-13: a short description of the business. Null means not set; a set value is 1..2000 characters
-- and not blank (the contract trims it, so a stored value never has edge spaces).
ALTER TABLE public.business_profiles
  ADD COLUMN description text
    CONSTRAINT business_profiles_description CHECK (char_length(description) BETWEEN 1 AND 2000 AND btrim(description) <> '');

-- BP-14: the services the business offers, a JSON array of at most 20 names. Each name is a string of 1..80
-- characters with no space at either end (the regex runs per element: `.` matches any character, flag s).
-- A CASE keeps jsonb_array_length from running on a value that is not an array. Empty is `[]`, never null.
ALTER TABLE public.business_profiles
  ADD COLUMN services jsonb NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT business_profiles_services CHECK (
      CASE WHEN jsonb_typeof(services) = 'array' THEN
        jsonb_array_length(services) <= 20
        AND jsonb_array_length(jsonb_path_query_array(services, '$[*] ? (@ like_regex "^[^\\s](.{0,78}[^\\s])?$" flag "s")'))
          = jsonb_array_length(services)
      ELSE false END);

-- The runtime role may change these two columns under the table's tenant_scope policy, as it does the
-- other editable columns (the column grants add up).
GRANT UPDATE (description, services) ON public.business_profiles TO authenticated;

-- P-24: an owner edits a page's title and description after it is created. Nothing else on the page is
-- editable here: the disclosure text and version keep their append-only history, `published` has its own
-- grant (20261107100000), and the key, tenant and resources never change.
GRANT UPDATE (title, description) ON public.booking_pages TO authenticated;
