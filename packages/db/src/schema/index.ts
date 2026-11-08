import { sql } from "drizzle-orm";
import {
  check,
  bigint,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ApprovalReference, JsonValue, Target } from "@zs/contracts";
import { tenantPolicy } from "./tenant-policy.js";

export const tenants = pgTable(
  "tenants",
  {
    tenantId: uuid("tenant_id").primaryKey(),
    name: text("name").notNull(),
    /** Set while a tenant is provisioned with an owner invite; see 20261107100000_industry_templates.sql. */
    provisioningOwnerEmail: text("provisioning_owner_email"),
  },
  (table) => [
    check("tenants_name_nonempty", sql`length(${table.name}) > 0`),
    tenantPolicy(table.tenantId, true),
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
    uniqueIndex("actions_tenant_approval")
      .on(table.tenantId, sql`((${table.approvalReference}->>'id')::uuid)`)
      .where(sql`${table.approvalReference} IS NOT NULL`),
    check("actions_type_nonempty", sql`length(${table.actionType}) > 0`),
    check("actions_key_nonempty", sql`length(${table.idempotencyKey}) > 0`),
    tenantPolicy(table.tenantId, true),
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
    seq: bigint("seq", { mode: "bigint" }).generatedAlwaysAsIdentity().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
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
    index("outbox_unprocessed").on(table.eventType, table.seq).where(sql`${table.processedAt} IS NULL`),
    index("outbox_tenant_type_created").on(table.tenantId, table.eventType, table.createdAt, table.id),
    tenantPolicy(table.tenantId, true),
  ],
).enableRLS();
export * from "./booking.js";
export * from "./crm.js";
export * from "./members.js";
