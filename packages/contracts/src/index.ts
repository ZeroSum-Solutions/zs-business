import { z } from "zod";

export const uuidSchema = z.uuid().toLowerCase();
export const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;
export const targetSchema = z.strictObject({
  tenantId: uuidSchema,
  type: z.string().min(1).max(100),
  id: uuidSchema,
});
export const approvalReferenceSchema = z.strictObject({
  tenantId: uuidSchema,
  id: uuidSchema,
});
export const actionBindingSchema = z.strictObject({
  tenantId: uuidSchema,
  actorId: uuidSchema,
  actionType: z.string().min(1).max(100),
  target: targetSchema,
  payload: jsonValueSchema,
  approvalReference: approvalReferenceSchema.nullable(),
});
export const actionCommandSchema = actionBindingSchema
  .omit({ tenantId: true, actorId: true })
  .extend({
    idempotencyKey: z.string().min(1).max(200),
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

class ActionError<Code extends string> extends Error {
  constructor(
    readonly code: Code,
    message: string,
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
  constructor(message = "State conflict") {
    super("Conflict", message);
  }
}
export class ValidationFailed extends ActionError<"ValidationFailed"> {
  constructor(message = "Invalid action command") {
    super("ValidationFailed", message);
  }
}
