-- Company facts (business-profile.md revision 3, BP-16..BP-21): opening hours, a tone of voice note and a
-- short list of policies, each with a mark of who set it and when. One tenant table changes and no new
-- table is added, so tenant_id, the forced RLS and the tenant_scope policy of 20261023100000 stay as they
-- are. Writes come only from the business.profile.update action, through the dispatcher.

-- BP-16: opening hours. Null means not known. A set value names all seven days; a day is null (closed)
-- or { open, close } as "HH:MM" with open before close ("24:00" closes at midnight). At least one day is
-- open, so "closed every day" is never stored in place of "not known". A CHECK cannot hold a subquery,
-- so the test is a function.
CREATE FUNCTION public.business_hours_valid(p_hours jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_hours IS NULL OR coalesce(
    jsonb_typeof(p_hours) = 'object'
    AND (SELECT array_agg(k COLLATE "C" ORDER BY k COLLATE "C") FROM jsonb_object_keys(p_hours) k)
      = ARRAY['fri', 'mon', 'sat', 'sun', 'thu', 'tue', 'wed']::text[]
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(p_hours) e
       WHERE NOT (jsonb_typeof(e.value) = 'null' OR coalesce(
         jsonb_typeof(e.value) = 'object'
         AND (e.value - ARRAY['open', 'close']) = '{}'::jsonb
         AND jsonb_typeof(e.value->'open') = 'string' AND jsonb_typeof(e.value->'close') = 'string'
         AND (e.value->>'open') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         AND (e.value->>'close') ~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
         AND (e.value->>'open') COLLATE "C" < (e.value->>'close') COLLATE "C", false)))
    AND EXISTS (SELECT 1 FROM jsonb_each(p_hours) e WHERE jsonb_typeof(e.value) = 'object'),
    false)
$$;

-- BP-18, BP-19: a mark is { setBy, setAt, revision }: the owner's member ID, the instant (as the contract
-- writes it, UTC with milliseconds) and the profile revision the save made, a whole number from 2.
CREATE FUNCTION public.business_fact_mark_valid(p_mark jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    jsonb_typeof(p_mark) = 'object'
    AND (p_mark - ARRAY['setBy', 'setAt', 'revision']) = '{}'::jsonb
    AND jsonb_typeof(p_mark->'setBy') = 'string'
    AND (p_mark->>'setBy') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND jsonb_typeof(p_mark->'setAt') = 'string'
    AND (p_mark->>'setAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    AND jsonb_typeof(p_mark->'revision') = 'number' AND (p_mark->>'revision') ~ '^[0-9]{1,10}$'
    AND (p_mark->>'revision')::bigint BETWEEN 2 AND 2147483647,
    false)
$$;

-- BP-18: policies, a JSON array of at most 10 { title, text, setBy, setAt, revision }. A title is one line
-- of 1..60 characters and no two titles are the same ignoring case; a text is 1..1000 characters; neither
-- starts or ends with whitespace (the contract trims them), so neither is blank.
CREATE FUNCTION public.business_policies_valid(p_policies jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    jsonb_typeof(p_policies) = 'array'
    AND jsonb_array_length(p_policies) <= 10
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_policies) p
       WHERE NOT coalesce(
         jsonb_typeof(p.value) = 'object'
         AND (p.value - ARRAY['title', 'text', 'setBy', 'setAt', 'revision']) = '{}'::jsonb
         AND jsonb_typeof(p.value->'title') = 'string'
         AND char_length(p.value->>'title') BETWEEN 1 AND 60 AND (p.value->>'title') !~ '^[[:space:]]|[[:space:]]$'
         AND (p.value->>'title') !~ '[[:cntrl:]]'
         AND jsonb_typeof(p.value->'text') = 'string'
         AND char_length(p.value->>'text') BETWEEN 1 AND 1000 AND (p.value->>'text') !~ '^[[:space:]]|[[:space:]]$'
         AND public.business_fact_mark_valid(p.value - ARRAY['title', 'text']),
         false))
    AND (SELECT count(DISTINCT lower(p.value->>'title')) FROM jsonb_array_elements(p_policies) p) = jsonb_array_length(p_policies),
    false)
$$;

-- BP-19: the mark of each fact's last change, keyed by the field name the contract uses; `policies` marks
-- the last change to the list.
CREATE FUNCTION public.business_fact_marks_valid(p_marks jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    jsonb_typeof(p_marks) = 'object'
    AND (p_marks - ARRAY['displayName', 'description', 'services', 'timeZone', 'hours', 'tone', 'policies']) = '{}'::jsonb
    AND NOT EXISTS (SELECT 1 FROM jsonb_each(p_marks) e WHERE NOT public.business_fact_mark_valid(e.value)),
    false)
$$;

ALTER TABLE public.business_profiles
  ADD COLUMN hours jsonb CONSTRAINT business_profiles_hours CHECK (public.business_hours_valid(hours)),
  -- BP-17: null means not known; a set value is 1..500 characters and not blank (a tab or a line break
  -- alone is blank too).
  ADD COLUMN tone text
    CONSTRAINT business_profiles_tone CHECK (char_length(tone) BETWEEN 1 AND 500 AND tone ~ '[^[:space:]]'),
  ADD COLUMN policies jsonb NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT business_profiles_policies CHECK (public.business_policies_valid(policies)),
  ADD COLUMN fact_marks jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT business_profiles_fact_marks CHECK (public.business_fact_marks_valid(fact_marks));

