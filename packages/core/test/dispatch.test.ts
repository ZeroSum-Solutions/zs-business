import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BindingMismatch,
  IdempotencyConflict,
  TenantDenied,
  NotImplemented,
  ValidationFailed,
  type ActionBinding,
  type ActionCommand,
} from "@zs/contracts";
import {
  createTestDatabase,
  createTwoTenantFixture,
  type TestDatabase,
  type TwoTenantFixture,
} from "@zs/db/testing";
import { createDispatcher, type DispatchContext } from "../src/index.js";

let db: TestDatabase;
let fixture: TwoTenantFixture;
let ctx: DispatchContext;
let command: ActionCommand;
let approved: ActionBinding;
let fail = false;
const instant = new Date("2026-10-17T12:00:00Z");
const dispatch = createDispatcher({
  "noop.touch": {
    resolveTarget: async (tx, target) => {
      const row = (
        await tx.query<{ tenant_id: string; id: string }>(
          "select tenant_id,id from test_state where id=$1",
          [target.id],
        )
      ).rows[0];
      return row
        ? { tenantId: row.tenant_id, id: row.id, type: "test_state" }
        : null;
    },
    handle: async ({ tx, command, config, now }) => {
      const row = (
        await tx.query<{ touches: number }>(
          "update test_state set touches=touches+1 where id=$1 returning touches",
          [command.target.id],
        )
      ).rows[0]!;
      if (fail) throw new Error("after state write");
      return {
        touches: row.touches,
        at: now.toISOString(),
        eventType: config.outboxEventType,
      };
    },
  },
});
beforeAll(async () => {
  db = await createTestDatabase();
  fixture = await createTwoTenantFixture(db);
  await db.pool.query(
    `create table test_state (tenant_id uuid not null references tenants(tenant_id), id uuid not null, touches integer not null default 0, primary key(tenant_id,id)); alter table test_state enable row level security; alter table test_state force row level security; create policy tenant_scope on test_state to authenticated using (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid); grant select,insert,update on test_state to authenticated; grant all on test_state to service_role;`,
  );
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  fail = false;
  const id = randomUUID();
  await fixture.service((tx) =>
    tx.query("insert into test_state (tenant_id,id) values ($1,$2)", [
      fixture.a.tenantId,
      id,
    ]),
  );
  command = {
    actionType: "noop.touch",
    target: { tenantId: fixture.a.tenantId, id, type: "test_state" },
    payload: { value: 1 },
    approvalReference: { tenantId: fixture.a.tenantId, id: randomUUID() },
    idempotencyKey: randomUUID(),
  };
  ctx = {
    tenantId: fixture.a.tenantId,
    actor: { id: randomUUID(), tenantId: fixture.a.tenantId },
    db: db.db,
    clock: { now: () => instant },
    config: { outboxEventType: "test.action.completed" },
    resolveApproval: async () => approved,
  };
  approved = {
    tenantId: ctx.tenantId,
    actorId: ctx.actor.id,
    actionType: command.actionType,
    target: command.target,
    payload: command.payload,
    approvalReference: command.approvalReference,
  };
});
async function counts() {
  return fixture.a.run(async (tx) => ({
    state: (
      await tx.query("select touches from test_state where id=$1", [
        command.target.id,
      ])
    ).rows[0]?.touches,
    actions: (
      await tx.query("select * from actions where idempotency_key=$1", [
        command.idempotencyKey,
      ])
    ).rows,
    outbox: (
      await tx.query(
        "select o.* from outbox o join actions a on a.tenant_id=o.tenant_id and a.id=o.action_id where a.idempotency_key=$1",
        [command.idempotencyKey],
      )
    ).rows,
  }));
}
describe("shared transactional action path", () => {
  it("binds all fields, uses injected time/config, and retries without duplicating state or outbox", async () => {
    const first = await dispatch(ctx, command);
    const second = await dispatch(ctx, structuredClone(command));
    expect(second).toEqual(first);
    expect(first.result).toEqual({
      touches: 1,
      at: "2026-10-17T12:00:00.000Z",
      eventType: "test.action.completed",
    });
    const saved = await counts();
    expect(saved.state).toBe(1);
    expect(saved.actions).toHaveLength(1);
    expect(saved.outbox).toHaveLength(1);
    expect(saved.actions[0]).toMatchObject({
      actor_id: ctx.actor.id,
      tenant_id: ctx.tenantId,
      action_type: "noop.touch",
      target: command.target,
      payload: command.payload,
      approval_reference: command.approvalReference,
      created_at: instant,
    });
    expect(saved.outbox[0]).toMatchObject({
      action_id: first.actionId,
      event_type: "test.action.completed",
      created_at: instant,
    });
  });
  it("rejects reused keys with different payloads", async () => {
    await dispatch(ctx, command);
    await expect(
      dispatch(ctx, { ...command, payload: { value: 2 } }),
    ).rejects.toBeInstanceOf(IdempotencyConflict);
    expect((await counts()).state).toBe(1);
  });
  it("treats JSON object key ordering as the same payload", async () => {
    command.payload = { a: 1, b: { x: 2, y: 3 } };
    approved = { ...approved, payload: command.payload };
    const first = await dispatch(ctx, command);
    expect(
      await dispatch(ctx, { ...command, payload: { b: { y: 3, x: 2 }, a: 1 } }),
    ).toEqual(first);
  });
  it("replays equivalent UUID spellings as the same binding", async () => {
    const first = await dispatch(ctx, command);
    const uppercase = (value: string) => value.toUpperCase();
    const retry = structuredClone(command);
    retry.target.tenantId = uppercase(retry.target.tenantId);
    retry.target.id = uppercase(retry.target.id);
    retry.approvalReference = {
      tenantId: uppercase(ctx.tenantId),
      id: uppercase(command.approvalReference!.id),
    };
    expect(
      await dispatch(
        {
          ...ctx,
          tenantId: uppercase(ctx.tenantId),
          actor: {
            id: uppercase(ctx.actor.id),
            tenantId: uppercase(ctx.tenantId),
          },
        },
        retry,
      ),
    ).toEqual(first);
  });
  it("returns the same JSON representation on the first response and replay", async () => {
    const jsonDispatch = createDispatcher({
      "noop.json": {
        resolveTarget: async (_tx, target) => target,
        handle: async () => ({ value: -0 }),
      },
    });
    command.actionType = "noop.json";
    approved = { ...approved, actionType: "noop.json" };
    const first = await jsonDispatch(ctx, command);
    const retry = await jsonDispatch(ctx, command);
    expect(first.result).toEqual(retry.result);
    expect(first.result).toEqual({ value: 0 });
  });
  it("serializes simultaneous retries", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => dispatch(ctx, command)),
    );
    expect(new Set(results.map((r) => r.actionId)).size).toBe(1);
    const saved = await counts();
    expect(saved.state).toBe(1);
    expect(saved.outbox).toHaveLength(1);
  });
  it.each(["actorId", "target", "payload", "approvalReference"] as const)(
    "rejects mismatched approved %s",
    async (field) => {
      approved = structuredClone(approved);
      if (field === "actorId") approved.actorId = randomUUID();
      if (field === "target") approved.target.id = randomUUID();
      if (field === "payload") approved.payload = { different: true };
      if (field === "approvalReference")
        approved.approvalReference = {
          tenantId: ctx.tenantId,
          id: randomUUID(),
        };
      await expect(dispatch(ctx, command)).rejects.toBeInstanceOf(
        BindingMismatch,
      );
      const saved = await counts();
      expect(saved.state).toBe(0);
      expect(saved.actions).toHaveLength(0);
      expect(saved.outbox).toHaveLength(0);
    },
  );
  it("rejects a target claimed from another tenant", async () => {
    await expect(
      dispatch(ctx, {
        ...command,
        target: { ...command.target, tenantId: fixture.b.tenantId },
      }),
    ).rejects.toBeInstanceOf(TenantDenied);
  });
  it("rejects a forged target tenant when the actual row belongs to B", async () => {
    const id = randomUUID();
    await fixture.service((tx) =>
      tx.query("insert into test_state(tenant_id,id) values($1,$2)", [
        fixture.b.tenantId,
        id,
      ]),
    );
    await expect(
      dispatch(ctx, { ...command, target: { ...command.target, id } }),
    ).rejects.toBeInstanceOf(TenantDenied);
  });
  it("rejects a cross-tenant approval and actor context", async () => {
    await expect(
      dispatch(ctx, {
        ...command,
        approvalReference: { tenantId: fixture.b.tenantId, id: randomUUID() },
      }),
    ).rejects.toBeInstanceOf(TenantDenied);
    await expect(
      dispatch(
        { ...ctx, actor: { ...ctx.actor, tenantId: fixture.b.tenantId } },
        command,
      ),
    ).rejects.toBeInstanceOf(TenantDenied);
  });
  it("does not return a stored result to a different actor or approval binding", async () => {
    await dispatch(ctx, command);
    await expect(
      dispatch({ ...ctx, actor: { ...ctx.actor, id: randomUUID() } }, command),
    ).rejects.toBeInstanceOf(BindingMismatch);
    await expect(
      dispatch(ctx, {
        ...command,
        approvalReference: { tenantId: ctx.tenantId, id: randomUUID() },
      }),
    ).rejects.toBeInstanceOf(BindingMismatch);
  });
  it("rolls back the state, action and outbox when a handler throws after state mutation", async () => {
    fail = true;
    await expect(dispatch(ctx, command)).rejects.toThrow("after state write");
    const saved = await counts();
    expect(saved.state).toBe(0);
    expect(saved.actions).toHaveLength(0);
    expect(saved.outbox).toHaveLength(0);
    fail = false;
    await dispatch(ctx, command);
    expect((await counts()).state).toBe(1);
  });
  it("rolls back state and action when the final outbox write fails", async () => {
    await expect(
      dispatch({ ...ctx, config: { outboxEventType: "" } }, command),
    ).rejects.toThrow();
    const saved = await counts();
    expect(saved.state).toBe(0);
    expect(saved.actions).toHaveLength(0);
    expect(saved.outbox).toHaveLength(0);
  });
  it("rejects malformed commands and unregistered action types with typed errors", async () => {
    await expect(
      dispatch(ctx, { ...command, idempotencyKey: "" }),
    ).rejects.toBeInstanceOf(ValidationFailed);
    await expect(
      dispatch(ctx, { ...command, actionType: "missing" }),
    ).rejects.toBeInstanceOf(NotImplemented);
  });
});
