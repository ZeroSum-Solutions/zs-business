import { randomUUID } from "node:crypto";
import {
  MESSAGE_SEND_REQUESTED,
  messageSendRequestedSchema,
  type ActionCommand,
  type DeliveryChannel,
  type DeliveryPurpose,
  type JsonValue,
} from "@zs/contracts";
import { asService, type Transaction } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import {
  createDeliveryWorker,
  createDispatcher,
  createFakeProvider,
  creditWallet,
  deliveryContentDigest,
  type ActionHandler,
  type ApprovalStanding,
  type DeliveryApprovals,
  type DeliveryWorkerConfig,
  type DispatchContext,
  type FakeProvider,
} from "../../src/index.js";

export const START = Date.parse("2026-10-20T09:00:00.000Z");
export const PRICES = { currency: "usd", email: 2, smsSegment: 3 } as const;
export const UNSUBSCRIBE_SECRET = "unsubscribe-test-secret-0123456789abcdef";

/** A clock tests move by hand; nothing depends on today's date. */
export function manualClock(start = START) {
  let at = start;
  return {
    now: () => new Date(at),
    advance(ms: number) { at += ms; },
    set(instant: number) { at = instant; },
  };
}
export type ManualClock = ReturnType<typeof manualClock>;

/**
 * Stand-in for M3b's approval record behind the narrow port: an approval stands for one
 * message and one content digest until it is revoked.
 */
export function fakeApprovals() {
  const records = new Map<string, { messageId: string; digest: string; revoked: boolean }>();
  const port: DeliveryApprovals = {
    async check(tx, input): Promise<ApprovalStanding> {
      // The send action's approval reference, as M3b's approvalForAction reads it.
      const approvalId = (await tx.query<{ id: string }>(
        "SELECT approval_reference->>'id' AS id FROM actions WHERE tenant_id=$1 AND id=$2", [input.tenantId, input.actionId])).rows[0]?.id;
      const record = records.get(`${input.tenantId}:${approvalId}`);
      if (!record || record.messageId !== input.messageId || record.digest !== input.contentDigest) return "missing";
      return record.revoked ? "revoked" : "approved";
    },
  };
  return {
    port,
    approve(tenantId: string, approvalId: string, messageId: string, digest: string) {
      records.set(`${tenantId}:${approvalId}`, { messageId, digest, revoked: false });
    },
    revoke(tenantId: string, approvalId: string) {
      const record = records.get(`${tenantId}:${approvalId}`);
      if (record) record.revoked = true;
    },
  };
}

/** The producer side as M3c will build it: an action whose event asks for one send. */
const TEST_SEND_ACTION = "test.message.send";
const sendHandler: ActionHandler = {
  async resolveTarget(_tx, target) { return target; },
  async handle({ command }) {
    const payload = command.payload as { messageId: string };
    return { result: { messageId: payload.messageId }, event: { type: MESSAGE_SEND_REQUESTED, payload: command.payload } };
  },
};
const dispatch = createDispatcher({ [TEST_SEND_ACTION]: sendHandler });