-- BP-19, BP-20: a mark is true or it is gone, and only an owner sets one. On insert and on update:
-- 0. A malformed fact_marks or policies value is left to its CHECK, which names the right constraint.
-- 1. A change to hours, tone or the policy list must carry a new mark (the action always writes one), so a
--    direct write cannot set, change or clear them unmarked.
-- 2. Any other marked fact (the name, description, services, time zone) that changes while its mark does not
--    (a setup step or an operator script writing the time zone) loses its mark: the value stays, and who
--    set it is no longer recorded. Every mark carries the revision of its save, so a save by the same owner
--    at the same instant still changes the mark.
-- 3. Every new or changed mark, and every new or changed policy, must name an owner of this tenant. The
--    member read runs as the writer, under tenant_members' own tenant_scope policy.
-- The database cannot tell which owner is acting: the action stamps the owner's own member ID (BP-20).
CREATE FUNCTION public.business_profiles_fact_marks_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  k text;
  changed boolean;
  old_marks jsonb := '{}'::jsonb;
  old_policies jsonb := '[]'::jsonb;
  setter text;
BEGIN
  IF NOT (public.business_fact_marks_valid(NEW.fact_marks) AND public.business_policies_valid(NEW.policies)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    old_marks := OLD.fact_marks;
    old_policies := OLD.policies;
  END IF;

  FOREACH k IN ARRAY ARRAY['displayName', 'description', 'services', 'timeZone', 'hours', 'tone', 'policies'] LOOP
    IF TG_OP = 'INSERT' THEN
      changed := CASE k
        WHEN 'hours' THEN NEW.hours IS NOT NULL
        WHEN 'tone' THEN NEW.tone IS NOT NULL
        WHEN 'policies' THEN NEW.policies <> '[]'::jsonb
        ELSE false
      END;
    ELSE
      changed := CASE k
        WHEN 'displayName' THEN NEW.display_name IS DISTINCT FROM OLD.display_name
        WHEN 'description' THEN NEW.description IS DISTINCT FROM OLD.description
        WHEN 'services' THEN NEW.services IS DISTINCT FROM OLD.services
        WHEN 'timeZone' THEN NEW.time_zone IS DISTINCT FROM OLD.time_zone
        WHEN 'hours' THEN NEW.hours IS DISTINCT FROM OLD.hours
        WHEN 'tone' THEN NEW.tone IS DISTINCT FROM OLD.tone
        WHEN 'policies' THEN NEW.policies IS DISTINCT FROM OLD.policies
      END;
    END IF;
    IF changed AND (NEW.fact_marks->k) IS NOT DISTINCT FROM (old_marks->k) THEN
      IF k IN ('hours', 'tone', 'policies') THEN
        RAISE EXCEPTION 'A company fact changes only with the mark of the owner who set it' USING ERRCODE = 'check_violation',
          SCHEMA = 'public', TABLE = 'business_profiles', COLUMN = 'fact_marks',
          CONSTRAINT = 'business_profiles_fact_owner';
      END IF;
      NEW.fact_marks := NEW.fact_marks - k;
    END IF;
  END LOOP;

  FOR setter IN
    SELECT e.value->>'setBy' FROM jsonb_each(NEW.fact_marks) e
     WHERE e.value IS DISTINCT FROM (old_marks->e.key)
    UNION
    SELECT p.value->>'setBy' FROM jsonb_array_elements(NEW.policies) p
     WHERE NOT (old_policies @> jsonb_build_array(p.value))
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_members m
       WHERE m.tenant_id = NEW.tenant_id AND m.id = setter::uuid AND m.role = 'owner' AND m.user_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Only an owner of the business sets a company fact' USING ERRCODE = 'check_violation',
        SCHEMA = 'public', TABLE = 'business_profiles', COLUMN = 'fact_marks',
        CONSTRAINT = 'business_profiles_fact_owner';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER business_profiles_fact_marks_guard
  BEFORE INSERT OR UPDATE ON public.business_profiles
  FOR EACH ROW EXECUTE FUNCTION public.business_profiles_fact_marks_guard();

-- The runtime role may change the new columns under the table's tenant_scope policy, as it does the other
-- editable columns (the column grants add up).
GRANT UPDATE (hours, tone, policies, fact_marks) ON public.business_profiles TO authenticated;

-- Same owners as every function: invoker functions with zs_function_owner (20261018090000).
REVOKE ALL ON FUNCTION public.business_hours_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_fact_mark_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_policies_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_fact_marks_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_profiles_fact_marks_guard() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.business_hours_valid(jsonb) FROM anon;
    REVOKE ALL ON FUNCTION public.business_fact_mark_valid(jsonb) FROM anon;
    REVOKE ALL ON FUNCTION public.business_policies_valid(jsonb) FROM anon;
    REVOKE ALL ON FUNCTION public.business_fact_marks_valid(jsonb) FROM anon;
    REVOKE ALL ON FUNCTION public.business_profiles_fact_marks_guard() FROM anon;
  END IF;
END $$;
-- The CHECKs call the shape functions with the writing role's rights.
GRANT EXECUTE ON FUNCTION public.business_hours_valid(jsonb), public.business_fact_mark_valid(jsonb),
  public.business_policies_valid(jsonb), public.business_fact_marks_valid(jsonb) TO authenticated, service_role;
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.business_hours_valid(jsonb) OWNER TO zs_function_owner;
ALTER FUNCTION public.business_fact_mark_valid(jsonb) OWNER TO zs_function_owner;
ALTER FUNCTION public.business_policies_valid(jsonb) OWNER TO zs_function_owner;
ALTER FUNCTION public.business_fact_marks_valid(jsonb) OWNER TO zs_function_owner;
ALTER FUNCTION public.business_profiles_fact_marks_guard() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;
