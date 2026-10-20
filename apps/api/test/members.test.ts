import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiErrorBodySchema,
  meResponseSchema,
  memberListSchema,
  memberOutputSchema,
  permissionSchema,
  removeMemberOutputSchema,
  roleCan,
} from "@zs/contracts";
import { endAuthSession, startAuthSession } from "@zs/db/testing";
import { call, signedInMember, tokenFor, createApiHarness, type ApiHarness, type MemberSetup } from "./helpers.js";

let h: ApiHarness;
beforeAll(async () => { h = await createApiHarness(); });
afterAll(async () => { await h?.close(); });

const staffOf = (tenantId: string) => signedInMember(h.database, h.fixture, tenantId, "staff");
const errorOf = (response: { body: unknown }) => apiErrorBodySchema.parse(response.body).error;
const invite = (token: string, email: string, role: "owner" | "staff" = "staff", key = randomUUID()) =>
  call(h.app, "POST", "/v1/members", { token, key, body: { email, role } });
const changeRole = (token: string, memberId: string, role: "owner" | "staff") =>
  call(h.app, "POST", `/v1/members/${memberId}/role`, { token, key: randomUUID(), body: { role } });
const remove = (token: string, memberId: string, key = randomUUID()) =>
  call(h.app, "DELETE", `/v1/members/${memberId}`, { token, key });
const createContact = (token: string, email: string, key: string = randomUUID()) =>
  call(h.app, "POST", "/v1/crm/contacts", { token, key, body: { displayName: "Ada", email } });
const expectForbidden = (response: { status: number; body: unknown }) => {
  expect(response.status).toBe(403);
  expect(errorOf(response).code).toBe("Forbidden");
};
const expectSessionEnded = (response: { status: number; body: unknown }) => {
  expect(response.status).toBe(401);
  expect(errorOf(response)).toMatchObject({ code: "Unauthorized", message: "Session has ended" });
};

describe("role permissions", () => {
  it("gives owners everything and staff calendar, customers and inbox drafts only", () => {
    const staff = permissionSchema.options.filter((permission) => roleCan("staff", permission));
    expect(staff).toEqual(["calendar", "customers", "inbox.drafts"]);
    for (const permission of permissionSchema.options) expect(roleCan("owner", permission)).toBe(true);
  });

  it("reports the caller's own membership on /v1/me", async () => {
    const staff = await staffOf(h.a.tenantId);
    expect(meResponseSchema.parse((await call(h.app, "GET", "/v1/me", { token: h.a.token })).body)).toEqual({
      tenantId: h.a.tenantId, userId: h.a.actorId, memberId: h.a.memberId, role: "owner",
      permissions: ["calendar", "customers", "inbox.drafts", "members", "billing", "plan", "publish", "intake", "approve", "reports", "integrations", "agents"],
    });
    expect(meResponseSchema.parse((await call(h.app, "GET", "/v1/me", { token: staff.token })).body)).toMatchObject({
      memberId: staff.memberId, role: "staff", permissions: ["calendar", "customers", "inbox.drafts"],
    });
  });

  it("lets staff work the calendar and customers", async () => {
    const staff = await staffOf(h.a.tenantId);
    for (const path of ["/v1/crm/contacts", "/v1/crm/deals", "/v1/crm/pipelines", "/v1/booking/bookings", "/v1/booking/resources"])
      expect((await call(h.app, "GET", path, { token: staff.token })).status, path).toBe(200);
    expect((await createContact(staff.token, `${randomUUID()}@example.com`)).status).toBe(201);
    expect((await call(h.app, "POST", "/v1/booking/bookings", {
      token: staff.token, key: randomUUID(), body: { resourceId: h.a.resourceId, startsAt: "2026-10-19T14:00:00.000Z" },
    })).status).toBe(201);
  });

  it("refuses staff every member operation, including escalation attempts", async () => {
    const staff = await staffOf(h.a.tenantId);
    expectForbidden(await call(h.app, "GET", "/v1/members", { token: staff.token }));
    expectForbidden(await invite(staff.token, `${randomUUID()}@example.com`));
    expectForbidden(await invite(staff.token, `${randomUUID()}@example.com`, "owner"));
    // Promote itself, demote or remove the owner, remove itself.
    expectForbidden(await changeRole(staff.token, staff.memberId, "owner"));
    expectForbidden(await changeRole(staff.token, h.a.memberId, "staff"));
    expectForbidden(await remove(staff.token, h.a.memberId));
    expectForbidden(await remove(staff.token, staff.memberId));
    const members = memberListSchema.parse((await call(h.app, "GET", "/v1/members", { token: h.a.token })).body);
    expect(members.items.find((member) => member.id === staff.memberId)).toMatchObject({ role: "staff", status: "active" });
    expect(members.items.find((member) => member.id === h.a.memberId)).toMatchObject({ role: "owner", status: "active" });
    const actions = await h.database.pool.query(
      "SELECT 1 FROM actions WHERE tenant_id=$1 AND actor_id=$2 AND action_type LIKE 'member.%'", [h.a.tenantId, staff.actorId],
    );
    expect(actions.rowCount).toBe(0);
  });
});

