// Shared test world for the outreach tests: a real local Postgres, tenants with owners and staff, connected mailboxes
// (through the operator action, with sealed tokens), a business profile and the owner session. Nothing here can reach
// Google: mailboxes hold a sealed fake token and the only Gmail is FakeGmail.
import { randomUUID } from "node:crypto";
import {
  OUTREACH_MAILBOX_CONNECT_ACTION,
  OUTREACH_MAILBOX_DISCONNECT_ACTION,
  OUTREACH_MAILBOX_TARGET,
  type MemberRole,
} from "@zs/contracts";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import {
  createOutreachSession,
  createSession,
  derivedId,
  generateSealKeyPair,
  parseSealPublicKey,
  sealRefreshToken,
  type EdgeDependencies,
} from "../../src/index.js";
import { directDispatch } from "../../src/edge/session.js";
import { only } from "../../src/edge/dispatch-util.js";

/** Monday 2026-11-09 07:00 in Los Angeles (PST, UTC-8): an hour before the usual window opens. */
export const MONDAY_0700_LA = Date.parse("2026-11-09T15:00:00.000Z");
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.metadata"];
export const ADDRESS = { line1: "1 Market St", city: "San Francisco", region: "CA", postalCode: "94105", country: "US" };

export interface World {
  readonly database: TestDatabase;
  readonly fixture: TwoTenantFixture;
  /** The injected clock; set `time.ms` to move it. */
  readonly time: { ms: number };
  readonly clock: { now(): Date };
  readonly seal: { publicKey: string; privateKey: string };
  deps(allowed: readonly string[]): EdgeDependencies;
  tenant(name: string, options?: { profile?: boolean }): Promise<string>;
  member(tenantId: string, role: MemberRole): Promise<string>;
  /** Connects a mailbox through the operator action; returns its id. */
  mailbox(tenantId: string, address: string, options?: { displayName?: string; dailyLimit?: number; allowed?: readonly string[] }): Promise<string>;
  disconnect(tenantId: string, mailboxId: string, allowed?: readonly string[]): Promise<unknown>;
  profile(tenantId: string, change?: { timeZone?: string | null; postalAddress?: unknown; legalName?: string | null }): Promise<void>;
  owner(tenantId: string, actorId: string, allowed: readonly string[]): ReturnType<typeof createOutreachSession>;
  member_session(tenantId: string, actorId: string, allowed?: readonly string[]): ReturnType<typeof createSession>;
  rows<T extends Record<string, any> = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export async function createWorld(): Promise<World> {
  const database = await createTestDatabase();
  const fixture = await createTwoTenantFixture(database);
  const time = { ms: MONDAY_0700_LA };
  const clock = { now: () => new Date(time.ms) };
  const seal = generateSealKeyPair();
  const publicKey = parseSealPublicKey(seal.publicKey);
  const rows = <T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []) =>
    fixture.service(async (tx) => (await tx.query<T>(sql, params)).rows);
  const deps = (allowed: readonly string[]): EdgeDependencies => ({
    db: database.db, clock, generateId: randomUUID, outreach: { tenants: allowed },
  });
  const operator = (tenantId: string, allowed: readonly string[]) =>
    directDispatch(deps(allowed), tenantId, derivedId(tenantId, "outreach", "operator"),
      only(OUTREACH_MAILBOX_CONNECT_ACTION, OUTREACH_MAILBOX_DISCONNECT_ACTION), { outreach: { tenants: allowed } });

  const world: World = {
    database, fixture, time, clock, seal, deps, rows,
    async tenant(name, options = {}) {
      const id = randomUUID();
      await fixture.service((tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,$2)", [id, name]));
      if (options.profile !== false) await world.profile(id);
      return id;
    },
    async member(tenantId, role) {
      const userId = randomUUID();
      await fixture.service((tx) => tx.query(
        "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
        [tenantId, randomUUID(), `${role}-${userId.slice(0, 8)}@example.com`, userId, role, new Date(time.ms)]));
      return userId;
    },
    async mailbox(tenantId, address, options = {}) {
      const mailboxId = derivedId(tenantId, "outreach-mailbox", address);
      const sealed = sealRefreshToken(publicKey, { tenantId, connectionId: mailboxId }, `fake-refresh-${address}`);
      await operator(tenantId, options.allowed ?? [tenantId])({
        actionType: OUTREACH_MAILBOX_CONNECT_ACTION,
        target: { tenantId, type: OUTREACH_MAILBOX_TARGET, id: mailboxId },
        approvalReference: { tenantId, id: randomUUID() },
        idempotencyKey: `outreach:mailbox:${mailboxId}:${sealed.slice(-16)}`,
        payload: {
          mailboxId, email: address, displayName: options.displayName ?? "Sam Sender", dailyLimit: options.dailyLimit ?? 20,
          sealedRefreshToken: sealed, grantedScopes: SCOPES,
        },
      });
      return mailboxId;
    },
    disconnect(tenantId, mailboxId, allowed = [tenantId]) {
      return operator(tenantId, allowed)({
        actionType: OUTREACH_MAILBOX_DISCONNECT_ACTION,
        target: { tenantId, type: OUTREACH_MAILBOX_TARGET, id: mailboxId },
        approvalReference: { tenantId, id: randomUUID() },
        idempotencyKey: `outreach:mailbox:${mailboxId}:disconnect-${randomUUID()}`,
        payload: { mailboxId },
      });
    },
    async profile(tenantId, change = {}) {
      await fixture.service((tx) => tx.query(
        `UPDATE business_profiles SET time_zone=$2, postal_address=$3, legal_name=$4 WHERE tenant_id=$1`,
        [tenantId,
          change.timeZone === undefined ? "America/Los_Angeles" : change.timeZone,
          change.postalAddress === null ? null : JSON.stringify(change.postalAddress === undefined ? ADDRESS : change.postalAddress),
          change.legalName === undefined ? "Zero Sum Solutions LLC" : change.legalName]));
    },
    owner: (tenantId, actorId, allowed) => createOutreachSession(deps(allowed), { tenantId, actorId }),
    member_session: (tenantId, actorId, allowed = []) => createSession(deps(allowed), { tenantId, actorId }),
    close: () => database.close(),
  };
  return world;
}

/** A valid three-step campaign body. */
export function campaignBody(mailboxIds: readonly string[], change: Record<string, unknown> = {}) {
  return {
    name: "Spring outreach",
    steps: [
      { subject: "Quick idea for {{company}}", body: "Hi {{first_name}}, I help {{industry}} teams.", delayBusinessDays: 0 },
      { body: "Following up, {{first_name}}.", delayBusinessDays: 3 },
      { body: "Last note for {{company}}.", delayBusinessDays: 5 },
    ],
    window: { start: "08:00", end: "10:30" },
    dailyCapPerMailbox: 2,
    mailboxIds: [...mailboxIds],
    ...change,
  };
}
export const prospect = (n: number, change: Record<string, unknown> = {}) => ({
  email: `pat${n}@acme${n}.example`, firstName: `Pat${n}`, company: `Acme ${n}`, industry: "Plumbing", ...change,
});
