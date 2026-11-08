import { sql } from "drizzle-orm";
import { pgPolicy, pgRole } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

const authenticated = pgRole("authenticated").existing();
const dispatcher = pgRole("zs_dispatcher").existing();

/**
 * The `tenant_scope` policy as the migrations hold it since 20261108300000_rls_initplan_fk_indexes.sql:
 * the session setting is read through a scalar subselect, so Postgres evaluates it once per
 * statement instead of once per row (the advisor's auth_rls_initplan lint). `history` adds the
 * dispatcher role, which reads tenants, actions and the outbox.
 * SQL migrations also FORCE RLS and specify grants; Drizzle exposes ENABLE RLS only.
 * test/drizzle-drift.test.ts fails when this text and the database differ.
 */
export const tenantPolicy = (tenantId: AnyPgColumn, history = false) =>
  pgPolicy("tenant_scope", {
    for: "all",
    to: history ? [authenticated, dispatcher] : authenticated,
    using: sql`${tenantId} = nullif((select current_setting('app.tenant_id', true)), '')::uuid`,
    withCheck: sql`${tenantId} = nullif((select current_setting('app.tenant_id', true)), '')::uuid`,
  });
