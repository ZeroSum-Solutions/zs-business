import { z } from "zod";
import { actionCommandSchema, actionResultSchema, targetSchema, uuidSchema } from "./index.js";
import { storedInstantSchema, supportedInstantSchema } from "./instant.js";
import { isPostgresText } from "./json.js";

// M3b source record (docs/requirements/approvals.md F-1..F-8): where a fact came from and
// until when it counts as fresh. Root re-exports this module; shared schemas are lazy.
const idSchema = z.lazy(() => uuidSchema);
// Strict on input, tolerant on output: records and replays return what was stored.
const instantSchema = storedInstantSchema;

/** F-2: what a source record may describe. */
export const sourceSubjectTypeSchema = z.enum(["contact", "deal", "booking", "booking_resource", "intake_item", "catalog_item", "knowledge_entry"]);
export type SourceSubjectType = z.infer<typeof sourceSubjectTypeSchema>;
export const sourceSubjectSchema = z.strictObject({ type: sourceSubjectTypeSchema, id: idSchema });
export type SourceSubject = z.infer<typeof sourceSubjectSchema>;

/** F-3: a short lowercase name, for example `website` or `google_calendar`. */
export const sourceNameSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,62}$/, "Not a source name");
const sourceRefSchema = z.string().min(1).max(500).refine(isPostgresText, "Text is not valid in Postgres");
/** F-4: one minute to one year. */
export const SOURCE_MAX_FRESH_MINUTES = 525_600;
const freshForMinutesSchema = z.number().int().min(1).max(SOURCE_MAX_FRESH_MINUTES);

export const observeSourceInputSchema = z.strictObject({
  sourceRecordId: idSchema,
  subject: sourceSubjectSchema,
  source: sourceNameSchema,
  sourceRef: sourceRefSchema.optional(),
  observedAt: supportedInstantSchema.optional(),
  freshForMinutes: freshForMinutesSchema.optional(),
});
export const observeSourceCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("source.observe"),
  target: targetSchema.extend({ type: z.literal("source_record") }),
  payload: observeSourceInputSchema,
}).refine((command) => command.target.id === command.payload.sourceRecordId, "Target must equal the source record ID"));
export type ObserveSourceCommand = z.infer<typeof observeSourceCommandSchema>;

export const sourceRecordSchema = z.strictObject({
  id: idSchema,
  tenantId: idSchema,
  subject: sourceSubjectSchema,
  source: z.string(),
  sourceRef: z.string().nullable(),
  observedAt: instantSchema,
  freshUntil: instantSchema.nullable(),
  /** F-6, against the injected clock when the record was read. */
  fresh: z.boolean(),
  revision: z.number().int().min(1),
  recordedBy: idSchema,
  recordedAt: instantSchema,
  updatedAt: instantSchema,
});
export type SourceRecord = z.infer<typeof sourceRecordSchema>;
/** F-5: `applied` is false when the observation was not newer than the stored one. */
export const observeSourceOutputSchema = z.lazy(() => actionResultSchema.extend({
  result: z.strictObject({ record: sourceRecordSchema, applied: z.boolean() }),
}));
export type ObserveSourceOutput = z.infer<typeof observeSourceOutputSchema>;

/** HTTP and MCP body; the edge derives sourceRecordId from subject and source. */
export const observeSourceRequestSchema = observeSourceInputSchema.omit({ sourceRecordId: true });
export type ObserveSourceRequest = z.infer<typeof observeSourceRequestSchema>;
export const listSourcesQuerySchema = z.strictObject({ subjectType: sourceSubjectTypeSchema, subjectId: idSchema });
export type ListSourcesQuery = z.infer<typeof listSourcesQuerySchema>;
export const sourceListSchema = z.strictObject({ items: z.array(sourceRecordSchema) });
export type SourceList = z.infer<typeof sourceListSchema>;
