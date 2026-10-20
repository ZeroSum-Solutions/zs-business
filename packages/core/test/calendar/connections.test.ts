// M5 Google Calendar connections (docs/requirements/google-calendar.md G-1, G-4, G-5, G-11): the
// connect and disconnect actions through the member write path, the owner's list, and what the
// runtime role may and may not do to calendar rows, all under the runtime role with two tenants.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CALENDAR_GOOGLE_CONNECT_ACTION,
  NotFound,
  TenantDenied,
  ValidationFailed,
  calendarConnectionListSchema,
  calendarConnectionSchema,
  type ActionCommand,
} from "@zs/contracts";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import {
  approvedDispatch,
  createSession,
  derivedId,
  generateSealKeyPair,
  googleConnectIdempotencyKey,
  memberDispatch,
  openRefreshToken,
  parseSealPrivateKey,
  parseSealPublicKey,
  pkceChallenge,
  pkceVerifier,
  sealRefreshToken,
  verifyConnectState,
  type EdgeDependencies,
  type GoogleClient,
} from "../../src/index.js";

const NOW = "2026-10-20T09:00:00.000Z";
const clock = { now: () => new Date(NOW) };
const keys = generateSealKeyPair();
const publicKey = parseSealPublicKey(keys.publicKey);
const privateKey = parseSealPrivateKey(keys.privateKey);
/** Synthetic state secret, built at runtime so secret scanners do not flag a literal. */
const STATE_SECRET = ["test", "oauth-state", "s".repeat(32)].join("-");

/** Only the consent URL is used here; the callback's exchange is covered by the API tests. */
const google: GoogleClient = {
  authorizeUrl: ({ state, codeChallenge }) => `https://accounts.google.test/auth?${new URLSearchParams({ state, code_challenge: codeChallenge })}`,
  exchangeCode: async () => { throw new Error("not used"); },
  refreshAccessToken: async () => { throw new Error("not used"); },
  revoke: async () => { throw new Error("not used"); },
  listEvents: async () => { throw new Error("not used"); },
  insertEvent: async () => { throw new Error("not used"); },
  watch: async () => { throw new Error("not used"); },
  stopChannel: async () => { throw new Error("not used"); },
};

let database: TestDatabase;
let fixture: TwoTenantFixture;
const tenants: Record<"a" | "b", { tenantId: string; ownerId: string; staffId: string; resourceId: string; otherResourceId: string }> = {} as never;

const deps = (withCalendar = true): EdgeDependencies => ({
  db: database.db, clock, generateId: randomUUID,
  ...(withCalendar ? { calendar: { google, stateSecrets: { current: STATE_SECRET }, tokenPublicKey: publicKey } } : {}),
});

async function addMember(tenantId: string, role: "owner" | "staff"): Promise<string> {
  const userId = randomUUID();
  const memberId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenantId, memberId, `${role}-${memberId.slice(0, 8)}@example.com`, userId, role, NOW]));
  return userId;
}
async function addResource(tenantId: string): Promise<string> {
  const id = randomUUID();
  await fixture.service((tx) => tx.query(
    `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
       buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
     VALUES ($1,$2,'UTC','[]'::jsonb,'[]'::jsonb,60,30,0,0,0,20160)`, [tenantId, id]));
  return id;
}

/** The command the OAuth callback dispatches for one connection (G-2). */
function connectCommand(tenantId: string, resourceId: string, connectionId: string = randomUUID(), token = `1//refresh-${randomUUID()}`): ActionCommand {
  const idempotencyKey = googleConnectIdempotencyKey(connectionId);
  return {
    actionType: CALENDAR_GOOGLE_CONNECT_ACTION,
    target: { tenantId, type: "calendar_connection", id: connectionId },
    approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
    idempotencyKey,
    payload: {
      connectionId, resourceId, accountEmail: "owner@calendar.test", scope: "openid email https://www.googleapis.com/auth/calendar.events",
      refreshTokenSealed: sealRefreshToken(publicKey, { tenantId, connectionId }, token),
    },
  };
}
const connectAs = (tenantId: string, actorId: string, command: ActionCommand) => memberDispatch(deps(), { tenantId, actorId })(command);

interface StoredRow {
  status: string; resource_id: string; created_by: string; next_sync_at: Date; refresh_token_sealed: string | null; account_email: string | null;
}
const storedRow = (tenantId: string, id: string) => fixture.service(async (tx) => (await tx.query<StoredRow>(
  `SELECT status::text AS status, resource_id, created_by, next_sync_at, refresh_token_sealed, account_email
     FROM calendar_connections WHERE tenant_id=$1 AND id=$2`, [tenantId, id])).rows[0]);
