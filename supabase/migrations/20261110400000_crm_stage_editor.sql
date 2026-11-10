-- Pipeline stage editor (docs/requirements/crm.md revision 4, C-25..C-33). A stage is archived,
-- never deleted: archived_at null means live. Additive: one nullable column, a column-level UPDATE
-- grant and two guard triggers. No data changes.

ALTER TABLE public.crm_stages ADD COLUMN archived_at timestamptz;

-- C-26: the runtime role renames, reorders and archives. It cannot move a stage to another
-- pipeline, change its outcome, or delete it (no DELETE grant exists).
GRANT UPDATE (name, position, archived_at) ON public.crm_stages TO authenticated;
-- C-26: nobody deletes a stage, the workers' service role included. Deleting a tenant still cascades.
REVOKE DELETE ON public.crm_stages FROM service_role;

-- C-31: no deal enters an archived stage, however it got there. FOR SHARE makes a concurrent
-- archive wait for this insert (or this insert wait for the archive and then see it).
CREATE FUNCTION public.crm_deals_stage_live() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  archived timestamptz;
BEGIN
  SELECT s.archived_at INTO archived FROM public.crm_stages s
   WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.stage_id FOR SHARE;
  IF archived IS NOT NULL THEN
    RAISE EXCEPTION 'The stage is archived' USING ERRCODE = '23514', CONSTRAINT = 'crm_deals_stage_live';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_deals_stage_live
  BEFORE INSERT OR UPDATE OF stage_id ON public.crm_deals
  FOR EACH ROW EXECUTE FUNCTION public.crm_deals_stage_live();

-- C-31: a stage that still holds a deal cannot be archived. The row is locked before this runs,
-- and the deal check reads a fresh snapshot, so a deal committed a moment ago is seen.
CREATE FUNCTION public.crm_stages_archive_empty() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.crm_deals d WHERE d.tenant_id = NEW.tenant_id AND d.stage_id = NEW.id) THEN
    RAISE EXCEPTION 'The stage still holds deals' USING ERRCODE = '23514', CONSTRAINT = 'crm_stages_archive_empty';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_stages_archive_empty
  BEFORE UPDATE OF archived_at ON public.crm_stages
  FOR EACH ROW WHEN (OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL)
  EXECUTE FUNCTION public.crm_stages_archive_empty();

-- Same hardening as every invoker function (20261018090000): no PUBLIC or anon execute, owned by
-- zs_function_owner (CREATE on the schema only for the transfer).
REVOKE ALL ON FUNCTION public.crm_deals_stage_live() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crm_stages_archive_empty() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.crm_deals_stage_live() FROM anon;
    REVOKE ALL ON FUNCTION public.crm_stages_archive_empty() FROM anon;
  END IF;
END $$;
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.crm_deals_stage_live() OWNER TO zs_function_owner;
ALTER FUNCTION public.crm_stages_archive_empty() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;
