import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { ApprovalReference, JsonValue, Target } from "@zs/contracts";

const authenticated = pgRole("authenticated").existing();
const tenantPolicy = (tenantId: AnyPgColumn) =>
  pgPolicy("tenant_scope", {
    for: "all",
    to: authenticated,
    using: sql`${tenantId} = nullif(current_setting('app.tenant_id', true), '')::uuid`,
    withCheck: sql`${tenantId} = nullif(current_setting('app.tenant_id', true), '')::uuid`,
  });
// SQL migrations also FORCE RLS and specify grants; Drizzle exposes ENABLE RLS only.
export const tenants = pgTable(
  "tenants",
  {
    tenantId: uuid("tenant_id").primaryKey(),
    name: text("name").notNull(),
  },
  (table) => [
    check("tenants_name_nonempty", sql`length(${table.name}) > 0`),
    tenantPolicy(table.tenantId),
  ],
).enableRLS();
export const actions = pgTable(
  "actions",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId),
    id: uuid("id").notNull(),
    actorId: uuid("actor_id").notNull(),
    actionType: text("action_type").notNull(),
    target: jsonb("target").$type<Target>().notNull(),
    payload: jsonb("payload").$type<JsonValue>().notNull(),
    approvalReference: jsonb("approval_reference").$type<ApprovalReference>(),
    idempotencyKey: text("idempotency_key").notNull(),
    result: jsonb("result").$type<JsonValue>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    unique("actions_tenant_key").on(table.tenantId, table.idempotencyKey),
    check("actions_type_nonempty", sql`length(${table.actionType}) > 0`),
    check("actions_key_nonempty", sql`length(${table.idempotencyKey}) > 0`),
    tenantPolicy(table.tenantId),
  ],
).enableRLS();
export const outbox = pgTable(
  "outbox",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId),
    id: uuid("id").notNull(),
    actionId: uuid("action_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<JsonValue>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    unique("outbox_one_per_action").on(table.tenantId, table.actionId),
    foreignKey({
      columns: [table.tenantId, table.actionId],
      foreignColumns: [actions.tenantId, actions.id],
    }),
    check("outbox_type_nonempty", sql`length(${table.eventType}) > 0`),
    tenantPolicy(table.tenantId),
  ],
).enableRLS();