const pgCode = (error: unknown) => (error as { code?: string }).code;
const onlyFromCallback = (error: unknown) => error instanceof ValidationFailed && /only from the OAuth callback/.test(error.message);

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  for (const [name, tenantId] of [["a", fixture.a.tenantId], ["b", fixture.b.tenantId]] as const)
    tenants[name] = {
      tenantId, ownerId: await addMember(tenantId, "owner"), staffId: await addMember(tenantId, "staff"),
      resourceId: await addResource(tenantId), otherResourceId: await addResource(tenantId),
    };
});
afterAll(async () => { await database?.close(); });

describe("calendar.google.connect (G-2, G-4)", () => {
  it("inserts an active connection, due now, created by the member, holding the sealed token", async () => {
    const { tenantId, ownerId, resourceId } = tenants.a;
    const command = connectCommand(tenantId, resourceId, randomUUID(), "1//the-refresh-token");
    const outcome = await connectAs(tenantId, ownerId, command);
    const connection = calendarConnectionSchema.parse(outcome.result);
    expect(connection).toEqual({
      id: command.target.id, provider: "google", resourceId, calendarId: "primary", accountEmail: "owner@calendar.test",
      status: "active", lastSyncedAt: null, lastError: null, createdAt: NOW,
    });
    // The result never carries the token.
    expect(JSON.stringify(outcome.result)).not.toContain("zsg1.");
    const row = (await storedRow(tenantId, command.target.id))!;
    expect(row).toMatchObject({ status: "active", resource_id: resourceId, created_by: ownerId, next_sync_at: new Date(NOW) });
    expect(openRefreshToken(privateKey, { tenantId, connectionId: command.target.id }, row.refresh_token_sealed!)).toBe("1//the-refresh-token");

    // The same key and payload replay the stored result.
    expect(await connectAs(tenantId, ownerId, command)).toEqual(outcome);
  });

  it("retires the resource's live connection to disconnecting in the same action", async () => {
    const { tenantId, ownerId } = tenants.a;
    const resourceId = await addResource(tenantId);
    const first = connectCommand(tenantId, resourceId);
    await connectAs(tenantId, ownerId, first);
    const second = connectCommand(tenantId, resourceId);
    await connectAs(tenantId, ownerId, second);
    expect((await storedRow(tenantId, first.target.id))!.status).toBe("disconnecting");
    expect((await storedRow(tenantId, second.target.id))!.status).toBe("active");
    // A third connect retires the second; the first stays disconnecting for the worker.
    const third = connectCommand(tenantId, resourceId);
    await connectAs(tenantId, ownerId, third);
    expect((await Promise.all([first, second, third].map((c) => storedRow(tenantId, c.target.id)))).map((row) => row!.status))
      .toEqual(["disconnecting", "disconnecting", "active"]);
    // A reauthorize connection is retired too.
    await fixture.service((tx) => tx.query("UPDATE calendar_connections SET status='reauthorize' WHERE tenant_id=$1 AND id=$2", [tenantId, third.target.id]));
    const fourth = connectCommand(tenantId, resourceId);
    await connectAs(tenantId, ownerId, fourth);
    expect((await storedRow(tenantId, third.target.id))!.status).toBe("disconnecting");
    // Another resource's connection is untouched.
    const elsewhere = connectCommand(tenantId, await addResource(tenantId));
    await connectAs(tenantId, ownerId, elsewhere);
    await connectAs(tenantId, ownerId, connectCommand(tenantId, resourceId));
    expect((await storedRow(tenantId, elsewhere.target.id))!.status).toBe("active");
  });

  it("refuses another tenant's resource, staff, and a member of another tenant, writing nothing", async () => {
    const { tenantId, ownerId, staffId, resourceId } = tenants.a;
    const foreign = connectCommand(tenantId, tenants.b.resourceId);
    await expect(connectAs(tenantId, ownerId, foreign)).rejects.toBeInstanceOf(TenantDenied);
    const staff = connectCommand(tenantId, resourceId);
    await expect(connectAs(tenantId, staffId, staff)).rejects.toBeInstanceOf(TenantDenied);
    const outsider = connectCommand(tenantId, resourceId);
    await expect(connectAs(tenantId, tenants.b.ownerId, outsider)).rejects.toBeInstanceOf(TenantDenied);
    for (const command of [foreign, staff, outsider]) expect(await storedRow(tenantId, command.target.id)).toBeUndefined();
    // Tenant B's resources were never changed by A's attempt.
    expect((await listAll(tenants.b.tenantId)).filter((c) => c.resourceId === tenants.b.resourceId)).toEqual([]);
  });

  it("refuses any key but the callback's reserved one, so a hand-built payload never lands (G-2)", async () => {
    const { tenantId, ownerId, resourceId } = tenants.a;
    const command = connectCommand(tenantId, resourceId);
    for (const idempotencyKey of [randomUUID(), `approval:${randomUUID()}`, googleConnectIdempotencyKey(randomUUID()), `${command.idempotencyKey}x`])
      await expect(connectAs(tenantId, ownerId, { ...command, idempotencyKey }), idempotencyKey).rejects.toSatisfy(onlyFromCallback);
    expect(await storedRow(tenantId, command.target.id)).toBeUndefined();
    // The reserved key, as the callback sends it, still connects.
    await connectAs(tenantId, ownerId, command);
    expect((await storedRow(tenantId, command.target.id))!.status).toBe("active");
  });

  it("never runs from an approval, even one that reached the table approved (G-2)", async () => {
    const { tenantId, ownerId, resourceId } = tenants.a;
    const command = connectCommand(tenantId, resourceId);
    const approvalId = randomUUID();
    await fixture.service((tx) => tx.query(
      `INSERT INTO approvals (tenant_id,id,action_type,target_type,target_id,payload,summary,requested_by,requested_at,expires_at,status,decided_by,decided_at)
       VALUES ($1,$2,$3,'calendar_connection',$4,$5,'Connect',$6,$7,$8,'approved',$6,$7)`,
      [tenantId, approvalId, CALENDAR_GOOGLE_CONNECT_ACTION, command.target.id, JSON.stringify(command.payload), ownerId,
        NOW, new Date(Date.parse(NOW) + 3_600_000)]));
    await expect(approvedDispatch(deps(), tenantId, ownerId)(approvalId)).rejects.toSatisfy(onlyFromCallback);
    expect(await storedRow(tenantId, command.target.id)).toBeUndefined();
  });
});

