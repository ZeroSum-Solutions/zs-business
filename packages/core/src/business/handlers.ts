// Business profile (docs/requirements/business-profile.md): the read (BP-5) and the one write
// (BP-6, BP-7) through the shared dispatcher. The display name keeps tenants.name in step in the
// same transaction (BP-9) through a trigger, so an older reader sees the same name.
import {
  BUSINESS_PROFILE_TARGET,
  Conflict,
  NotFound,
  updateBusinessProfileCommandSchema,
  ValidationFailed,
  type BusinessProfile,
  type BusinessProfileChanges,
  type JsonValue,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { validationError } from "../edge/errors.js";
import { clockInstant, iso, parseOrFail, tenantVisible } from "../crm/rows.js";
import { requireMember } from "../members/access.js";

export const UPDATE_BUSINESS_ACTION = "business.profile.update";

interface ProfileRow {
  display_name: string;
  legal_name: string | null;
  phone_e164: string | null;
  time_zone: string | null;
  currency: string;
  postal_address: BusinessProfile["postalAddress"];
  revision: number;
  updated_at: Date;
}
const columns = "display_name,legal_name,phone_e164,time_zone,currency,postal_address,revision,updated_at";

function profileRecord(row: ProfileRow): BusinessProfile {
  return {
    displayName: row.display_name, legalName: row.legal_name, phoneE164: row.phone_e164, timeZone: row.time_zone,
    currency: row.currency, postalAddress: row.postal_address, revision: row.revision, updatedAt: iso(row.updated_at),
  };
}

/** BP-5: the tenant's profile; the tenant_id filter backs the row-level policy. */
export async function getBusinessProfile(tx: Transaction, tenantId: string): Promise<BusinessProfile> {
  const row = (await tx.query<ProfileRow>(`SELECT ${columns} FROM business_profiles WHERE tenant_id=$1`, [tenantId])).rows[0];
  if (!row) throw new NotFound();
  return profileRecord(row);
}

/** The profile is the tenant's own: one per tenant, addressed by the tenant ID. */
async function resolveProfile(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== BUSINESS_PROFILE_TARGET) throw new ValidationFailed("Business profile actions require a business_profile target");
  if (target.id !== target.tenantId || !(await tenantVisible(tx, target.tenantId))) return null;
  return { tenantId: target.tenantId, type: BUSINESS_PROFILE_TARGET, id: target.id };
}

/** Each editable field and the column it writes; jsonb values are bound as text and cast. */
const FIELDS: readonly { key: keyof BusinessProfileChanges; column: string; cast: string }[] = [
  { key: "displayName", column: "display_name", cast: "" },
  { key: "legalName", column: "legal_name", cast: "" },
  { key: "phoneE164", column: "phone_e164", cast: "" },
  { key: "timeZone", column: "time_zone", cast: "" },
  { key: "currency", column: "currency", cast: "" },
  { key: "postalAddress", column: "postal_address", cast: "::jsonb" },
];

export const updateBusinessHandler: ActionHandler = {
  resolveTarget: resolveProfile,
  async handle({ tx, command, binding, now }) {
    await requireMember(tx, binding.tenantId, binding.actorId, "business");
    const { payload } = parseOrFail(updateBusinessProfileCommandSchema, command);
    const at = clockInstant(now);
    const current = (await tx.query<ProfileRow>(
      `SELECT ${columns} FROM business_profiles WHERE tenant_id=$1 FOR UPDATE`, [binding.tenantId],
    )).rows[0];
    if (!current) throw new NotFound();
    if (current.revision !== payload.expectedRevision)
      throw new Conflict("The business profile changed", { reason: "stale_revision", currentRevision: current.revision });

    const { timeZone } = payload.changes;
    // BP-3: the trigger refuses an unknown zone too; asking first gives the field's path.
    if (typeof timeZone === "string" && !(await zoneKnown(tx, timeZone)))
      throw validationError("Unknown time zone", [{ path: ["changes", "timeZone"], message: "Expected UTC or an IANA time zone name" }]);

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const { key, column, cast } of FIELDS) {
      if (!(key in payload.changes)) continue;
      const value = payload.changes[key];
      values.push(value !== null && typeof value === "object" ? JSON.stringify(value) : value ?? null);
      sets.push(`${column}=$${values.length}${cast}`);
    }
    values.push(binding.actorId, at, binding.tenantId);
    const updated = await tx.query<ProfileRow>(
      `UPDATE business_profiles SET ${sets.join(", ")}, updated_by=$${values.length - 2}, updated_at=$${values.length - 1}, revision=revision+1
        WHERE tenant_id=$${values.length} RETURNING ${columns}`,
      values,
    );
    // The record is plain JSON (jsonb comes back as parsed JSON), but its type allows absent keys.
    return { result: JSON.parse(JSON.stringify(profileRecord(updated.rows[0]!))) as JsonValue };
  },
};

async function zoneKnown(tx: Transaction, name: string): Promise<boolean> {
  return (await tx.query("SELECT 1 FROM pg_catalog.pg_timezone_names WHERE lower(name) = lower($1)", [name])).rowCount === 1;
}

export const businessHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [UPDATE_BUSINESS_ACTION]: updateBusinessHandler,
});
