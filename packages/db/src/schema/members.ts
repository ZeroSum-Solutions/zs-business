import { sql } from "drizzle-orm";
import { check, foreignKey, pgEnum, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenants } from "./index.js";
import { tenantPolicy } from "./tenant-policy.js";

// Mirrors supabase/migrations/*_members_and_sessions.sql. SQL also FORCEs RLS and sets column grants.
const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const memberRole = pgEnum("member_role", ["owner", "staff"]);

export const tenantMembers = pgTable(
  "tenant_members",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull(),
    email: text("email").notNull(),
    /** NULL while the invite is pending; only the service role binds it. */
    userId: uuid("user_id"),
    role: memberRole("role").notNull(),
    invitedBy: uuid("invited_by"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({ name: "tenant_members_tenant_id_fkey", columns: [table.tenantId], foreignColumns: [tenants.tenantId] }),
    check("tenant_members_email_canonical",
      sql`char_length(${table.email}) BETWEEN 3 AND 254 AND ${table.email} = lower(${table.email})`),
    unique("tenant_members_tenant_email").on(table.tenantId, table.email),
    uniqueIndex("tenant_members_tenant_user").on(table.tenantId, table.userId).where(sql`${table.userId} IS NOT NULL`),
    tenantPolicy(table.tenantId),
  ],
).enableRLS();
