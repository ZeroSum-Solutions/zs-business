// Business profile (docs/requirements/business-profile.md): the read (BP-5) and the one write
// (BP-6, BP-7, BP-13, BP-14) through the shared dispatcher. The display name keeps tenants.name in
// step in the same transaction (BP-9) through a trigger, so an older reader sees the same name.
import {
  BUSINESS_PROFILE_TARGET,
  Conflict,
  NotFound,
  updateBusinessProfileCommandSchema,
  ValidationFailed,
  MARKED_FACTS,
  type BusinessPolicy,
  type BusinessProfile,
  type BusinessProfileChanges,
  type FactMark,
  type FactMarks,
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
  description: string | null;
  services: string[];
  hours: BusinessProfile["hours"];
  tone: string | null;
  policies: BusinessPolicy[];
  fact_marks: FactMarks;
  revision: number;
  updated_at: Date;
}
const columns = "display_name,legal_name,phone_e164,time_zone,currency,postal_address,description,services,hours,tone,policies,fact_marks,revision,updated_at";

function profileRecord(row: ProfileRow): BusinessProfile {
  return {
    displayName: row.display_name, legalName: row.legal_name, phoneE164: row.phone_e164, timeZone: row.time_zone,
    currency: row.currency, postalAddress: row.postal_address,
    description: row.description, services: row.services,
    hours: row.hours, tone: row.tone, policies: row.policies, factMarks: row.fact_marks,
    revision: row.revision, updatedAt: iso(row.updated_at),
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
  { key: "description", column: "description", cast: "" },
  { key: "services", column: "services", cast: "::jsonb" },
  { key: "hours", column: "hours", cast: "::jsonb" },
  { key: "tone", column: "tone", cast: "" },
  { key: "policies", column: "policies", cast: "::jsonb" },
];

/** A fact value that reads as "not known" (BP-20) carries no mark. */
const unset = (value: unknown) => value === null || value === undefined || (Array.isArray(value) && value.length === 0);
// jsonb returns object keys in its own order, so values compare with their keys sorted.
const canonical = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
      : value ?? null;
const sameValue = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * BP-19: the marks after a save. A fact the save changes is marked with the saving owner, the instant and
 * the new revision; one it clears loses its mark; one it leaves alone keeps the mark it had.
 */
function nextMarks(current: ProfileRow, changes: BusinessProfileChanges, mark: FactMark): FactMarks {
  const marks = { ...current.fact_marks } as Record<string, FactMark>;
  const before: Record<(typeof MARKED_FACTS)[number], unknown> = {
    displayName: current.display_name, description: current.description, services: current.services,
    timeZone: current.time_zone, hours: current.hours, tone: current.tone,
  };
  for (const key of MARKED_FACTS) {
    if (!(key in changes)) continue;
    const value = changes[key];
    if (unset(value)) delete marks[key];
    else if (!sameValue(value, before[key])) marks[key] = mark;
  }
  return marks as FactMarks;
}

/** BP-18: the stored list after a save. A policy whose title and text are unchanged keeps its mark. */
function nextPolicies(current: BusinessPolicy[], next: readonly { title: string; text: string }[], mark: FactMark): BusinessPolicy[] {
  return next.map(({ title, text }) =>
    current.find((policy) => policy.title === title && policy.text === text) ?? { title, text, ...mark });
}

export const updateBusinessHandler: ActionHandler = {
  resolveTarget: resolveProfile,
  // BP-13, BP-14, BP-21: a save stored before these fields existed replays with them empty, not as an invalid result.
  async upgradeStoredResult(_tx, result) {
    return result !== null && typeof result === "object" && !Array.isArray(result)
      ? { description: null, services: [], hours: null, tone: null, policies: [], factMarks: {}, ...result }
      : result;
  },
  async handle({ tx, command, binding, now }) {
    const access = await requireMember(tx, binding.tenantId, binding.actorId, "business");
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

    // BP-19, BP-20: only an owner reaches here (the `business` permission); the marks name that owner.
    const mark: FactMark = { setBy: access.memberId, setAt: at, revision: current.revision + 1 };
    const stored: Record<string, unknown> = { ...payload.changes };
    if (payload.changes.policies) stored.policies = nextPolicies(current.policies, payload.changes.policies, mark);

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const { key, column, cast } of FIELDS) {
      if (!(key in stored)) continue;
      const value = stored[key];
      values.push(value !== null && typeof value === "object" ? JSON.stringify(value) : value ?? null);
      sets.push(`${column}=$${values.length}${cast}`);
    }
    values.push(JSON.stringify(nextMarks(current, payload.changes, mark)));
    sets.push(`fact_marks=$${values.length}::jsonb`);
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
