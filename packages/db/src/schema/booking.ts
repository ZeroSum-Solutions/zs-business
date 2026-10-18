import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { AvailabilityOverride, WeeklyAvailabilityRule } from "@zs/contracts";
import { tenants } from "./index.js";

// Mirrors supabase/migrations/20261017170000_booking.sql. The SQL migration is the
// authority: it also FORCEs RLS, sets grants, installs the JSON validation functions and
// declares bookings_resource_occupied_excl, which Drizzle cannot express.
const authenticated = pgRole("authenticated").existing();
const tenantPolicy = (tenantId: AnyPgColumn) =>
  pgPolicy("tenant_scope", {
    for: "all",
    to: authenticated,
    using: sql`${tenantId} = nullif(current_setting('app.tenant_id', true), '')::uuid`,
    withCheck: sql`${tenantId} = nullif(current_setting('app.tenant_id', true), '')::uuid`,
  });
const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const bookingResources = pgTable(
  "booking_resources",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.tenantId),
    id: uuid("id").notNull(),
    timeZone: text("time_zone").notNull().default("UTC"),
    weekly: jsonb("weekly").$type<WeeklyAvailabilityRule[]>().notNull().default(sql`'[]'::jsonb`),
    overrides: jsonb("overrides").$type<AvailabilityOverride[]>().notNull().default(sql`'[]'::jsonb`),
    slotLengthMinutes: integer("slot_length_minutes").notNull(),
    slotStepMinutes: integer("slot_step_minutes").notNull(),
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull(),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull(),
    minimumNoticeMinutes: integer("minimum_notice_minutes").notNull(),
    bookingHorizonMinutes: integer("booking_horizon_minutes").notNull(),
    name: text("name"),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    check("booking_resources_name_length", sql`${table.name} IS NULL OR char_length(${table.name}) BETWEEN 1 AND 200`),
    check("booking_resources_time_zone_shape",
      sql`${table.timeZone} = 'UTC' OR (length(${table.timeZone}) BETWEEN 3 AND 100 AND position('/' IN ${table.timeZone}) > 0)`),
    check("booking_resources_weekly_valid", sql`public.booking_weekly_valid(${table.weekly})`),
    check("booking_resources_overrides_valid", sql`public.booking_overrides_valid(${table.overrides})`),
    check("booking_resources_slot_length", sql`${table.slotLengthMinutes} BETWEEN 1 AND 1440`),
    check("booking_resources_slot_step", sql`${table.slotStepMinutes} BETWEEN 1 AND 1440`),
    check("booking_resources_buffers",
      sql`${table.bufferBeforeMinutes} BETWEEN 0 AND 1440 AND ${table.bufferAfterMinutes} BETWEEN 0 AND 1440`),
    check("booking_resources_notice", sql`${table.minimumNoticeMinutes} BETWEEN 0 AND 525600`),
    check("booking_resources_horizon", sql`${table.bookingHorizonMinutes} BETWEEN 0 AND 525600`),
    tenantPolicy(table.tenantId),
  ],
).enableRLS();

export const bookings = pgTable(
  "bookings",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.tenantId),
    id: uuid("id").notNull(),
    resourceId: uuid("resource_id").notNull(),
    startsAt: instant("starts_at").notNull(),
    endsAt: instant("ends_at").notNull(),
    occupiedStartsAt: instant("occupied_starts_at").notNull(),
    occupiedEndsAt: instant("occupied_ends_at").notNull(),
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
    status: text("status").$type<"confirmed">().notNull().default("confirmed"),
    createdAt: instant("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId, table.resourceId],
      foreignColumns: [bookingResources.tenantId, bookingResources.id],
    }),
    check("bookings_positive_range", sql`${table.startsAt} < ${table.endsAt}`),
    check("bookings_buffers",
      sql`${table.bufferBeforeMinutes} BETWEEN 0 AND 1440 AND ${table.bufferAfterMinutes} BETWEEN 0 AND 1440`),
    check("bookings_occupied_bounds",
      sql`${table.occupiedStartsAt} = ${table.startsAt} - make_interval(mins => ${table.bufferBeforeMinutes})
        AND ${table.occupiedEndsAt} = ${table.endsAt} + make_interval(mins => ${table.bufferAfterMinutes})`),
    check("bookings_status_confirmed", sql`${table.status} = 'confirmed'`),
    tenantPolicy(table.tenantId),
  ],
).enableRLS();

export const bookingExternalBlocks = pgTable(
  "booking_external_blocks",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.tenantId),
    id: uuid("id").notNull(),
    resourceId: uuid("resource_id").notNull(),
    startsAt: instant("starts_at").notNull(),
    endsAt: instant("ends_at").notNull(),
    source: text("source").notNull(),
    createdAt: instant("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId, table.resourceId],
      foreignColumns: [bookingResources.tenantId, bookingResources.id],
    }),
    check("booking_external_blocks_positive_range", sql`${table.startsAt} < ${table.endsAt}`),
    check("booking_external_blocks_source_nonempty", sql`length(${table.source}) > 0`),
    index("booking_external_blocks_resource_range")
      .using("gist", table.tenantId, table.resourceId, sql`tstzrange(${table.startsAt}, ${table.endsAt}, '[)')`),
    tenantPolicy(table.tenantId),
  ],
).enableRLS();
