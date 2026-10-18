import { randomUUID } from "node:crypto";
import {
  createDealCommandSchema,
  createOrFindContactCommandSchema,
  moveDealStageCommandSchema,
  type ActionCommand,
  type CreateDealInput,
  type CreateOrFindContactInput,
  type MoveDealStageInput,
} from "@zs/contracts";
import type { ScopedDatabase } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { createDispatcher, crmHandlers, type DispatchContext } from "../../src/index.js";
import type { CrmWriteContext } from "@zs/contracts";

export const NOW = "2026-10-19T08:00:00.000Z";
const dispatch = createDispatcher({ ...crmHandlers });

export interface Harness {
  database: TestDatabase;
  fixture: TwoTenantFixture;
  /** Bound write context for a tenant; every command is approved exactly as dispatched. */
  ctx(tenantId: string, now?: string, db?: ScopedDatabase): CrmWriteContext;
  seedPipeline(tenantId: string): Promise<{ pipelineId: string; stages: [string, string] }>;
  count(table: "actions" | "outbox" | "crm_contacts" | "crm_deals" | "crm_contact_consent", tenantId: string): Promise<number>;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const database = await createTestDatabase();
  const fixture = await createTwoTenantFixture(database);
  const actorId = randomUUID();
  return {
    database,
    fixture,
    ctx(tenantId, now = NOW, db = database.db) {
      const context: DispatchContext = {
        tenantId,
        actor: { tenantId, id: actorId },
        db,
        clock: { now: () => new Date(now) },
        config: {},
        generateId: randomUUID,
        resolveApproval: async (_tx, reference) => ({
          ...pending.get(reference.id)!, tenantId, actorId,
        }),
      };
      const pending = new Map<string, Omit<ActionCommand, "idempotencyKey">>();
      return {
        dispatch: (command) => {
          const { idempotencyKey: _key, ...binding } = command;
          pending.set(command.approvalReference.id, binding);
          return dispatch(context, command);
        },
      };
    },
    async seedPipeline(tenantId) {
      const pipelineId = randomUUID();
      const stages: [string, string] = [randomUUID(), randomUUID()];
      await fixture.service(async (tx) => {
        await tx.query("INSERT INTO crm_pipelines (tenant_id,id,name) VALUES ($1,$2,$3)", [tenantId, pipelineId, "Pipeline"]);
        await tx.query(
          "INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position) VALUES ($1,$2,$3,'New',0),($1,$4,$3,'Won',1)",
          [tenantId, stages[0], pipelineId, stages[1]],
        );
      });
      return { pipelineId, stages };
    },
    async count(table, tenantId) {
      return fixture.service(async (tx) =>
        Number((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE tenant_id=$1`, [tenantId])).rows[0]!.n));
    },
    close: () => database.close(),
  };
}

const envelope = (tenantId: string, type: string, id: string) => ({
  target: { tenantId, type, id },
  approvalReference: { tenantId, id: randomUUID() },
  idempotencyKey: randomUUID(),
});

export function contactCommand(tenantId: string, payload: Partial<CreateOrFindContactInput> & { contactId?: string }, key?: string) {
  const contactId = payload.contactId ?? randomUUID();
  const base = envelope(tenantId, "contact", contactId);
  return createOrFindContactCommandSchema.parse({
    actionType: "crm.contact.create-or-find",
    ...base,
    idempotencyKey: key ?? base.idempotencyKey,
    payload: {
      displayName: null, email: null, phone: null, mode: "interactive",
      consent: { email: null, sms: null }, ...payload, contactId,
    },
  });
}

export function dealCommand(tenantId: string, payload: Omit<CreateDealInput, "dealId"> & { dealId?: string }) {
  const dealId = payload.dealId ?? randomUUID();
  return createDealCommandSchema.parse({
    actionType: "crm.deal.create", ...envelope(tenantId, "deal", dealId), payload: { ...payload, dealId },
  });
}

export function moveCommand(tenantId: string, payload: MoveDealStageInput) {
  return moveDealStageCommandSchema.parse({
    actionType: "crm.deal.move-stage", ...envelope(tenantId, "deal", payload.dealId), payload,
  });
}

export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error("Expected a rejection");
}