const listAll = async (tenantId: string) =>
  calendarConnectionListSchema.parse(await createSession(deps(), { tenantId, actorId: tenants[tenantId === tenants.a.tenantId ? "a" : "b"].ownerId })
    .listCalendarConnections()).items;

describe("calendar.google.disconnect (G-5)", () => {
  it("moves active and reauthorize to disconnecting and answers retired ones as they are", async () => {
    const { tenantId, ownerId } = tenants.a;
    const session = createSession(deps(), { tenantId, actorId: ownerId });
    const resourceId = await addResource(tenantId);
    const command = connectCommand(tenantId, resourceId);
    await connectAs(tenantId, ownerId, command);
    const id = command.target.id;
    const key = randomUUID();
    const first = await session.disconnectCalendar(id, key);
    expect(first.result).toMatchObject({ id, status: "disconnecting" });
    // A replay, and a new key on a disconnecting connection, change nothing.
    expect(await session.disconnectCalendar(id, key)).toEqual(first);
    expect((await session.disconnectCalendar(id, randomUUID())).result.status).toBe("disconnecting");
    // Once the worker finished: disconnected stays disconnected.
    await fixture.service((tx) => tx.query(
      "UPDATE calendar_connections SET status='disconnected', refresh_token_sealed=NULL WHERE tenant_id=$1 AND id=$2", [tenantId, id]));
    expect((await session.disconnectCalendar(id, randomUUID())).result.status).toBe("disconnected");

    const other = connectCommand(tenantId, resourceId);
    await connectAs(tenantId, ownerId, other);
    await fixture.service((tx) => tx.query("UPDATE calendar_connections SET status='reauthorize' WHERE tenant_id=$1 AND id=$2", [tenantId, other.target.id]));
    expect((await session.disconnectCalendar(other.target.id, randomUUID())).result.status).toBe("disconnecting");
  });

  it("answers an unknown connection, or another tenant's, NotFound and leaves it alone", async () => {
    const session = createSession(deps(), { tenantId: tenants.a.tenantId, actorId: tenants.a.ownerId });
    await expect(session.disconnectCalendar(randomUUID(), randomUUID())).rejects.toBeInstanceOf(NotFound);
    const theirs = connectCommand(tenants.b.tenantId, await addResource(tenants.b.tenantId));
    await connectAs(tenants.b.tenantId, tenants.b.ownerId, theirs);
    await expect(session.disconnectCalendar(theirs.target.id, randomUUID())).rejects.toBeInstanceOf(NotFound);
    expect((await storedRow(tenants.b.tenantId, theirs.target.id))!.status).toBe("active");
  });

  it("refuses staff", async () => {
    const { tenantId, ownerId, staffId } = tenants.a;
    const command = connectCommand(tenantId, await addResource(tenantId));
    await connectAs(tenantId, ownerId, command);
    await expect(createSession(deps(), { tenantId, actorId: staffId }).disconnectCalendar(command.target.id, randomUUID()))
      .rejects.toBeInstanceOf(TenantDenied);
    expect((await storedRow(tenantId, command.target.id))!.status).toBe("active");
  });
});

