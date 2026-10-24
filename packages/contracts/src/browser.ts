import { z } from "zod";
import { actionCommandSchema, actionResultSchema, targetSchema, uuidSchema } from "./index.js";

// Browser tasks (docs/requirements/browser-tasks.md BT-1..BT-13). Root re-exports this module, so
// shared root schemas are reached lazily, as in agents.ts.
const idSchema = z.lazy(() => uuidSchema);
const instantSchema = z.iso.datetime({ precision: 3 });

/** BT-4: the task kinds. A new kind needs a revision of the contract. */
export const BROWSER_TASK_KINDS = ["supplier_invoice_download"] as const;
export const browserTaskKindSchema = z.enum(BROWSER_TASK_KINDS);
export type BrowserTaskKind = z.infer<typeof browserTaskKindSchema>;

export const BROWSER_RUN_STATUSES = ["queued", "running", "completed", "stopped"] as const;
export const browserRunStatusSchema = z.enum(BROWSER_RUN_STATUSES);
export type BrowserRunStatus = z.infer<typeof browserRunStatusSchema>;

/**
 * BT-3, BT-5, BT-9, BT-10, BT-12: why a run ended `stopped`. `killed` covers the tenant's switch and
 * the global one (agents.md G-3); `disabled` is a tenant, target or attestation that is off.
 */
export const BROWSER_STOP_REASONS = [
  "origin_denied", "write_refused", "needs_vision", "needs_owner", "killed", "disabled", "step_cap", "deadline",
  "cost_cap", "stalled", "insufficient_funds", "model_error", "runner_error",
] as const;
export const browserStopReasonSchema = z.enum(BROWSER_STOP_REASONS);
export type BrowserStopReason = z.infer<typeof browserStopReasonSchema>;

/** BT-5: the fixed list of steps a read-only task may take. `stop` records where a run ended. */
export const BROWSER_ACTIONS = ["sign_in", "open", "click_link", "set_date_filter", "download", "stop"] as const;
export const browserActionSchema = z.enum(BROWSER_ACTIONS);
export type BrowserAction = z.infer<typeof browserActionSchema>;

export const BROWSER_LIMITS = Object.freeze({
  maxOrigins: 5,
  maxPaths: 10,
  maxStepsDefault: 25,
  maxStepsMax: 100,
  deadlineMsDefault: 600_000,
  deadlineMsMax: 3_600_000,
  maxRunsPerDayDefault: 5,
  maxCostMicrosPerDayDefault: 5_000_000,
  maxCostMicrosPerRunDefault: 500_000,
  /** BT-13 */
  maxPdfBytes: 20 * 1024 * 1024,
  maxPdfsPerRun: 50,
  maxScreenshotBytes: 5 * 1024 * 1024,
});

/** BT-3: an exact origin. https, or http on a loopback host (core refuses that unless the fixture is on). */
export const browserOriginSchema = z.string().max(200).regex(
  /^(https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?|http:\/\/(localhost|127\.0\.0\.1|\[::1\]))(:[0-9]{1,5})?$/,
  "Must be an exact origin such as https://portal.example, with no path or wildcard",
);
/** BT-5: a path prefix, no query, fragment, dot segment or encoded separator. */
export const browserPathSchema = z.string().min(1).max(200)
  .regex(/^\/[A-Za-z0-9._~\-/]*$/, "Must be a path prefix starting with /")
  .refine((value) => !value.split("/").some((part) => part === "." || part === ".."), "No dot segments");

/** BT-3: the owner's attestation, required to enable a target. */
export const browserAttestationSchema = z.strictObject({
  termsAllowAutomatedAccess: z.literal(true),
  notInsurerOrPayerPortal: z.literal(true),
});

const secretRefSchema = z.string().min(1).max(300).regex(/^[A-Za-z0-9_./-]+$/, "Not a secret reference");

export const saveBrowserTargetRequestSchema = z.strictObject({
  /** The target to change; omit to create one (its ID derives from the idempotency key). */
  targetId: idSchema.optional(),
  expectedRevision: z.number().int().min(0).max(1_000_000),
  name: z.string().trim().min(1).max(120),
  taskKind: browserTaskKindSchema,
  allowedOrigins: z.array(browserOriginSchema).min(1).max(BROWSER_LIMITS.maxOrigins),
  allowedPaths: z.array(browserPathSchema).min(1).max(BROWSER_LIMITS.maxPaths),
  assetPaths: z.array(browserPathSchema).max(BROWSER_LIMITS.maxPaths).default([]),
  signInPath: browserPathSchema,
  enabled: z.boolean(),
  /** BT-8: names a Vault secret `browser/<tenantId>/...`; never the secret itself. */
  secretRef: secretRefSchema.nullable().optional(),
  attestation: browserAttestationSchema.optional(),
}).refine((value) => !value.enabled || value.attestation !== undefined, "Enabling a target needs the attestation")
  .refine((value) => new Set(value.allowedOrigins).size === value.allowedOrigins.length, "Origins must be distinct");
