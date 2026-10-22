// source.observe (approvals.md F-4, F-5): record that a source vouched for a subject at a
// time, keeping only the newest observation per subject and source.
import { Conflict, TenantDenied, ValidationFailed, observeSourceCommandSchema, supportedInstantSchema } from "@zs/contracts";
import type { ActionHandler } from "../actions/dispatch.js";
import { clockInstant, idInUse, parseOrFail, pgCode, pgConstraint, tenantVisible } from "../crm/rows.js";
import { requireMember } from "../members/access.js";
import { SOURCE_SUBJECTS, sourceColumns, sourceRecord, subjectExists, type SourceRow } from "./records.js";

export const observeSourceHandler: ActionHandler = {
  async resolveTarget(tx, target) {
    if (target.type !== "source_record") throw new ValidationFailed("source.observe requires a source_record target");
    // A new record's ID is expected to be unused; an existing one is checked against the
    // payload's subject and source in handle, under the record lock.
    return (await tenantVisible(tx, target.tenantId)) ? { tenantId: target.tenantId, type: "source_record", id: target.id } : null;
  },
  async handle({ tx, command, binding, now }) {
    const recordedAt = clockInstant(now);
    const { payload } = parseOrFail(observeSourceCommandSchema, command);
    const tenantId = binding.tenantId;
    await requireMember(tx, tenantId, binding.actorId, SOURCE_SUBJECTS[payload.subject.type].permission);
    if (!(await subjectExists(tx, tenantId, payload.subject))) throw new TenantDenied("Subject is not owned by this tenant");
    // Instants are bound as ISO strings: the driver writes a Date at whole-minute offset
    // precision, which moves a year-0001 instant by its local mean time seconds.
    const observedAt = payload.observedAt ?? recordedAt;
    const observedMs = Date.parse(observedAt);
    if (observedMs > now.getTime()) throw new ValidationFailed("observedAt is later than the server clock");
    const freshUntil = payload.freshForMinutes === undefined ? null
      : new Date(observedMs + payload.freshForMinutes * 60_000).toISOString();
    // A derived instant must fit the supported years too; past 9999 Postgres fails the write.
    if (freshUntil !== null && !supportedInstantSchema.safeParse(freshUntil).success)
      throw new ValidationFailed("freshUntil is later than 9999-12-31T23:59:59.999Z");

    // One record per subject and source: serialize its first insert and every later change.
    await tx.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
      [`source-record:${tenantId}:${payload.subject.type}:${payload.subject.id}:${payload.source}`]);
    const stored = (await tx.query<SourceRow>(
      `SELECT ${sourceColumns} FROM source_records
        WHERE tenant_id=$1 AND subject_type=$2::source_subject_type AND subject_id=$3 AND source=$4 FOR UPDATE`,
      [tenantId, payload.subject.type, payload.subject.id, payload.source],
    )).rows[0];
    let row: SourceRow;
    let applied: boolean;
    if (!stored) {
      row = (await tx.query<SourceRow>(
        `INSERT INTO source_records (tenant_id,id,subject_type,subject_id,source,source_ref,observed_at,fresh_until,revision,
           recorded_by,recorded_at,updated_at)
         VALUES ($1,$2,$3::source_subject_type,$4,$5,$6,$7,$8,1,$9,$10,$10) RETURNING ${sourceColumns}`,
        [tenantId, payload.sourceRecordId, payload.subject.type, payload.subject.id, payload.source,
          payload.sourceRef ?? null, observedAt, freshUntil, binding.actorId, recordedAt],
      )).rows[0]!;
      applied = true;
    } else if (stored.id !== payload.sourceRecordId) {
      throw idInUse("source record");
    } else if (observedMs <= stored.observed_at.getTime()) {
      // F-5: a late or out-of-order observation never moves the record back.
      row = stored;
      applied = false;
    } else {
      // `now` was read before the lock, so an observation that sampled the clock earlier can
      // land after a later insert (or a worker's clock can lag): never set updated_at before
      // recorded_at. observedAt <= now keeps observed_at <= updated_at.
      row = (await tx.query<SourceRow>(
        `UPDATE source_records SET source_ref=$3, observed_at=$4, fresh_until=$5, revision=revision+1,
                 updated_at=GREATEST($6, recorded_at)
          WHERE tenant_id=$1 AND id=$2 RETURNING ${sourceColumns}`,
        [tenantId, stored.id, payload.sourceRef ?? null, observedAt, freshUntil, recordedAt],
      )).rows[0]!;
      applied = true;
    }
    const record = sourceRecord(row, now);
    return {
      result: { record, applied },
      event: { type: "source.observed", payload: { sourceRecordId: record.id, subject: record.subject, source: record.source, applied } },
    };
  },
  mapError(error) {
    if (pgCode(error) === "23505" && pgConstraint(error) === "source_records_pkey") return idInUse("source record");
    if (pgCode(error) === "23505") return new Conflict("The source record changed concurrently", { reason: "concurrent_update" });
    return undefined;
  },
};

export const sourceHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  "source.observe": observeSourceHandler,
});