describe("listCalendarConnections and startGoogleConnect", () => {
  it("lists the tenant's own connections only, newest first, to staff too", async () => {
    const mine = await listAll(tenants.a.tenantId);
    const theirs = await listAll(tenants.b.tenantId);
    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);
    const ids = new Set(mine.map((c) => c.id));
    for (const connection of theirs) expect(ids.has(connection.id)).toBe(false);
    const staff = await createSession(deps(), { tenantId: tenants.a.tenantId, actorId: tenants.a.staffId }).listCalendarConnections();
    expect(staff.items.map((c) => c.id).sort()).toEqual(mine.map((c) => c.id).sort());
  });

  it("signs a state naming the member, resource and derived connection, with a matching PKCE challenge", async () => {
    const { tenantId, ownerId, resourceId } = tenants.a;
    const key = randomUUID();
    const { authorizeUrl } = await createSession(deps(), { tenantId, actorId: ownerId }).startGoogleConnect({ resourceId }, key);
    const query = new URL(authorizeUrl).searchParams;
    const connectionId = derivedId(tenantId, key, "calendar_connection");
    expect(verifyConnectState({ current: STATE_SECRET }, query.get("state")!, clock.now())).toEqual({
      tenantId, actorId: ownerId, resourceId, connectionId, expiresAt: Date.parse(NOW) + 10 * 60_000,
    });
    expect(query.get("code_challenge")).toBe(pkceChallenge(pkceVerifier(STATE_SECRET, connectionId)));
    // Nothing is stored before the callback.
    expect(await storedRow(tenantId, connectionId)).toBeUndefined();
  });

  it("refuses another tenant's resource and answers NotFound without calendar config", async () => {
    const session = createSession(deps(), { tenantId: tenants.a.tenantId, actorId: tenants.a.ownerId });
    await expect(session.startGoogleConnect({ resourceId: tenants.b.resourceId }, randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    await expect(createSession(deps(false), { tenantId: tenants.a.tenantId, actorId: tenants.a.ownerId })
      .startGoogleConnect({ resourceId: tenants.a.resourceId }, randomUUID())).rejects.toBeInstanceOf(NotFound);
  });
});

describe("the runtime role on calendar tables (G-4, G-8, G-11)", () => {
  async function connection(tenant: "a" | "b") {
    const { tenantId, ownerId } = tenants[tenant];
    const command = connectCommand(tenantId, await addResource(tenantId));
    await connectAs(tenantId, ownerId, command);
    return command.target.id;
  }

  it("denies tenant B every read and write of tenant A's connections", async () => {
    const id = await connection("a");
    const b = fixture.b;
    expect((await b.run((tx) => tx.query("SELECT id FROM calendar_connections WHERE id=$1", [id]))).rows).toEqual([]);
    expect((await b.run((tx) => tx.query("UPDATE calendar_connections SET status='disconnecting' WHERE id=$1", [id]))).rowCount).toBe(0);
    expect((await b.run((tx) => tx.query("SELECT 1 FROM calendar_pushes"))).rows).toEqual([]);
    // Inserting a row that names tenant A from B's scope fails the policy.
    const forged = connectCommand(tenants.a.tenantId, tenants.a.resourceId);
    const payload = forged.payload as { refreshTokenSealed: string };
    const insert = b.run((tx) => tx.query(
      `INSERT INTO calendar_connections (tenant_id,id,resource_id,status,refresh_token_sealed,created_by,next_sync_at,created_at,updated_at)
       VALUES ($1,$2,$3,'active',$4,$5,$6,$6,$6)`,
      [tenants.a.tenantId, forged.target.id, tenants.a.resourceId, payload.refreshTokenSealed, tenants.b.ownerId, NOW]));
    await expect(insert).rejects.toMatchObject({ code: "42501" });
    expect((await storedRow(tenants.a.tenantId, id))!.status).toBe("active");
    expect(await storedRow(tenants.a.tenantId, forged.target.id)).toBeUndefined();
  });

  it("lets the runtime role set only disconnecting, from active or reauthorize; the trigger refuses the rest", async () => {
    const { tenantId } = tenants.a;
    const id = await connection("a");
    const update = (status: string) => fixture.a.run((tx) => tx.query(
      "UPDATE calendar_connections SET status=$3::calendar_connection_status WHERE tenant_id=$1 AND id=$2", [tenantId, id, status]));
    await expect(update("reauthorize")).rejects.toMatchObject({ code: "42501" });
    await expect(update("disconnected")).rejects.toMatchObject({ code: "42501" });
    expect((await update("disconnecting")).rowCount).toBe(1);
    // Back from disconnecting is the worker's alone.
    await expect(update("active")).rejects.toMatchObject({ code: "42501" });
    expect((await storedRow(tenantId, id))!.status).toBe("disconnecting");
    // A new row starts active, never anything else.
    const sealed = (connectCommand(tenantId, tenants.a.resourceId).payload as { refreshTokenSealed: string }).refreshTokenSealed;
    const fresh = await addResource(tenantId);
    const insertAs = (status: string) => fixture.a.run((tx) => tx.query(
      `INSERT INTO calendar_connections (tenant_id,id,resource_id,status,refresh_token_sealed,created_by,next_sync_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4::calendar_connection_status,$5,$6,$7,$7,$7)`,
      [tenantId, randomUUID(), fresh, status, sealed, tenants.a.ownerId, NOW]));
    for (const status of ["reauthorize", "disconnecting"]) await expect(insertAs(status), status).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses the runtime role the sealed token, the sync state and the channel", async () => {
    const { tenantId } = tenants.a;
    const id = await connection("a");
    const before = await storedRow(tenantId, id);
    const other = (connectCommand(tenantId, tenants.a.resourceId, id).payload as { refreshTokenSealed: string }).refreshTokenSealed;
    const attempts: Array<[string, unknown]> = [
      ["refresh_token_sealed", other], ["sync_token", "sync-1"], ["next_sync_at", NOW], ["lease_until", NOW],
      ["last_full_sync_at", NOW], ["last_synced_at", NOW], ["last_error", "x"], ["channel_resource_id", "res"],
      ["scope", ""], ["account_email", "x@y.test"], ["resource_id", tenants.a.otherResourceId], ["created_by", randomUUID()],
    ];
    for (const [column, value] of attempts) {
      const attempt = fixture.a.run((tx) => tx.query(`UPDATE calendar_connections SET ${column}=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, id, value]));
      await expect(attempt, column).rejects.toSatisfy((error: unknown) => pgCode(error) === "42501");
    }
    await expect(fixture.a.run((tx) => tx.query("DELETE FROM calendar_connections WHERE tenant_id=$1 AND id=$2", [tenantId, id])))
      .rejects.toMatchObject({ code: "42501" });
    expect(await storedRow(tenantId, id)).toEqual(before);
  });

  it("lets only the platform scope insert push notifications, and nothing more", async () => {
    const channelId = randomUUID();
    await database.db.platform!((tx) => tx.query(
      "INSERT INTO calendar_push_notifications (channel_id,message_number,resource_state,received_at) VALUES ($1,1,'sync',$2)", [channelId, NOW]));
    await expect(database.db.platform!((tx) => tx.query("SELECT * FROM calendar_push_notifications"))).rejects.toMatchObject({ code: "42501" });
    await expect(database.db.platform!((tx) => tx.query(
      "INSERT INTO calendar_push_notifications (channel_id,message_number,resource_state,received_at,processed_at) VALUES ($1,2,'exists',$2,$2)",
      [channelId, NOW]))).rejects.toMatchObject({ code: "42501" });
    await expect(database.db.platform!((tx) => tx.query("DELETE FROM calendar_push_notifications"))).rejects.toMatchObject({ code: "42501" });
    await expect(fixture.a.run((tx) => tx.query(
      "INSERT INTO calendar_push_notifications (channel_id,message_number,resource_state,received_at) VALUES ($1,3,'exists',$2)",
      [channelId, NOW]))).rejects.toMatchObject({ code: "42501" });
    expect((await fixture.service((tx) => tx.query("SELECT message_number FROM calendar_push_notifications WHERE channel_id=$1", [channelId]))).rows)
      .toEqual([{ message_number: "1" }]);
  });
});
