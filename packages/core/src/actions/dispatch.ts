import {
  ActionError,
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
import { DatabaseUnavailable, type ScopedDatabase, type Transaction } from "@zs/db";

export type DispatchConfig = Readonly<Record<string, unknown>>;
export interface DispatchContext<Config = DispatchConfig> {
  readonly tenantId: string;
  readonly actor: { readonly id: string; readonly tenantId: string };
  readonly db: ScopedDatabase;
  readonly clock: { now(): Date };
  readonly config: Config;
  /** Mint IDs at the server edge; core has no ambient randomness. */
  readonly generateId: () => string;
  readonly resolveApproval: (
    tx: Transaction,
    reference: ApprovalReference,
  ) => Promise<ActionBinding | null>;
  /**
   * Optional: runs first in the action's transaction, before the idempotency lock and the
   * replay lookup, and throws to refuse (for example a caller who is no longer a member).
   */
  readonly authorize?: (tx: Transaction, binding: ActionBinding) => Promise<void>;
}
export interface HandlerResult {
  result: JsonValue;
  event?: { type: string; payload: JsonValue };
}
export interface ActionHandler<Config = DispatchConfig> {
  /** Verify authoritative ownership, type, and id in this same transaction. */
  resolveTarget(tx: Transaction, target: Target): Promise<Target | null>;
  handle(input: {
    tx: Transaction;
    command: ActionCommand;
    binding: ActionBinding;
    now: Date;
    config: Config;
    generateId: () => string;
  }): Promise<HandlerResult>;
  /** Return a typed domain error, or undefined to use the shared mapping. */
  mapError?(error: unknown): ActionError | undefined;
  /**
   * Optional: bring a result an earlier release stored up to the current output shape before
   * a replay returns it. Runs in the replay's transaction; the stored row never changes.
   */
  upgradeStoredResult?(tx: Transaction, result: JsonValue, binding: ActionBinding): Promise<JsonValue>;
}

function databaseError(error: unknown): unknown {
  if (error instanceof ActionError) return error;
  if (typeof error !== "object" || error === null || !("code" in error)) return error;
  const code = String(error.code);
  if (["23P01", "23505", "55P03", "57014", "40001", "40P01"].includes(code)) {
    const constraint = "constraint" in error && typeof error.constraint === "string" ? error.constraint : undefined;
    return new Conflict("Database transaction conflicted", {
      postgresCode: code,
      ...(constraint ? { constraint } : {}),
    });
  }
  return error;
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

export function createDispatcher<Config = DispatchConfig>(
  handlers: Readonly<Record<string, ActionHandler<Config>>>,
) {
  const registry = new Map(Object.entries(handlers));
  return async function dispatch(
    ctx: DispatchContext<Config>,
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
    const config = ctx.config;
    const generateId = () => {
      const id = uuidSchema.safeParse(ctx.generateId());
      if (!id.success) throw new ValidationFailed("ID generator returned an invalid UUID");
      return id.data;
    };
    const runHandler = async <T>(work: () => Promise<T>): Promise<T> => {
      try { return await work(); }
      catch (error) {
        if (error instanceof ActionError) throw error;
        throw handler.mapError?.(error) ?? databaseError(error);
      }
    };
    return ctx.db
      .tenant(binding.tenantId, async (tx) => {
        if (ctx.authorize) await ctx.authorize(tx, binding);
        // Lock before lookup: concurrent same-key callers see the committed winner at READ COMMITTED.
        // A lock wait that times out means an earlier request with this key is still running and
        // may yet commit, so the answer is retryable (503), not a definitive conflict.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `${binding.tenantId}:${key}`,
        ]).catch((error: unknown) => {
          const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
          throw code === "55P03" ? new DatabaseUnavailable("in_progress", { cause: error }) : error;
        });
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
          // A key names one action: another action type or payload is a reuse, not a replay.
          if (stored.binding.actionType !== binding.actionType ||
            canonical(stored.binding.payload) !== canonical(binding.payload))
            throw new IdempotencyConflict();
          if (canonical(stored.binding) !== canonical(binding))
            throw new BindingMismatch();
          const upgrade = handler.upgradeStoredResult;
          const result = upgrade ? await runHandler(() => upgrade(tx, stored.result, binding)) : stored.result;
          return { actionId: stored.id, result };
        }
        const target = targetSchema.safeParse(
          await runHandler(() => handler.resolveTarget(tx, command.target)),
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
        const handled = await runHandler(() =>
          handler.handle({ tx, command, binding, now, config, generateId }),
        );
        // Handlers are trusted server code we write. This check catches a handler that leaves
        // the transaction scoped to another tenant; throwing rolls back. It sees only the final
        // value: RLS follows the mutable app.tenant_id, so a handler that switches tenant,
        // writes, and switches back passes. Schema-qualified so a handler's search_path cannot
        // shadow the read. The pool resets session state on release (@zs/db scoped.ts).
        const scope = await tx.query<{ tenant: string | null }>(
          "SELECT pg_catalog.current_setting('app.tenant_id', true) AS tenant",
        );
        if ((scope.rows[0]?.tenant ?? "").toLowerCase() !== binding.tenantId.toLowerCase())
          throw new TenantDenied();
        const parsedResult = jsonValueSchema.safeParse(handled.result);
        if (!parsedResult.success) throw new ValidationFailed(parsedResult.error.message);
        const result = parsedResult.data;
        const actionId = generateId();
        const event = handled.event ?? {
          type: binding.actionType,
          payload: { actionId, actionType: binding.actionType, target: binding.target, result },
        };
        const eventType = actionCommandSchema.shape.actionType.safeParse(event.type);
        const eventPayload = jsonValueSchema.safeParse(event.payload);
        if (!eventType.success || !eventPayload.success)
          throw new ValidationFailed("Invalid outbox event");
        const inserted = await tx.query<{ result: JsonValue }>(
          `SELECT public.record_action_and_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS result`,
          [
            binding.tenantId, actionId, binding.actorId, binding.actionType,
            JSON.stringify(binding.target), JSON.stringify(binding.payload),
            JSON.stringify(binding.approvalReference), key, JSON.stringify(result), now,
            generateId(), eventType.data, JSON.stringify(eventPayload.data),
          ],
        );
        const persistedResult = inserted.rows[0]!.result;
        return { actionId, result: persistedResult };
      })
      .catch((error: unknown) => { throw databaseError(error); });
  };
}