export interface DeliveryHarness {
  database: TestDatabase;
  fixture: TwoTenantFixture;
  clock: ManualClock;
  provider: FakeProvider;
  approvals: ReturnType<typeof fakeApprovals>;
  service<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  worker(overrides?: Partial<DeliveryWorkerConfig>, provider?: FakeProvider): ReturnType<typeof createDeliveryWorker>;
  /** A contact with optional consent rows. */
  contact(tenantId: string, input?: { email?: string | null; phone?: string | null; consent?: Partial<Record<DeliveryChannel, "granted" | "denied">> }): Promise<string>;
  credit(tenantId: string, amount: number): Promise<void>;
  /** Commits one approved send request through the dispatcher; raw payloads skip the schema. */
  enqueue(tenantId: string, input: {
    contactId: string;
    channel?: DeliveryChannel;
    purpose?: DeliveryPurpose;
    body?: string;
    subject?: string;
    messageId?: string;
    approve?: boolean;
    raw?: Record<string, unknown>;
  }): Promise<{ messageId: string; approvalId: string }>;
  delivery(tenantId: string, messageId: string): Promise<Record<string, any>>;
  /** A fresh tenant, so wallet and suppression state start empty. */
  tenant(): Promise<string>;
  /** Ends every unfinished delivery and gives the next test a fresh provider. */
  reset(): Promise<void>;
  wallet(tenantId: string): Promise<{ balance: number; reserved: number }>;
  rows<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export async function createDeliveryHarness(): Promise<DeliveryHarness> {
  const database = await createTestDatabase();
  const fixture = await createTwoTenantFixture(database);
  const clock = manualClock();
  let provider = createFakeProvider({ clock });
  const approvals = fakeApprovals();
  const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(database.servicePool, work);
  const actorId = randomUUID();

  const harness: DeliveryHarness = {
    database, fixture, clock, approvals, service,
    get provider() { return provider; },
    worker(overrides = {}, channelProvider = provider) {
      return createDeliveryWorker({
        service,
        providers: { email: channelProvider, sms: channelProvider },
        approvals: approvals.port,
        clock,
        generateId: randomUUID,
        config: {
          workerId: `worker-${randomUUID().slice(0, 8)}`,
          leaseMs: 60_000,
          providerTimeoutMs: 5_000,
          maxAttempts: 4,
          backoffBaseMs: 1_000,
          backoffMaxMs: 60_000,
          dedupeMarginMs: 60_000,
          pricing: PRICES,
          unsubscribe: { secret: UNSUBSCRIBE_SECRET, baseUrl: "https://api.example.test/public/v1/unsubscribe" },
          ...overrides,
        },
      });
    },
    async contact(tenantId, input = {}) {
      const id = randomUUID();
      const email = input.email === undefined ? `guest-${id.slice(0, 8)}@haldenrowe.example` : input.email;
      const phone = input.phone ?? null;
      await service(async (tx) => {
        await tx.query(
          `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at)
           VALUES ($1,$2,'Halden Guest',$3,$4,$5,$5)`, [tenantId, id, email, phone, clock.now()]);
        for (const [channel, status] of Object.entries(input.consent ?? {}))
          await tx.query(
            `INSERT INTO crm_contact_consent (tenant_id,contact_id,channel,status,source,recorded_at)
             VALUES ($1,$2,$3::crm_consent_channel,$4,'test',$5)`, [tenantId, id, channel, status, clock.now()]);
      });
      return id;
    },
    async credit(tenantId, amount) {
      await service((tx) => creditWallet(tx, {
        tenantId, ledgerId: randomUUID(), amount, idempotencyKey: `credit:${randomUUID()}`, now: clock.now(),
      }));
    },
    async enqueue(tenantId, input) {
      const messageId = input.messageId ?? randomUUID();
      const approvalId = randomUUID();
      const channel = input.channel ?? "email";
      const payload = input.raw ?? {
        messageId, contactId: input.contactId, channel, purpose: input.purpose ?? "transactional",
        ...(channel === "email" ? { subject: input.subject ?? "Your booking" } : {}),
        body: input.body ?? "Thanks for booking with Halden & Rowe.",
      };
      if (!input.raw && input.approve !== false) {
        const parsed = messageSendRequestedSchema.parse(payload);
        approvals.approve(tenantId, approvalId, messageId, deliveryContentDigest(parsed));
      }
      const command: ActionCommand = {
        actionType: TEST_SEND_ACTION,
        target: { tenantId, type: "message", id: messageId },
        approvalReference: { tenantId, id: approvalId },
        idempotencyKey: `send:${randomUUID()}`,
        payload: (input.raw ?? messageSendRequestedSchema.parse(payload)) as JsonValue,
      };
      const { idempotencyKey: _key, ...binding } = command;
      const ctx: DispatchContext = {
        tenantId, actor: { tenantId, id: actorId }, db: database.db, clock, config: {}, generateId: randomUUID,
        resolveApproval: async () => ({ ...binding, tenantId, actorId }),
      };
      await dispatch(ctx, command);
      return { messageId, approvalId };
    },
    async delivery(tenantId, messageId) {
      return (await harness.rows("SELECT * FROM message_deliveries WHERE tenant_id=$1 AND message_id=$2", [tenantId, messageId]))[0]!;
    },
    async wallet(tenantId) {
      const row = (await harness.rows<{ balance: string; reserved: string }>(
        "SELECT balance, reserved FROM wallets WHERE tenant_id=$1", [tenantId]))[0];
      return { balance: Number(row?.balance ?? 0), reserved: Number(row?.reserved ?? 0) };
    },
    async tenant() {
      const tenantId = randomUUID();
      await service((tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Halden & Rowe')", [tenantId]));
      return tenantId;
    },
    async reset() {
      await service(async (tx) => {
        await tx.query(`UPDATE message_deliveries SET status='dead', final_reason='test_reset', lease_token=NULL,
          lease_owner=NULL, lease_expires_at=NULL WHERE status NOT IN ('sent','blocked','dead')`);
        await tx.query("UPDATE outbox SET processed_at=$1 WHERE processed_at IS NULL", [clock.now()]);
      });
      provider = createFakeProvider({ clock });
    },
    async rows(sql, params = []) {
      return service(async (tx) => (await tx.query(sql, params)).rows);
    },
    close: () => database.close(),
  };
  return harness;
}
