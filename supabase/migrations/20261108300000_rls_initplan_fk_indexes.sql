-- Supabase performance advisor, project zs-business, 2026-11-08 (L9 follow-up):
--   auth_rls_initplan (89 policies) and unindexed_foreign_keys (32 foreign keys).
--
-- 1) Every policy below keeps its role list, command and predicate. The only change is that the
--    session setting is read through a scalar subselect, so Postgres evaluates it once per
--    statement (an InitPlan) instead of once per row:
--      tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
--      -> tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid
--      current_setting('app.platform', true) = 'on'
--      -> (select current_setting('app.platform', true)) = 'on'
--    current_setting() is STABLE and the setting cannot change inside one statement, so the
--    result is identical. The definitions were taken from the live catalog and match what the
--    earlier migrations build (compared policy by policy). Each DROP and CREATE pair runs in the
--    migration runner's single transaction, so no statement ever sees a table without its policy.
--    The three policies the advisor does not flag (USING (true)) are left alone.
-- 2) One plain CREATE INDEX per foreign key that no index covers. The runner applies a file in a
--    transaction, so CREATE INDEX CONCURRENTLY is not possible. Every table is under 5 rows on
--    hosted (largest 96 kB incl. indexes on 2026-11-08), so the build locks for milliseconds.
--    A table that grows past about 1M rows needs its index built CONCURRENTLY by hand instead.

DROP POLICY IF EXISTS tenant_scope ON public.actions;
CREATE POLICY tenant_scope ON public.actions
  FOR ALL TO authenticated, zs_dispatcher
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.agent_decisions;
CREATE POLICY tenant_scope ON public.agent_decisions
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.agent_followups;
CREATE POLICY tenant_scope ON public.agent_followups
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.agent_model_calls;
CREATE POLICY tenant_scope ON public.agent_model_calls
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.agent_runs;
CREATE POLICY tenant_scope ON public.agent_runs
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.agent_settings;
CREATE POLICY tenant_scope ON public.agent_settings
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.approvals;
CREATE POLICY tenant_scope ON public.approvals
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.automation_token_usage;
CREATE POLICY tenant_scope ON public.automation_token_usage
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.automation_tokens;
CREATE POLICY tenant_scope ON public.automation_tokens
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.booking_contacts;
CREATE POLICY tenant_scope ON public.booking_contacts
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.booking_external_blocks;
CREATE POLICY tenant_scope ON public.booking_external_blocks
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.booking_page_disclosures;
CREATE POLICY tenant_scope ON public.booking_page_disclosures
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.booking_page_resources;
CREATE POLICY tenant_scope ON public.booking_page_resources
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.booking_pages;
CREATE POLICY tenant_scope ON public.booking_pages
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.booking_resources;
CREATE POLICY tenant_scope ON public.booking_resources
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.bookings;
CREATE POLICY tenant_scope ON public.bookings
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.browser_credentials;
CREATE POLICY tenant_scope ON public.browser_credentials
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.browser_run_artifacts;
CREATE POLICY tenant_scope ON public.browser_run_artifacts
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.browser_run_events;
CREATE POLICY tenant_scope ON public.browser_run_events
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.browser_runs;
CREATE POLICY tenant_scope ON public.browser_runs
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.browser_targets;
CREATE POLICY tenant_scope ON public.browser_targets
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.browser_task_settings;
CREATE POLICY tenant_scope ON public.browser_task_settings
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.business_profiles;
CREATE POLICY tenant_scope ON public.business_profiles
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.calendar_connections;
CREATE POLICY tenant_scope ON public.calendar_connections
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS calendar_push_notifications_intake ON public.calendar_push_notifications;
CREATE POLICY calendar_push_notifications_intake ON public.calendar_push_notifications
  FOR INSERT TO authenticated
  WITH CHECK (processed_at IS NULL AND (select current_setting('app.platform', true)) = 'on');