describe("owner member management", () => {
  it("invites, lists, changes the role of and removes a member", async () => {
    const email = `New.Hire+${randomUUID().slice(0, 6)}@Example.com`;
    const key = randomUUID();
    const invited = await invite(h.a.token, email, "staff", key);
    expect(invited.status).toBe(201);
    const output = memberOutputSchema.parse(invited.body);
    const record = output.result;
    expect(record).toMatchObject({ tenantId: h.a.tenantId, email: email.toLowerCase(), role: "staff", status: "invited", userId: null });
    // The same key replays the stored result.
    const replay = await invite(h.a.token, email, "staff", key);
    expect(replay.status).toBe(201);
    expect(memberOutputSchema.parse(replay.body)).toEqual(output);

    const duplicate = await invite(h.a.token, email.toUpperCase());
    expect(duplicate.status).toBe(409);
    expect(errorOf(duplicate).details).toEqual({ reason: "member_exists" });

    const list = memberListSchema.parse((await call(h.app, "GET", "/v1/members", { token: h.a.token })).body);
    expect(list.items.map((member) => member.id)).toContain(record.id);
    for (const member of list.items) expect(member.tenantId).toBe(h.a.tenantId);

    const promoted = memberOutputSchema.parse((await changeRole(h.a.token, record.id, "owner")).body);
    expect(promoted.result).toMatchObject({ id: record.id, role: "owner" });
    const removed = await remove(h.a.token, record.id);
    expect(removeMemberOutputSchema.parse(removed.body).result).toEqual({ id: record.id, removed: true });
    const after = memberListSchema.parse((await call(h.app, "GET", "/v1/members", { token: h.a.token })).body);
    expect(after.items.map((member) => member.id)).not.toContain(record.id);
  });

  it("never lets a business lose its last active owner", async () => {
    const { tenantId } = await h.fixture.service(async (tx) => {
      const id = randomUUID();
      await tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Solo')", [id]);
      return { tenantId: id };
    });
    const owner = await signedInMember(h.database, h.fixture, tenantId, "owner");
    // A pending owner invite does not count: it may never be accepted.
    expect((await invite(owner.token, `${randomUUID()}@example.com`, "owner")).status).toBe(201);
    for (const response of [await changeRole(owner.token, owner.memberId, "staff"), await remove(owner.token, owner.memberId)]) {
      expect(response.status).toBe(409);
      expect(errorOf(response).details).toEqual({ reason: "last_owner" });
    }
    // With a second active owner, the first may step down; the demotion takes effect at once.
    const second = await signedInMember(h.database, h.fixture, tenantId, "owner");
    expect((await changeRole(owner.token, owner.memberId, "staff")).status).toBe(200);
    expectForbidden(await call(h.app, "GET", "/v1/members", { token: owner.token }));
    expectForbidden(await invite(owner.token, `${randomUUID()}@example.com`));
    expect((await call(h.app, "GET", "/v1/crm/contacts", { token: owner.token })).status).toBe(200);
    expect((await remove(second.token, owner.memberId)).status).toBe(200);
  });

  it("serializes concurrent demotions so a business never ends up without an owner", async () => {
    const tenantId = await h.fixture.service(async (tx) => {
      const id = randomUUID();
      await tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Pair')", [id]);
      return id;
    });
    const [first, second] = [await signedInMember(h.database, h.fixture, tenantId, "owner"),
      await signedInMember(h.database, h.fixture, tenantId, "owner")];
    const responses = await Promise.all([changeRole(first.token, second.memberId, "staff"), changeRole(second.token, first.memberId, "staff")]);
    // One demotion wins; the loser is no longer an owner when its own check runs.
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
    const owners = await h.database.pool.query("SELECT 1 FROM tenant_members WHERE tenant_id=$1 AND role='owner'", [tenantId]);
    expect(owners.rowCount).toBe(1);
  });

  it("keeps the membership lock apart from idempotency locks, even for the key \"members\"", async () => {
    // Were they one lock, each request would take it shared for the role check, then wait to
    // take it exclusively for the key: concurrent requests would deadlock and one would fail.
    for (let round = 0; round < 5; round += 1) {
      const tenantId = await h.fixture.service(async (tx) => {
        const id = randomUUID();
        await tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Keys')", [id]);
        return id;
      });
      const owner = await signedInMember(h.database, h.fixture, tenantId, "owner");
      const responses = await Promise.all([0, 1, 2].map(() => createContact(owner.token, "keys@example.com", "members")));
      // One creates the contact; the others wait for its key and replay it.
      expect(responses.map((response) => response.status), `round ${round}`).toEqual([201, 201, 201]);
    }
  });

  it("cannot reach another tenant's members", async () => {
    const staffB = await staffOf(h.b.tenantId);
    expectForbidden(await changeRole(h.a.token, staffB.memberId, "owner"));
    expectForbidden(await remove(h.a.token, staffB.memberId));
    expectForbidden(await changeRole(h.a.token, randomUUID(), "owner"));
    const list = memberListSchema.parse((await call(h.app, "GET", "/v1/members", { token: h.a.token })).body);
    expect(list.items.map((member) => member.id)).not.toContain(staffB.memberId);
    const listB = memberListSchema.parse((await call(h.app, "GET", "/v1/members", { token: h.b.token })).body);
    expect(listB.items.map((member) => member.id).sort()).toEqual([h.b.memberId, staffB.memberId].sort());
  });
});

