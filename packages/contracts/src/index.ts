import { z } from "zod";

export const uuidSchema = z.uuid().toLowerCase();
import { isPostgresText, jsonValueSchema } from "./json.js";
export { jsonValueSchema, type JsonValue } from "./json.js";
export const targetSchema = z.strictObject({
  tenantId: uuidSchema,
  type: z
    .string()
    .min(1)
    .max(100)
    .refine(isPostgresText, "Text is not valid in Postgres"),
  id: uuidSchema,
});
export const approvalReferenceSchema = z.strictObject({
  tenantId: uuidSchema,
  id: uuidSchema,
});
export const actionBindingSchema = z.strictObject({
  tenantId: uuidSchema,
  actorId: uuidSchema,
  actionType: z
    .string()
    .min(1)
    .max(100)
    .refine(isPostgresText, "Text is not valid in Postgres"),
  target: targetSchema,
  payload: jsonValueSchema,
  approvalReference: approvalReferenceSchema,
});
export const actionCommandSchema = actionBindingSchema
  .omit({ tenantId: true, actorId: true })
  .extend({
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .refine(isPostgresText, "Text is not valid in Postgres"),
  });
export type Target = z.infer<typeof targetSchema>;
export type ApprovalReference = z.infer<typeof approvalReferenceSchema>;
export type ActionBinding = z.infer<typeof actionBindingSchema>;
export type ActionCommand = z.infer<typeof actionCommandSchema>;
export const actionResultSchema = z.strictObject({
  actionId: uuidSchema,
  result: jsonValueSchema,
});
export type ActionResult = z.infer<typeof actionResultSchema>;

export type ActionErrorCode = "NotImplemented" | "IdempotencyConflict" | "BindingMismatch" | "TenantDenied" | "Conflict" | "ValidationFailed" | "NotFound";
export class ActionError<Code extends ActionErrorCode = ActionErrorCode> extends Error {
  constructor(
    readonly code: Code,
    message: string,
    readonly details: Readonly<Record<string, import("./json.js").JsonValue>> = {},
  ) {
    super(message);
    this.name = code;
  }
}
export class NotImplemented extends ActionError<"NotImplemented"> {
  constructor(message = "Action type is not registered") {
    super("NotImplemented", message);
  }
}
export class IdempotencyConflict extends ActionError<"IdempotencyConflict"> {
  constructor(message = "Idempotency key was used with another payload") {
    super("IdempotencyConflict", message);
  }
}
export class BindingMismatch extends ActionError<"BindingMismatch"> {
  constructor(message = "Action binding does not match") {
    super("BindingMismatch", message);
  }
}
export class TenantDenied extends ActionError<"TenantDenied"> {
  constructor(message = "Tenant access denied") {
    super("TenantDenied", message);
  }
}
export class Conflict extends ActionError<"Conflict"> {
  constructor(message = "State conflict", details: Readonly<Record<string, import("./json.js").JsonValue>> = {}) {
    super("Conflict", message, details);
  }
}
export class ValidationFailed extends ActionError<"ValidationFailed"> {
  constructor(message = "Invalid action command") {
    super("ValidationFailed", message);
  }
}
/** A tenant-scoped read found nothing; RLS makes another tenant's row look the same. */
export class NotFound extends ActionError<"NotFound"> {
  constructor(message = "Not found") {
    super("NotFound", message);
  }
}
export * from "./approvals.js";
export * from "./booking.js";
export * from "./crm.js";
export * from "./home.js";
export * from "./http.js";
export * from "./instant.js";
export * from "./inbox.js";
export * from "./intake.js";
export * from "./members.js";
export * from "./sites.js";
export * from "./sources.js";
export * from "./delivery.js";
export * from "./agents.js";
export * from "./billing.js";
export * from "./calendar.js";
export * from "./automation.js";