DROP POLICY IF EXISTS tenant_scope ON public.calendar_pushes;
CREATE POLICY tenant_scope ON public.calendar_pushes
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.catalog_items;
CREATE POLICY tenant_scope ON public.catalog_items
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.connection_attempts;
CREATE POLICY tenant_scope ON public.connection_attempts
  FOR ALL TO authenticated, zs_dispatcher
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.connections;
CREATE POLICY tenant_scope ON public.connections
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.crm_contact_consent;
CREATE POLICY tenant_scope ON public.crm_contact_consent
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.crm_contact_profile;
CREATE POLICY tenant_scope ON public.crm_contact_profile
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.crm_contacts;
CREATE POLICY tenant_scope ON public.crm_contacts
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.crm_deals;
CREATE POLICY tenant_scope ON public.crm_deals
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.crm_pipelines;
CREATE POLICY tenant_scope ON public.crm_pipelines
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.crm_stages;
CREATE POLICY tenant_scope ON public.crm_stages
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS platform_claim_lease ON public.document_intake_jobs;
CREATE POLICY platform_claim_lease ON public.document_intake_jobs
  FOR UPDATE TO authenticated
  USING ((select current_setting('app.platform', true)) = 'on')
  WITH CHECK ((select current_setting('app.platform', true)) = 'on');

DROP POLICY IF EXISTS platform_claim_read ON public.document_intake_jobs;
CREATE POLICY platform_claim_read ON public.document_intake_jobs
  FOR SELECT TO authenticated
  USING ((select current_setting('app.platform', true)) = 'on');

DROP POLICY IF EXISTS tenant_scope ON public.document_intake_jobs;
CREATE POLICY tenant_scope ON public.document_intake_jobs
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.document_intake_rows;
CREATE POLICY tenant_scope ON public.document_intake_rows
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.enrichment_requests;
CREATE POLICY tenant_scope ON public.enrichment_requests
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.enrichment_results;
CREATE POLICY tenant_scope ON public.enrichment_results
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.image_variants;
CREATE POLICY tenant_scope ON public.image_variants
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.inbox_replies;
CREATE POLICY tenant_scope ON public.inbox_replies
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.intake_item_consent;
CREATE POLICY tenant_scope ON public.intake_item_consent
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.intake_items;
CREATE POLICY tenant_scope ON public.intake_items
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.knowledge_entries;
CREATE POLICY tenant_scope ON public.knowledge_entries
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.media_assets;
CREATE POLICY tenant_scope ON public.media_assets
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.message_deliveries;
CREATE POLICY tenant_scope ON public.message_deliveries
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.message_delivery_attempts;
CREATE POLICY tenant_scope ON public.message_delivery_attempts
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.message_template_revisions;
CREATE POLICY tenant_scope ON public.message_template_revisions
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.message_templates;
CREATE POLICY tenant_scope ON public.message_templates
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.outbox;
CREATE POLICY tenant_scope ON public.outbox
  FOR ALL TO authenticated, zs_dispatcher
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.plan_checkouts;
CREATE POLICY tenant_scope ON public.plan_checkouts
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.plan_invoices;
CREATE POLICY tenant_scope ON public.plan_invoices
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.plan_subscriptions;
CREATE POLICY tenant_scope ON public.plan_subscriptions
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.shopify_claims;
CREATE POLICY tenant_scope ON public.shopify_claims
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.site_activations;
CREATE POLICY tenant_scope ON public.site_activations
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.site_hosts;
CREATE POLICY tenant_scope ON public.site_hosts
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.site_pointers;
CREATE POLICY tenant_scope ON public.site_pointers
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.site_release_files;
CREATE POLICY tenant_scope ON public.site_release_files
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.site_releases;
CREATE POLICY tenant_scope ON public.site_releases
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.sites;
CREATE POLICY tenant_scope ON public.sites
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.sms_numbers;
CREATE POLICY tenant_scope ON public.sms_numbers
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.sms_status_events;
CREATE POLICY tenant_scope ON public.sms_status_events
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.source_records;
CREATE POLICY tenant_scope ON public.source_records
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS stripe_events_intake ON public.stripe_events;
CREATE POLICY stripe_events_intake ON public.stripe_events
  FOR INSERT TO authenticated
  WITH CHECK (processed_at IS NULL AND attempts = 0 AND (select current_setting('app.platform', true)) = 'on');

