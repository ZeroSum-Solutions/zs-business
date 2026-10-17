import { randomUUID } from "node:crypto";
import {
  actionBindingSchema,
  actionCommandSchema,
  targetSchema,
  uuidSchema,
  BindingMismatch,
  Conflict,
  IdempotencyConflict,
  jsonValueSchema,
  NotImplemented,
  TenantDenied,
  ValidationFailed,
  type ActionBinding,
  type ActionCommand,
  type ActionResult,
  type ApprovalReference,
  type JsonValue,
  type Target,
} from "@zs/contracts";
import type { ScopedDatabase, Transaction } from "@zs/db";

export interface DispatchConfig {
  readonly outboxEventType: string;
}
export interface DispatchContext {
  readonly tenantId: string;
  readonly actor: { readonly id: string; readonly tenantId: string };
  readonly db: ScopedDatabase;
  readonly clock: { now(): Date };
  readonly config: DispatchConfig;
  /** Trusted server resolver: load the approved binding; may lock/consume in this transaction. */
  readonly resolveApproval: (
    tx: Transaction,
    reference: ApprovalReference,
  ) => Promise<ActionBinding | null>;
}
export interface ActionHandler {
  /** Resolve ownership from authoritative state using the same tenant transaction. */
  resolveTarget(tx: Transaction, target: Target): Promise<Target | null>;
  handle(input: {
    tx: Transaction;
    command: ActionCommand;
    binding: ActionBinding;
    now: Date;
    config: DispatchConfig;
  }): Promise<JsonValue>;
}

/** JSON object order is immaterial; array order and all scalar values are significant. */
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
    .join(",")}}`;
}

export function createDispatcher(
  handlers: Readonly<Record<string, ActionHandler>>,
) {
  const registry = new Map(Object.entries(handlers));
  return async function dispatch(
    ctx: DispatchContext,
    input: unknown,
  ): Promise<ActionResult> {
    const parsed = actionCommandSchema.safeParse(input);
    if (!parsed.success) throw new ValidationFailed(parsed.error.message);
    // Snapshot caller-owned objects before any asynchronous operation.
    const command = parsed.data;
    // Build without the command-only key so strict validation catches real binding errors.
    const { idempotencyKey: key, ...fields } = command;
    const checked = actionBindingSchema.safeParse({
      ...fields,
      tenantId: ctx.tenantId,
      actorId: ctx.actor.id,
    });
    if (!checked.success) throw new ValidationFailed(checked.error.message);
    const binding = checked.data;
    const actorTenant = uuidSchema.safeParse(ctx.actor.tenantId);
    if (!actorTenant.success)
      throw new ValidationFailed(actorTenant.error.message);
    if (
      actorTenant.data !== binding.tenantId ||
      binding.target.tenantId !== binding.tenantId ||
      (binding.approvalReference &&
        binding.approvalReference.tenantId !== binding.tenantId)
    )
      throw new TenantDenied();
    const handler = registry.get(binding.actionType);
    if (!handler) throw new NotImplemented();
    const config = { ...ctx.config };
    return ctx.db
      .tenant(binding.tenantId, async (tx) => {
        // Lock before lookup: concurrent same-key callers see the committed winner at READ COMMITTED.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `${binding.tenantId}:${key}`,
        ]);
        const stored = (
          await tx.query<{
            id: string;
            binding: ActionBinding;
            result: JsonValue;
          }>(
            `SELECT id, jsonb_build_object('tenantId',tenant_id,'actorId',actor_id,'actionType',action_type,'target',target,'payload',payload,'approvalReference',approval_reference) AS binding, result FROM actions WHERE tenant_id=$1 AND idempotency_key=$2`,
            [binding.tenantId, key],
          )
        ).rows[0];
        if (stored) {
          if (canonical(stored.binding.payload) !== canonical(binding.payload))
            throw new IdempotencyConflict();
          if (canonical(stored.binding) !== canonical(binding))
            throw new BindingMismatch();
          return { actionId: stored.id, result: stored.result };
        }
        const target = targetSchema.safeParse(
          await handler.resolveTarget(tx, command.target),
        );
        if (!target.success || target.data.tenantId !== binding.tenantId)
          throw new TenantDenied();
        if (canonical(target.data) !== canonical(binding.target))
          throw new BindingMismatch();
        const approved = await ctx.resolveApproval(
          tx,
          command.approvalReference,
        );
        if (!approved) throw new TenantDenied();
        const approvedBinding = actionBindingSchema.safeParse(approved);
        if (!approvedBinding.success) throw new BindingMismatch();
        if (approvedBinding.data.tenantId !== binding.tenantId)
          throw new TenantDenied();
        if (canonical(approvedBinding.data) !== canonical(binding))
          throw new BindingMismatch();
        const now = new Date(ctx.clock.now().getTime());
        if (!Number.isFinite(now.getTime()))
          throw new ValidationFailed("Clock returned an invalid instant");
        const result = jsonValueSchema.parse(
          await handler.handle({ tx, command, binding, now, config }),
        );
        const actionId = randomUUID();
        const inserted = await tx.query<{ result: JsonValue }>(
          `INSERT INTO actions (tenant_id,id,actor_id,action_type,target,payload,approval_reference,idempotency_key,result,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING result`,
          [
            binding.tenantId,
            actionId,
            binding.actorId,
            binding.actionType,
            JSON.stringify(binding.target),
            JSON.stringify(binding.payload),
            JSON.stringify(binding.approvalReference),
            key,
            JSON.stringify(result),
            now,
          ],
        );
        const persistedResult = inserted.rows[0]!.result;
        await tx.query(
          `INSERT INTO outbox (tenant_id,id,action_id,event_type,payload,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            binding.tenantId,
            randomUUID(),
            actionId,
            config.outboxEventType,
            JSON.stringify({
              actionId,
              actionType: binding.actionType,
              target: binding.target,
              result: persistedResult,
            }),
            now,
          ],
        );
        return { actionId, result: persistedResult };
      })
      .catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          ["55P03", "57014", "40001", "40P01"].includes(String(error.code))
        )
          throw new Conflict(
            "Database transaction timed out or conflicted; retry the same command",
          );
        throw error;
      });
  };
}
