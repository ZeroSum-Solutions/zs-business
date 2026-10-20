import {
  Conflict,
  ValidationFailed,
  type ConsentEvidence,
  type ContactRecord,
  type DealRecord,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";

/** Feature handlers map schema failures to ValidationFailed (C-4). */
interface SafeParser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { message: string } };
}
export function parseOrFail<T>(schema: SafeParser<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationFailed(parsed.error.message);
  return parsed.data;
}

export function idInUse(type: "contact" | "deal" | "member" | "approval" | "source record" | "reply"): Conflict {
  return new Conflict(`The ${type} ID is already in use`, { reason: "id_in_use" });
}

export function pgCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

export function pgConstraint(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "constraint" in error && typeof error.constraint === "string"
    ? error.constraint
    : undefined;
}

/** The creation scope is the tenant itself; RLS hides every other tenant's row. */
export async function tenantVisible(tx: Transaction, tenantId: string): Promise<boolean> {
  return (await tx.query("SELECT 1 FROM tenants WHERE tenant_id=$1", [tenantId])).rowCount === 1;
}

export function requireType(target: Target, type: "contact" | "deal"): boolean {
  return target.type === type;
}

export const iso = (value: Date): string => value.toISOString();

export interface ContactRow {
  id: string;
  tenant_id: string;
  display_name: string | null;
  normalized_email: string | null;
  e164_phone: string | null;
  created_at: Date;
  updated_at: Date;
}
export const contactColumns = "id,tenant_id,display_name,normalized_email,e164_phone,created_at,updated_at";

export interface ConsentRow {
  channel: "email" | "sms";
  status: "granted" | "denied";
  source: string;
  recorded_at: Date;
  /** Microseconds since the epoch, so stored sub-millisecond precision still compares exactly. */
  recorded_us: string;
}

export async function loadConsent(tx: Transaction, tenantId: string, contactId: string): Promise<Map<string, ConsentRow>> {
  const rows = (await tx.query<ConsentRow>(
    `SELECT channel::text AS channel, status::text AS status, source, recorded_at,
       ((extract(epoch FROM recorded_at) * 1000000)::numeric(30,0))::text AS recorded_us
     FROM crm_contact_consent WHERE tenant_id=$1 AND contact_id=$2`,
    [tenantId, contactId],
  )).rows;
  return new Map(rows.map((row) => [row.channel, row]));
}

const evidence = (row: ConsentRow | undefined): ConsentEvidence | null =>
  row ? { status: row.status, source: row.source, recordedAt: iso(row.recorded_at) } : null;

export function contactRecord(row: ContactRow, consent: Map<string, ConsentRow>): ContactRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    displayName: row.display_name,
    email: row.normalized_email,
    phone: row.e164_phone,
    consent: { email: evidence(consent.get("email")), sms: evidence(consent.get("sms")) },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface DealRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  pipeline_id: string;
  stage_id: string;
  title: string;
  /** node-pg returns bigint as text; the CHECK keeps it within the safe-integer range. */
  revision: string;
  created_at: Date;
  updated_at: Date;
}
export const dealColumns = "id,tenant_id,contact_id,pipeline_id,stage_id,title,revision::text AS revision,created_at,updated_at";

export function dealRecord(row: DealRow): DealRecord {
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision)) throw new ValidationFailed("Deal revision is outside the safe range");
  return {
    id: row.id,
    tenantId: row.tenant_id,
    contactId: row.contact_id,
    pipelineId: row.pipeline_id,
    stageId: row.stage_id,
    title: row.title,
    revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