DROP POLICY IF EXISTS tenant_scope ON public.suppressions;
CREATE POLICY tenant_scope ON public.suppressions
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.tenant_members;
CREATE POLICY tenant_scope ON public.tenant_members
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.tenant_plans;
CREATE POLICY tenant_scope ON public.tenant_plans
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.tenant_setups;
CREATE POLICY tenant_scope ON public.tenant_setups
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.tenants;
CREATE POLICY tenant_scope ON public.tenants
  FOR ALL TO authenticated, zs_dispatcher
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS platform_claim_lease ON public.transcription_jobs;
CREATE POLICY platform_claim_lease ON public.transcription_jobs
  FOR UPDATE TO authenticated
  USING ((select current_setting('app.platform', true)) = 'on')
  WITH CHECK ((select current_setting('app.platform', true)) = 'on');

DROP POLICY IF EXISTS platform_claim_read ON public.transcription_jobs;
CREATE POLICY platform_claim_read ON public.transcription_jobs
  FOR SELECT TO authenticated
  USING ((select current_setting('app.platform', true)) = 'on');

DROP POLICY IF EXISTS tenant_scope ON public.transcription_jobs;
CREATE POLICY tenant_scope ON public.transcription_jobs
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.transcripts;
CREATE POLICY tenant_scope ON public.transcripts
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.voice_calls;
CREATE POLICY tenant_scope ON public.voice_calls
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.voice_numbers;
CREATE POLICY tenant_scope ON public.voice_numbers
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.voice_textback_consents;
CREATE POLICY tenant_scope ON public.voice_textback_consents
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.voice_textback_disclosures;
CREATE POLICY tenant_scope ON public.voice_textback_disclosures
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.voicemails;
CREATE POLICY tenant_scope ON public.voicemails
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.wallet_billing_events;
CREATE POLICY tenant_scope ON public.wallet_billing_events
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.wallet_ledger;
CREATE POLICY tenant_scope ON public.wallet_ledger
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.wallet_reservations;
CREATE POLICY tenant_scope ON public.wallet_reservations
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.wallet_topups;
CREATE POLICY tenant_scope ON public.wallet_topups
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.wallets;
CREATE POLICY tenant_scope ON public.wallets
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.webhook_deliveries;
CREATE POLICY tenant_scope ON public.webhook_deliveries
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.webhook_delivery_attempts;
CREATE POLICY tenant_scope ON public.webhook_delivery_attempts
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.webhook_endpoints;
CREATE POLICY tenant_scope ON public.webhook_endpoints
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

DROP POLICY IF EXISTS tenant_scope ON public.webhook_ingest_marks;
CREATE POLICY tenant_scope ON public.webhook_ingest_marks
  FOR ALL TO authenticated
  USING (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid)
  WITH CHECK (tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid);

