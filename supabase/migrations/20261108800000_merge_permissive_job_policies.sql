-- Clears the advisor's multiple_permissive_policies lint (4 rows) on document_intake_jobs and
-- transcription_jobs. Each table had three permissive policies for `authenticated`:
--   tenant_scope          FOR ALL     USING tenant          WITH CHECK tenant
--   platform_claim_read   FOR SELECT  USING platform
--   platform_claim_lease  FOR UPDATE  USING platform        WITH CHECK platform
-- so SELECT and UPDATE each ran two policies per row. Postgres combines permissive policies
-- with OR (USING with USING, WITH CHECK with WITH CHECK, each on its own), so one policy per
-- command whose expressions are the OR of the old ones grants exactly the same rows:
--   SELECT  USING (tenant OR platform)
--   UPDATE  USING (tenant OR platform)  WITH CHECK (tenant OR platform)
--   INSERT  WITH CHECK tenant           (platform never had INSERT)
--   DELETE  USING tenant                (platform never had DELETE)
-- tenant   = tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid
-- platform = (select current_setting('app.platform', true)) = 'on'
-- Both settings are still read through a scalar subselect (auth_rls_initplan stays clear).
-- Grants are unchanged. packages/db/test/merged-job-policies.test.ts proves equal access.

DROP POLICY IF EXISTS tenant_scope ON public.document_intake_jobs;
DROP POLICY IF EXISTS platform_claim_read ON public.document_intake_jobs;
DROP POLICY IF EXISTS platform_claim_lease ON public.document_intake_jobs;

CREATE POLICY tenant_or_platform_read ON public.document_intake_jobs
  FOR SELECT TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid
    OR (select current_setting('app.platform', true)) = 'on');
CREATE POLICY tenant_or_platform_update ON public.document_intake_jobs
  FOR UPDATE TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid
    OR (select current_setting('app.platform', true)) = 'on')
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid
    OR (select current_setting('app.platform', true)) = 'on');
CREATE POLICY tenant_scope_insert ON public.document_intake_jobs
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);
CREATE POLICY tenant_scope_delete ON public.document_intake_jobs
  FOR DELETE TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.transcription_jobs;
DROP POLICY IF EXISTS platform_claim_read ON public.transcription_jobs;
DROP POLICY IF EXISTS platform_claim_lease ON public.transcription_jobs;

CREATE POLICY tenant_or_platform_read ON public.transcription_jobs
  FOR SELECT TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid
    OR (select current_setting('app.platform', true)) = 'on');
CREATE POLICY tenant_or_platform_update ON public.transcription_jobs
  FOR UPDATE TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid
    OR (select current_setting('app.platform', true)) = 'on')
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid
    OR (select current_setting('app.platform', true)) = 'on');
CREATE POLICY tenant_scope_insert ON public.transcription_jobs
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);
CREATE POLICY tenant_scope_delete ON public.transcription_jobs
  FOR DELETE TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);
