-- Follow-up to 20261108300000_rls_initplan_fk_indexes.sql (G2). That migration found 32 foreign
-- keys with no covering index, but its check also counted a PARTIAL index (one with a WHERE
-- predicate) as cover. 11 foreign keys are covered only by a partial index. Postgres uses a
-- partial index for a lookup only when the query's WHERE clause implies the index predicate.
--
-- Seven of the 11 have the predicate `<fk column> IS NOT NULL`. The foreign-key check from the
-- parent (`... WHERE tenant_id = $1 AND col = $2`) implies it, because `=` is strict, so those
-- indexes already serve every path. They stay as they are:
--   agent_decisions_approval, booking_contacts_tenant_contact, booking_external_blocks_connection_event,
--   bookings_tenant_intake_item, intake_items_tenant_contact, media_assets_variant,
--   message_template_revisions_approval.
--
-- Four cover only rows with a status or kind predicate. Parent-side checks (ON DELETE / key
-- UPDATE, NO ACTION) cannot use them and scan the whole child table. The check runs as the table
-- owner whatever the grants say, so an owner or purge delete of a parent hits it too:
--   agent_followups.contact_id       index ... WHERE outcome = 'drafted'. Most rows are 'skipped'
--                                    (one per candidate the agent considered), so they are not in it.
--                                    Parent crm_contacts: service_role holds DELETE.
--   agent_followups.intake_item_id   unique index ... WHERE outcome = 'drafted'. The candidate
--                                    query also reads every outcome (max(created_at), and
--                                    `outcome = 'drafted' OR run_id = $5`), so it needs a full index
--                                    too. Parent intake_items: service_role holds DELETE.
--   calendar_connections.resource_id unique index ... WHERE status IN ('active','reauthorize').
--                                    'disconnected' rows are kept as history. Parent
--                                    booking_resources: service_role holds DELETE. Every app lookup
--                                    by resource_id also tests status = 'active', which the partial
--                                    index serves, so it stays.
--   wallet_ledger.reservation_id     unique index ... WHERE kind = 'capture'. No runtime role can
--                                    delete a wallet_reservations row, but the owner can (a tenant
--                                    purge or a manual cleanup), and the foreign-key check runs as
--                                    the owner: every such delete would scan the whole ledger,
--                                    which grows with every message. The index is cheap (the ledger
--                                    is append-only), so it is added rather than argued away.
--
-- The partial indexes stay: the unique ones enforce a rule, and the others serve the cap counts.
--
-- Apply in a quiet window. Plain CREATE INDEX (no CONCURRENTLY, which cannot run in a
-- transaction) blocks writes to the table while it builds, and the hosted runner applies ALL
-- pending migration files in ONE transaction (packages/db/src/migrate.ts), so every lock taken
-- here is held until the whole batch commits, not until this file ends. The runner's
-- lock_timeout (5 s) fails the batch cleanly if a writer holds a table. These tables are small on
-- hosted (under 5 rows on 2026-11-08); a table past about 1M rows needs the index built
-- CONCURRENTLY by hand instead. IF NOT EXISTS skips a name that already exists, even a different
-- definition, so packages/db/test/rls-initplan.test.ts asserts each index's full definition.

CREATE INDEX IF NOT EXISTS agent_followups_tenant_id_contact_id_idx
  ON public.agent_followups (tenant_id, contact_id);
-- created_at last: the candidate query's max(created_at) per intake item reads one index entry.
CREATE INDEX IF NOT EXISTS agent_followups_tenant_id_intake_item_id_idx
  ON public.agent_followups (tenant_id, intake_item_id, created_at);
CREATE INDEX IF NOT EXISTS calendar_connections_tenant_id_resource_id_idx
  ON public.calendar_connections (tenant_id, resource_id);
CREATE INDEX IF NOT EXISTS wallet_ledger_tenant_id_reservation_id_idx
  ON public.wallet_ledger (tenant_id, reservation_id);