-- Foreign-key covering indexes (leading columns match the key, in key order).
CREATE INDEX IF NOT EXISTS agent_decisions_tenant_id_contact_id_idx ON public.agent_decisions (tenant_id, contact_id);
CREATE INDEX IF NOT EXISTS agent_decisions_tenant_id_run_id_agent_kind_idx ON public.agent_decisions (tenant_id, run_id, agent_kind);
CREATE INDEX IF NOT EXISTS agent_followups_tenant_id_approval_id_idx ON public.agent_followups (tenant_id, approval_id);
CREATE INDEX IF NOT EXISTS agent_followups_tenant_id_reply_id_idx ON public.agent_followups (tenant_id, reply_id);
CREATE INDEX IF NOT EXISTS agent_model_calls_tenant_id_run_id_agent_kind_idx ON public.agent_model_calls (tenant_id, run_id, agent_kind);
CREATE INDEX IF NOT EXISTS booking_page_resources_tenant_id_resource_id_idx ON public.booking_page_resources (tenant_id, resource_id);
CREATE INDEX IF NOT EXISTS browser_run_events_tenant_id_screenshot_ref_idx ON public.browser_run_events (tenant_id, screenshot_ref);
CREATE INDEX IF NOT EXISTS browser_runs_tenant_id_target_id_idx ON public.browser_runs (tenant_id, target_id);
CREATE INDEX IF NOT EXISTS calendar_pushes_tenant_id_booking_id_idx ON public.calendar_pushes (tenant_id, booking_id);
CREATE INDEX IF NOT EXISTS connection_attempts_tenant_id_created_by_idx ON public.connection_attempts (tenant_id, created_by);
CREATE INDEX IF NOT EXISTS connections_tenant_id_connected_by_idx ON public.connections (tenant_id, connected_by);
CREATE INDEX IF NOT EXISTS intake_items_tenant_id_page_id_idx ON public.intake_items (tenant_id, page_id);
CREATE INDEX IF NOT EXISTS message_deliveries_tenant_id_action_id_idx ON public.message_deliveries (tenant_id, action_id);
CREATE INDEX IF NOT EXISTS message_deliveries_tenant_id_contact_id_idx ON public.message_deliveries (tenant_id, contact_id);
CREATE INDEX IF NOT EXISTS message_templates_current_fk_idx ON public.message_templates (tenant_id, id, current_revision);
CREATE INDEX IF NOT EXISTS shopify_claims_tenant_id_created_by_idx ON public.shopify_claims (tenant_id, created_by);
CREATE INDEX IF NOT EXISTS site_activations_tenant_id_site_id_release_id_idx ON public.site_activations (tenant_id, site_id, release_id);
CREATE INDEX IF NOT EXISTS site_pointers_tenant_id_site_id_release_id_idx ON public.site_pointers (tenant_id, site_id, release_id);
CREATE INDEX IF NOT EXISTS tenant_setups_action_fk_idx ON public.tenant_setups (tenant_id, action_id);
CREATE INDEX IF NOT EXISTS tenant_setups_page_fk_idx ON public.tenant_setups (tenant_id, booking_page_id);
CREATE INDEX IF NOT EXISTS tenant_setups_pipeline_fk_idx ON public.tenant_setups (tenant_id, pipeline_id);
CREATE INDEX IF NOT EXISTS tenant_setups_resource_fk_idx ON public.tenant_setups (tenant_id, resource_id);
CREATE INDEX IF NOT EXISTS voice_calls_tenant_id_disclosure_version_idx ON public.voice_calls (tenant_id, disclosure_version);
CREATE INDEX IF NOT EXISTS voice_numbers_tenant_id_disclosure_version_idx ON public.voice_numbers (tenant_id, disclosure_version);
CREATE INDEX IF NOT EXISTS voice_numbers_tenant_id_phone_number_idx ON public.voice_numbers (tenant_id, phone_number);
CREATE INDEX IF NOT EXISTS voice_textback_consents_tenant_id_contact_id_idx ON public.voice_textback_consents (tenant_id, contact_id);
CREATE INDEX IF NOT EXISTS voice_textback_consents_tenant_id_disclosure_version_idx ON public.voice_textback_consents (tenant_id, disclosure_version);
CREATE INDEX IF NOT EXISTS voicemails_tenant_id_contact_id_idx ON public.voicemails (tenant_id, contact_id);
CREATE INDEX IF NOT EXISTS wallet_billing_events_tenant_id_topup_id_idx ON public.wallet_billing_events (tenant_id, topup_id);
CREATE INDEX IF NOT EXISTS wallet_reservations_tenant_id_delivery_id_idx ON public.wallet_reservations (tenant_id, delivery_id);
CREATE INDEX IF NOT EXISTS webhook_deliveries_tenant_id_outbox_id_idx ON public.webhook_deliveries (tenant_id, outbox_id);
CREATE INDEX IF NOT EXISTS webhook_ingest_marks_tenant_id_outbox_id_idx ON public.webhook_ingest_marks (tenant_id, outbox_id);