export type SaveBrowserTargetRequest = z.infer<typeof saveBrowserTargetRequestSchema>;

export const updateBrowserSettingsRequestSchema = z.strictObject({
  expectedRevision: z.number().int().min(0).max(1_000_000),
  enabled: z.boolean(),
  maxRunsPerDay: z.number().int().min(1).max(100),
  maxCostMicrosPerDay: z.number().int().min(0).max(100_000_000),
});
export type UpdateBrowserSettingsRequest = z.infer<typeof updateBrowserSettingsRequestSchema>;
export const killBrowserRequestSchema = z.strictObject({ note: z.string().trim().min(1).max(500).optional() });
export const resumeBrowserRequestSchema = z.strictObject({});

export const monthSchema = z.string().regex(/^20[0-9]{2}-(0[1-9]|1[0-2])$/, "Month as YYYY-MM");
export const requestBrowserRunRequestSchema = z.strictObject({
  targetId: idSchema,
  month: monthSchema,
  maxSteps: z.number().int().min(1).max(BROWSER_LIMITS.maxStepsMax).default(BROWSER_LIMITS.maxStepsDefault),
  deadlineMs: z.number().int().min(1000).max(BROWSER_LIMITS.deadlineMsMax).default(BROWSER_LIMITS.deadlineMsDefault),
  maxCostMicros: z.number().int().min(0).max(100_000_000).default(BROWSER_LIMITS.maxCostMicrosPerRunDefault),
});
export type RequestBrowserRunRequest = z.infer<typeof requestBrowserRunRequestSchema>;

export const browserTargetSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  taskKind: browserTaskKindSchema,
  allowedOrigins: z.array(z.string()),
  allowedPaths: z.array(z.string()),
  assetPaths: z.array(z.string()),
  signInPath: z.string().nullable(),
  enabled: z.boolean(),
  attestedBy: idSchema.nullable(),
  attestedAt: instantSchema.nullable(),
  revision: z.number().int(),
  updatedAt: instantSchema,
  hasCredentials: z.boolean(),
});
export type BrowserTarget = z.infer<typeof browserTargetSchema>;

export const browserRunSchema = z.strictObject({
  id: idSchema,
  targetId: idSchema,
  taskKind: browserTaskKindSchema,
  status: browserRunStatusSchema,
  stopReason: browserStopReasonSchema.nullable(),
  requestedBy: idSchema,
  requestedAt: instantSchema,
  startedAt: instantSchema.nullable(),
  finishedAt: instantSchema.nullable(),
  month: monthSchema,
  maxSteps: z.number().int(),
  deadlineMs: z.number().int(),
  maxCostMicros: z.number().int(),
  steps: z.number().int(),
  costMicros: z.number().int(),
  attempt: z.number().int(),
  artifactCount: z.number().int(),
});
export type BrowserRun = z.infer<typeof browserRunSchema>;

export const browserRunEventSchema = z.strictObject({
  seq: z.number().int(),
  origin: z.string().nullable(),
  path: z.string().nullable(),
  action: browserActionSchema,
  screenshotRef: idSchema.nullable(),
  model: z.string().nullable(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costMicros: z.number().int(),
  createdAt: instantSchema,
});
export type BrowserRunEvent = z.infer<typeof browserRunEventSchema>;

export const browserArtifactSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(["invoice_pdf", "screenshot"]),
  name: z.string(),
  bytes: z.number().int(),
  sha256: z.string(),
  createdAt: instantSchema,
});
export type BrowserArtifact = z.infer<typeof browserArtifactSchema>;

export const browserRunDetailSchema = z.strictObject({
  run: browserRunSchema,
  events: z.array(browserRunEventSchema),
  artifacts: z.array(browserArtifactSchema),
});
export type BrowserRunDetail = z.infer<typeof browserRunDetailSchema>;
export const browserRunListSchema = z.strictObject({ items: z.array(browserRunSchema) });
export type BrowserRunList = z.infer<typeof browserRunListSchema>;

