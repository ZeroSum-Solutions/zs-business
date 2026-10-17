import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { tenants } from "./index.js";

// Mirrors supabase/migrations/*_crm.sql. SQL also FORCEs RLS and sets column grants.
const authenticated = pgRole("authenticated").existing();
const tenantPolicy = (tenantId: AnyPgColumn) =>
  pgPolicy("tenant_scope", {
    for: "all",
    to: authenticated,
    using: sql`${tenantId} = nullif(current_setting('app.tenant_id', true), '')::uuid`,
    withCheck: sql`${tenantId} = nullif(current_setting('app.tenant_id', true), '')::uuid`,
  });
const textLength = (name: string, column: AnyPgColumn) =>
  check(name, sql`char_length(${column}) BETWEEN 1 AND 200`);
const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const crmConsentChannel = pgEnum("crm_consent_channel", ["email", "sms"]);
export const crmConsentStatus = pgEnum("crm_consent_status", ["granted", "denied"]);

export const crmContacts = pgTable(
  "crm_contacts",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.tenantId),
    id: uuid("id").notNull(),
    displayName: text("display_name"),
    normalizedEmail: text("normalized_email")
      .default(sql`('unset-' || gen_random_uuid()::text || '@placeholder.invalid')`),
    e164Phone: text("e164_phone"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    textLength("crm_contacts_display_name_length", table.displayName),
    check("crm_contacts_email_canonical", sql`char_length(${table.normalizedEmail}) <= 254
      AND ${table.normalizedEmail} = lower(${table.normalizedEmail})
      AND ${table.normalizedEmail} ~ '^(?!\\.)(?!.*\\.\\.)[a-z0-9_''+.-]*[a-z0-9_+-]@([a-z0-9][a-z0-9-]*\\.)+[a-z]{2,}$'`),
    check("crm_contacts_phone_e164", sql`${table.e164Phone} ~ '^\\+[1-9][0-9]{1,14}$'`),
    check("crm_contacts_identity_required",
      sql`${table.normalizedEmail} IS NOT NULL OR ${table.e164Phone} IS NOT NULL`),
    uniqueIndex("crm_contacts_tenant_email").on(table.tenantId, table.normalizedEmail)
      .where(sql`${table.normalizedEmail} IS NOT NULL`),
    uniqueIndex("crm_contacts_tenant_phone").on(table.tenantId, table.e164Phone)
      .where(sql`${table.e164Phone} IS NOT NULL`),
    tenantPolicy(table.tenantId),
  ],
).enableRLS();

export const crmContactConsent = pgTable(
  "crm_contact_consent",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.tenantId),
    contactId: uuid("contact_id").notNull(),
    channel: crmConsentChannel("channel").notNull(),
    status: crmConsentStatus("status").notNull(),
    source: text("source").notNull(),
    recordedAt: timestamptz("recorded_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.contactId, table.channel] }),
    foreignKey({
      columns: [table.tenantId, table.contactId],
      foreignColumns: [crmContacts.tenantId, crmContacts.id],
    }),
    textLength("crm_contact_consent_source_length", table.source),
    tenantPolicy(table.tenantId),
  ],
).enableRLS();

export const crmPipelines = pgTable(
  "crm_pipelines",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.tenantId),
    id: uuid("id").notNull(),
    name: text("name").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    textLength("crm_pipelines_name_length", table.name),
    tenantPolicy(table.tenantId),
  ],
).enableRLS();

export const crmStages = pgTable(
  "crm_stages",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.tenantId),
    id: uuid("id").notNull(),
    pipelineId: uuid("pipeline_id").notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    unique("crm_stages_pipeline_member").on(table.tenantId, table.pipelineId, table.id),
    unique("crm_stages_pipeline_position").on(table.tenantId, table.pipelineId, table.position),
    foreignKey({
      columns: [table.tenantId, table.pipelineId],
      foreignColumns: [crmPipelines.tenantId, crmPipelines.id],
    }),
    textLength("crm_stages_name_length", table.name),
    check("crm_stages_position_nonnegative", sql`${table.position} >= 0`),
    tenantPolicy(table.tenantId),
  ],
).enableRLS();

export const crmDeals = pgTable(
  "crm_deals",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.tenantId),
    id: uuid("id").notNull(),
    contactId: uuid("contact_id").notNull(),
    pipelineId: uuid("pipeline_id").notNull(),
    stageId: uuid("stage_id").notNull(),
    title: text("title").notNull(),
    // Range stays within Number.MAX_SAFE_INTEGER; serialize as a JS number.
    revision: bigint("revision", { mode: "number" }).notNull(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId, table.contactId],
      foreignColumns: [crmContacts.tenantId, crmContacts.id],
    }),
    foreignKey({
      columns: [table.tenantId, table.pipelineId],
      foreignColumns: [crmPipelines.tenantId, crmPipelines.id],
    }),
    foreignKey({
      columns: [table.tenantId, table.pipelineId, table.stageId],
      foreignColumns: [crmStages.tenantId, crmStages.pipelineId, crmStages.id],
    }),
    textLength("crm_deals_title_length", table.title),
    check("crm_deals_revision_range", sql`${table.revision} BETWEEN 1 AND 9007199254740991`),
    index("crm_deals_tenant_contact").on(table.tenantId, table.contactId),
    index("crm_deals_tenant_stage").on(table.tenantId, table.pipelineId, table.stageId),
    tenantPolicy(table.tenantId),
  ],
).enableRLS();