describe("membership is checked on every request", () => {
  it("refuses a removed member at once, including replays of earlier writes", async () => {
    const staff = await staffOf(h.a.tenantId);
    const key = randomUUID();
    const email = `${randomUUID()}@example.com`;
    expect((await createContact(staff.token, email, key)).status).toBe(201);
    expect((await remove(h.a.token, staff.memberId)).status).toBe(200);
    // The token and its session are still valid; the membership is gone.
    expectForbidden(await call(h.app, "GET", "/v1/crm/contacts", { token: staff.token }));
    expectForbidden(await call(h.app, "GET", "/v1/me", { token: staff.token }));
    expectForbidden(await createContact(staff.token, email, key));
  });

  it("refuses a signed-in user with no membership, or a pending invite only", async () => {
    const stranger = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff", { membership: false });
    expectForbidden(await call(h.app, "GET", "/v1/crm/contacts", { token: stranger.token }));
    // An invite for the same email has no user_id until the invite worker binds it.
    expect((await invite(h.a.token, stranger.email)).status).toBe(201);
    expectForbidden(await call(h.app, "GET", "/v1/crm/contacts", { token: stranger.token }));
  });

  it("refuses a member of one tenant who claims another", async () => {
    const claimingB = await tokenFor({ ...h.a, tenantId: h.b.tenantId });
    expectForbidden(await call(h.app, "GET", "/v1/crm/contacts", { token: claimingB }));
    expectForbidden(await call(h.app, "GET", "/v1/me", { token: claimingB }));
  });
});

describe("session liveness", () => {
  const signedInStaff = async (): Promise<MemberSetup> => staffOf(h.a.tenantId);

  it("refuses a token at once after its session signs out", async () => {
    const staff = await signedInStaff();
    expect((await call(h.app, "GET", "/v1/crm/contacts", { token: staff.token })).status).toBe(200);
    await endAuthSession(h.database.pool, staff.sessionId);
    expectSessionEnded(await call(h.app, "GET", "/v1/crm/contacts", { token: staff.token }));
    expectSessionEnded(await createContact(staff.token, `${randomUUID()}@example.com`));
    // A new sign-in works; the old token stays dead.
    const sessionId = await startAuthSession(h.database.pool, staff.actorId);
    expect((await call(h.app, "GET", "/v1/crm/contacts", { token: await tokenFor({ ...staff, sessionId }) })).status).toBe(200);
    expectSessionEnded(await call(h.app, "GET", "/v1/crm/contacts", { token: staff.token }));
  });

  it("ends only the signed-out session: the same person's other devices stay signed in", async () => {
    const staff = await signedInStaff();
    const laptop = await tokenFor({ ...staff, sessionId: await startAuthSession(h.database.pool, staff.actorId) });
    await endAuthSession(h.database.pool, staff.sessionId);
    expectSessionEnded(await call(h.app, "GET", "/v1/me", { token: staff.token }));
    expect((await call(h.app, "GET", "/v1/me", { token: laptop })).status).toBe(200);
    expect((await createContact(laptop, `${randomUUID()}@example.com`)).status).toBe(201);
  });

  it("refuses a session past not_after, an unknown session and another user's session", async () => {
    const staff = await signedInStaff();
    const other = await signedInStaff();
    const expired = await startAuthSession(h.database.pool, staff.actorId, { notAfter: new Date("2026-10-19T07:59:59.000Z") });
    expectSessionEnded(await call(h.app, "GET", "/v1/me", { token: await tokenFor({ ...staff, sessionId: expired }) }));
    const later = await startAuthSession(h.database.pool, staff.actorId, { notAfter: new Date("2026-10-19T08:00:01.000Z") });
    expect((await call(h.app, "GET", "/v1/me", { token: await tokenFor({ ...staff, sessionId: later }) })).status).toBe(200);
    expectSessionEnded(await call(h.app, "GET", "/v1/me", { token: await tokenFor({ ...staff, sessionId: randomUUID() }) }));
    expectSessionEnded(await call(h.app, "GET", "/v1/me", { token: await tokenFor({ ...staff, sessionId: other.sessionId }) }));
  });

  it("refuses a banned or deleted user", async () => {
    for (const column of ["banned_until", "deleted_at"]) {
      const staff = await signedInStaff();
      await h.database.pool.query(`UPDATE auth.users SET ${column} = $2 WHERE id = $1`,
        [staff.actorId, column === "banned_until" ? "2026-10-20T00:00:00Z" : "2026-10-19T07:00:00Z"]);
      expectSessionEnded(await call(h.app, "GET", "/v1/me", { token: staff.token }));
    }
  });
});