export const browserStatusSchema = z.strictObject({
  settings: z.strictObject({
    enabled: z.boolean(), maxRunsPerDay: z.number().int(), maxCostMicrosPerDay: z.number().int(),
  }),
  revision: z.number().int(),
  updatedAt: instantSchema.nullable(),
  killed: z.strictObject({ at: instantSchema, by: idSchema, note: z.string().nullable() }).nullable(),
  globalKilled: z.boolean(),
  /** The first reason a run cannot start now, or null. */
  blockedBy: z.enum(["global_killed", "disabled", "tenant_killed", "daily_cap", "cost_cap"]).nullable(),
  runsToday: z.number().int(),
  costTodayMicros: z.number().int(),
  targets: z.array(browserTargetSchema),
});
export type BrowserStatus = z.infer<typeof browserStatusSchema>;

// Action commands. The edge mints every ID from the idempotency key.
const tenantTarget = (command: { target: { id: string; tenantId: string } }) => command.target.id === command.target.tenantId;
export const saveBrowserTargetCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("browser.target.save"),
  target: targetSchema.extend({ type: z.literal("browser_target") }),
  payload: saveBrowserTargetRequestSchema,
}));
export const updateBrowserSettingsCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("browser.settings.update"),
  target: targetSchema.extend({ type: z.literal("browser_settings") }),
  payload: updateBrowserSettingsRequestSchema,
}).refine(tenantTarget, "Target must be the tenant's browser settings"));
export const killBrowserCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("browser.kill"),
  target: targetSchema.extend({ type: z.literal("browser_settings") }),
  payload: killBrowserRequestSchema,
}).refine(tenantTarget, "Target must be the tenant's browser settings"));
export const resumeBrowserCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("browser.resume"),
  target: targetSchema.extend({ type: z.literal("browser_settings") }),
  payload: resumeBrowserRequestSchema,
}).refine(tenantTarget, "Target must be the tenant's browser settings"));
export const requestBrowserRunCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("browser.run.request"),
  target: targetSchema.extend({ type: z.literal("browser_run") }),
  payload: requestBrowserRunRequestSchema,
}));
export const browserStatusOutputSchema = z.lazy(() => actionResultSchema.extend({ result: browserStatusSchema }));
export const browserTargetOutputSchema = z.lazy(() => actionResultSchema.extend({ result: browserTargetSchema }));
export const browserRunOutputSchema = z.lazy(() => actionResultSchema.extend({ result: browserRunSchema }));
export type BrowserStatusOutput = z.infer<typeof browserStatusOutputSchema>;
export type BrowserTargetOutput = z.infer<typeof browserTargetOutputSchema>;
export type BrowserRunOutput = z.infer<typeof browserRunOutputSchema>;

// The runner's job interface (BT-2, BT-7): claim, control, events, artifacts, finish.
export const browserClaimSchema = z.strictObject({
  runId: idSchema,
  /** Server-derived; the runner builds its profile path from these two and nothing in a payload. */
  tenantId: idSchema,
  targetId: idSchema,
  taskKind: browserTaskKindSchema,
  month: monthSchema,
  attempt: z.number().int(),
  leaseToken: z.string().min(16).max(200),
  leaseUntil: instantSchema,
  maxSteps: z.number().int(),
  stepsDone: z.number().int(),
  deadlineAt: instantSchema,
  target: z.strictObject({
    allowedOrigins: z.array(z.string()),
    allowedPaths: z.array(z.string()),
    assetPaths: z.array(z.string()),
    signInPath: z.string(),
  }),
  /** BT-8: values for this target only, held in memory for this run. */
  credentials: z.strictObject({ username: z.string(), password: z.string() }).nullable(),
});
export type BrowserClaim = z.infer<typeof browserClaimSchema>;
export const browserClaimResponseSchema = z.strictObject({ claim: browserClaimSchema.nullable() });

export const browserEventInputSchema = z.strictObject({
  action: browserActionSchema,
  /** The URL the step touched; the server keeps only its origin and path (BT-9). */
  url: z.string().max(2000).optional(),
  screenshotRef: idSchema.optional(),
  usage: z.strictObject({
    lane: z.enum(["personal_data", "no_personal_data"]),
    model: z.string().min(1).max(200),
    inputTokens: z.number().int().min(0).max(10_000_000),
    outputTokens: z.number().int().min(0).max(10_000_000),
  }).optional(),
});
export type BrowserEventInput = z.infer<typeof browserEventInputSchema>;
export const browserFinishInputSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("read_done") }),
  z.strictObject({ outcome: z.literal("stopped"), reason: browserStopReasonSchema }),
]);
export type BrowserFinishInput = z.infer<typeof browserFinishInputSchema>;
