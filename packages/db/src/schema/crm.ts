import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
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
import { tenantPolicy } from "./tenant-policy.js";

// Mirrors supabase/migrations/*_crm.sql. SQL also FORCEs RLS and sets column grants. Nothing in the app
// imports these tables (runtime code uses raw SQL through pg); select explicit columns if that changes.
const textLength = (name: string, column: AnyPgColumn) =>
  check(name, sql`char_length(${column}) BETWEEN 1 AND 200`);
const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/** Same list as the crm_deals_lead_source CHECK (20261020200000_inbox_home.sql). */
export const dealLeadSources = ["website", "referral", "phone", "email", "walk_in", "social", "ads", "other"] as const;

/** ISO 4217 codes accepted by crm_deals_currency_code (20261022520000_deal_currency_iso.sql). */
const dealCurrencies = [
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD",
  "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL", "BSD", "BTN", "BWP", "BYN",
  "BZD", "CAD", "CDF", "CHF", "CLP", "CNY", "COP", "CRC", "CUC", "CUP", "CVE", "CZK",
  "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL",
  "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HRK", "HTG", "HUF", "IDR",
  "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF",
  "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD",
  "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MYR",
  "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP",
  "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG",
  "SEK", "SGD", "SHP", "SLE", "SLL", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL",
  "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD",
  "UYU", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XCG", "XDR", "XOF",
  "XPF", "XSU", "YER", "ZAR", "ZMW", "ZWG", "ZWL",
] as const;

export const crmConsentChannel = pgEnum("crm_consent_channel", ["email", "sms"]);
export const crmConsentStatus = pgEnum("crm_consent_status", ["granted", "denied"]);

export const crmContacts = pgTable(
  "crm_contacts",
  {
    tenantId: uuid("tenant_id").notNull(),
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
    foreignKey({ name: "crm_contacts_tenant_id_fkey", columns: [table.tenantId], foreignColumns: [tenants.tenantId] }),
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
    index("crm_contacts_tenant_recent").on(table.tenantId, table.createdAt.desc().nullsFirst(), table.id),
    index("crm_contacts_tenant_name").on(table.tenantId,
      sql`lower(COALESCE(${table.displayName}, ${table.normalizedEmail}, ${table.e164Phone}))`, table.id),
    tenantPolicy(table.tenantId),
  ],
).enableRLS();

export const crmContactConsent = pgTable(
  "crm_contact_consent",
  {
    tenantId: uuid("tenant_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    channel: crmConsentChannel("channel").notNull(),
    status: crmConsentStatus("status").notNull(),
    source: text("source").notNull(),
    recordedAt: timestamptz("recorded_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.contactId, table.channel] }),
    foreignKey({ name: "crm_contact_consent_tenant_id_fkey", columns: [table.tenantId], foreignColumns: [tenants.tenantId] }),
    foreignKey({
      name: "crm_contact_consent_tenant_id_contact_id_fkey",
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
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull(),
    name: text("name").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({ name: "crm_pipelines_tenant_id_fkey", columns: [table.tenantId], foreignColumns: [tenants.tenantId] }),
    textLength("crm_pipelines_name_length", table.name),
    tenantPolicy(table.tenantId),
  ],
).enableRLS();

export const crmStages = pgTable(
  "crm_stages",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull(),
    pipelineId: uuid("pipeline_id").notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    outcome: text("outcome").$type<"open" | "won" | "lost">().notNull().default("open"),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    unique("crm_stages_pipeline_member").on(table.tenantId, table.pipelineId, table.id),
    unique("crm_stages_pipeline_position").on(table.tenantId, table.pipelineId, table.position),
    foreignKey({ name: "crm_stages_tenant_id_fkey", columns: [table.tenantId], foreignColumns: [tenants.tenantId] }),
    foreignKey({
      name: "crm_stages_tenant_id_pipeline_id_fkey",
      columns: [table.tenantId, table.pipelineId],
      foreignColumns: [crmPipelines.tenantId, crmPipelines.id],
    }),
    textLength("crm_stages_name_length", table.name),
    check("crm_stages_position_nonnegative", sql`${table.position} >= 0`),
    check("crm_stages_outcome", sql`${table.outcome} IN ('open', 'won', 'lost')`),
    tenantPolicy(table.tenantId),
  ],
).enableRLS();

export const crmDeals = pgTable(
  "crm_deals",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull(),
    contactId: uuid("contact_id").notNull(),
    pipelineId: uuid("pipeline_id").notNull(),
    stageId: uuid("stage_id").notNull(),
    title: text("title").notNull(),
    // Range stays within Number.MAX_SAFE_INTEGER; serialize as a JS number.
    revision: bigint("revision", { mode: "number" }).notNull(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    // These four were added later (H-1) and come last in the database, so they come last here.
    valueMinor: bigint("value_minor", { mode: "number" }),
    currency: text("currency"),
    leadSource: text("lead_source").$type<(typeof dealLeadSources)[number]>(),
    wonAt: timestamptz("won_at"),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({ name: "crm_deals_tenant_id_fkey", columns: [table.tenantId], foreignColumns: [tenants.tenantId] }),
    foreignKey({
      name: "crm_deals_tenant_id_contact_id_fkey",
      columns: [table.tenantId, table.contactId],
      foreignColumns: [crmContacts.tenantId, crmContacts.id],
    }),
    foreignKey({
      name: "crm_deals_tenant_id_pipeline_id_fkey",
      columns: [table.tenantId, table.pipelineId],
      foreignColumns: [crmPipelines.tenantId, crmPipelines.id],
    }),
    foreignKey({
      name: "crm_deals_tenant_id_pipeline_id_stage_id_fkey",
      columns: [table.tenantId, table.pipelineId, table.stageId],
      foreignColumns: [crmStages.tenantId, crmStages.pipelineId, crmStages.id],
    }),
    textLength("crm_deals_title_length", table.title),
    check("crm_deals_value_range", sql`${table.valueMinor} BETWEEN 0 AND 9007199254740991`),
    check("crm_deals_value_currency", sql`(${table.valueMinor} IS NULL) = (${table.currency} IS NULL)`),
    check("crm_deals_currency_code",
      sql`${table.currency} IN (${sql.join(dealCurrencies.map((code) => sql`${sql.raw(`'${code}'`)}`), sql`, `)})`),
    check("crm_deals_lead_source",
      sql`${table.leadSource} IN (${sql.join(dealLeadSources.map((value) => sql`${sql.raw(`'${value}'`)}`), sql`, `)})`),
    check("crm_deals_revision_range", sql`${table.revision} BETWEEN 1 AND 9007199254740991`),
    index("crm_deals_tenant_contact").on(table.tenantId, table.contactId),
    index("crm_deals_tenant_stage").on(table.tenantId, table.pipelineId, table.stageId),
    index("crm_deals_tenant_recent").on(table.tenantId, table.updatedAt.desc().nullsFirst(), table.id),
    index("crm_deals_tenant_pipeline_recent").on(table.tenantId, table.pipelineId, table.updatedAt.desc().nullsFirst(), table.id),
    index("crm_deals_tenant_won").on(table.tenantId, table.wonAt).where(sql`${table.wonAt} IS NOT NULL`),
    tenantPolicy(table.tenantId),
  ],
).enableRLS();
