// outreach-sequencer.md OS-1, OS-3, OS-4, OS-7, OS-8, OS-9 against a real local Postgres, through the owner session and
// the operator principal. No Gmail is involved: these are the owner's actions, not the worker's.
import { randomUUID } from "node:crypto";
import { NotFound, TenantDenied, ValidationFailed, OUTREACH_ERROR_CODES } from "@zs/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OUTREACH_CAMPAIGN_ACTIVATE_ACTION, OUTREACH_CAMPAIGN_TARGET } from "@zs/contracts";
import { createOutreachOperator } from "../../src/edge/outreach-session.js";
import { directDispatch, memberAuthorize } from "../../src/edge/session.js";
import { createWorld, campaignBody, prospect, type World } from "./harness.js";

let world: World;
let tenantA: string;
let tenantB: string;
let ownerA: string;
let staffA: string;
let ownerB: string;
let boxes: [string, string];

beforeAll(async () => { world = await createWorld(); });
afterAll(async () => { await world?.close(); });
beforeEach(async () => {
  tenantA = await world.tenant("Tenant A");
  tenantB = await world.tenant("Tenant B");
  ownerA = await world.member(tenantA, "owner");
  staffA = await world.member(tenantA, "staff");
  ownerB = await world.member(tenantB, "owner");
  boxes = [
    await world.mailbox(tenantA, "devin@zerosum-solutions.com", { displayName: "Devin" }),
    await world.mailbox(tenantA, "devin.wiggins@zerosum-solutions.com", { displayName: "Devin Wiggins" }),
  ];
});

const owner = () => world.owner(tenantA, ownerA, [tenantA]);
const campaign = async (change: Record<string, unknown> = {}) => (await owner().createCampaign(campaignBody(boxes, change), randomUUID())).result;
const imported = (id: string, rows: unknown[]) => owner().importProspects(id, { prospects: rows }, randomUUID());
const prospectRows = (id: string) => world.rows("SELECT email, status, mailbox_id, next_step, to_char(next_due_on,'YYYY-MM-DD') AS next_due_on FROM outreach_prospects WHERE tenant_id=$1 AND campaign_id=$2 ORDER BY email", [tenantA, id]);

/** Request activation as the owner, approve it, and return the approval's execution. */
async function activate(id: string, session = world.member_session(tenantA, ownerA, [tenantA])) {
  const { approvalId } = await owner().requestActivation(id, randomUUID());
  return session.approveApproval(approvalId, {}, randomUUID());
}

describe("access (OS-1)", () => {
  it("answers NotFound for a tenant outside the allowlist, before any permission check", async () => {
    const outsider = world.owner(tenantB, ownerB, [tenantA]);
    await expect(outsider.listCampaigns()).rejects.toBeInstanceOf(NotFound);
    await expect(outsider.listMailboxes()).rejects.toBeInstanceOf(NotFound);
    await expect(outsider.createCampaign(campaignBody(boxes), randomUUID())).rejects.toBeInstanceOf(NotFound);
    const empty = world.owner(tenantA, ownerA, []);
    await expect(empty.listCampaigns()).rejects.toBeInstanceOf(NotFound);
  });

  it("refuses staff with TenantDenied on every route and action", async () => {
    const staff = world.owner(tenantA, staffA, [tenantA]);
    await expect(staff.listCampaigns()).rejects.toBeInstanceOf(TenantDenied);
    await expect(staff.createCampaign(campaignBody(boxes), randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    const made = await campaign();
    await expect(staff.requestActivation(made.id, randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    await expect(staff.pauseCampaign(made.id, randomUUID())).rejects.toBeInstanceOf(TenantDenied);
  });

  it("lets nobody see another tenant's campaign, prospect or mailbox", async () => {
    const made = await campaign();
    await imported(made.id, [prospect(1)]);
    const prospectId = (await world.rows<{ id: string }>("SELECT id FROM outreach_prospects WHERE tenant_id=$1", [tenantA]))[0]!.id;
    const intruder = world.owner(tenantB, ownerB, [tenantA, tenantB]);
    await expect(intruder.getCampaign(made.id)).rejects.toBeInstanceOf(NotFound);
    await expect(intruder.listProspects(made.id, {})).rejects.toBeInstanceOf(NotFound);
    await expect(intruder.pauseCampaign(made.id, randomUUID())).rejects.toBeInstanceOf(NotFound);
    await expect(intruder.stopProspect(prospectId, randomUUID())).rejects.toBeInstanceOf(NotFound);
    await expect(intruder.requestActivation(made.id, randomUUID())).rejects.toBeInstanceOf(NotFound);
    await expect(intruder.importProspects(made.id, { prospects: [prospect(2)] }, randomUUID())).rejects.toBeInstanceOf(NotFound);
    expect((await intruder.listCampaigns()).items).toEqual([]);
    expect((await intruder.listMailboxes()).items).toEqual([]);
  });

  it("refuses an outreach action in a dispatcher built without the allowlist, including an approved one", async () => {
    const made = await campaign();
    await imported(made.id, [prospect(1)]);
    const { approvalId } = await owner().requestActivation(made.id, randomUUID());
    // The approving session carries no allowlist: the approved run is refused and the campaign stays a draft.
    await expect(world.member_session(tenantA, ownerA, []).approveApproval(approvalId, {}, randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    expect((await owner().getCampaign(made.id)).campaign.status).toBe("draft");
  });
});

describe("mailboxes (OS-3)", () => {
  it("connects as active, lists without a token or cursor, and a reconnect replaces the token and sets active", async () => {
    const listed = (await owner().listMailboxes()).items;
    expect(listed.map((m) => [m.email, m.status, m.dailyLimit, m.sendsToday])).toEqual([
      ["devin.wiggins@zerosum-solutions.com", "active", 20, 0], ["devin@zerosum-solutions.com", "active", 20, 0]]);
    expect(JSON.stringify(listed)).not.toMatch(/zsg1|sealed|history|lease/);
    // The worker's word: reauthorize.
    await world.rows("UPDATE outreach_mailboxes SET status='reauthorize' WHERE tenant_id=$1 AND id=$2", [tenantA, boxes[0]]);
    const before = (await world.rows<{ t: string }>("SELECT sealed_refresh_token AS t FROM outreach_mailboxes WHERE tenant_id=$1 AND id=$2", [tenantA, boxes[0]]))[0]!.t;
    expect(await world.mailbox(tenantA, "devin@zerosum-solutions.com", { displayName: "Devin D", dailyLimit: 10 })).toBe(boxes[0]);
    const after = (await world.rows<{ t: string; status: string; display_name: string; daily_limit: number }>(
      "SELECT sealed_refresh_token AS t, status, display_name, daily_limit FROM outreach_mailboxes WHERE tenant_id=$1 AND id=$2", [tenantA, boxes[0]]))[0]!;
    expect(after).toMatchObject({ status: "active", display_name: "Devin D", daily_limit: 10 });
    expect(after.t).not.toBe(before);
    expect(await world.rows("SELECT 1 FROM outreach_mailboxes WHERE tenant_id=$1", [tenantA])).toHaveLength(2);
  });

  it("disconnect clears the token and sets disconnected; the operator may run nothing else", async () => {
    await world.disconnect(tenantA, boxes[1]);
    expect((await world.rows("SELECT status, sealed_refresh_token FROM outreach_mailboxes WHERE tenant_id=$1 AND id=$2", [tenantA, boxes[1]]))[0])
      .toEqual({ status: "disconnected", sealed_refresh_token: null });
    // A reconnect brings it back.
    await world.mailbox(tenantA, "devin.wiggins@zerosum-solutions.com");
    expect((await world.rows<{ status: string }>("SELECT status FROM outreach_mailboxes WHERE tenant_id=$1 AND id=$2", [tenantA, boxes[1]]))[0]!.status).toBe("active");
  });

  it("clears a pause on reconnect, replays a retried connect, and refuses a token sealed to another mailbox id", async () => {
    await world.rows("UPDATE outreach_mailboxes SET paused_until='9999-12-31T00:00:00Z', pause_reason='history_gap' WHERE tenant_id=$1 AND id=$2", [tenantA, boxes[0]]);
    await world.mailbox(tenantA, "devin@zerosum-solutions.com");
    expect((await world.rows("SELECT paused_until, pause_reason FROM outreach_mailboxes WHERE tenant_id=$1 AND id=$2", [tenantA, boxes[0]]))[0])
      .toEqual({ paused_until: null, pause_reason: null });
    // The same command twice (a lost answer, then a retry) is one result: the approval reference is derived from the key.
    const sealed = (await world.rows<{ t: string }>("SELECT sealed_refresh_token AS t FROM outreach_mailboxes WHERE tenant_id=$1 AND id=$2", [tenantA, boxes[0]]))[0]!.t;
    const operator = createOutreachOperator(world.deps([tenantA]), tenantA);
    const command = {
      mailboxId: boxes[0], email: "devin@zerosum-solutions.com", displayName: "Devin", dailyLimit: 20, sealedRefreshToken: sealed,
      grantedScopes: ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.metadata"], idempotencyKey: `outreach:mailbox:${boxes[0]}:retry-1`,
    };
    const first = await operator.connectMailbox(command);
    const second = await operator.connectMailbox(command);
    expect(second.result).toEqual(first.result);
    // A different id for a stored address would store a token the worker cannot open.
    await expect(operator.connectMailbox({ ...command, mailboxId: randomUUID(), idempotencyKey: `outreach:mailbox:${boxes[0]}:retry-2` }))
      .rejects.toMatchObject({ code: "Conflict" });
  });

  it("answers NotFound, not a validation error, to a malformed id from a tenant outside the allowlist", async () => {
    const outsider = world.owner(tenantB, ownerB, [tenantA]);
    await expect(outsider.getCampaign("not-a-uuid")).rejects.toBeInstanceOf(NotFound);
    await expect(outsider.listProspects("not-a-uuid", {})).rejects.toBeInstanceOf(NotFound);
  });

  it("refuses a connect for a tenant outside the allowlist", async () => {
    await expect(world.mailbox(tenantB, "x@zerosum-solutions.com", { allowed: [tenantA] })).rejects.toBeInstanceOf(TenantDenied);
    expect(await world.rows("SELECT 1 FROM outreach_mailboxes WHERE tenant_id=$1", [tenantB])).toHaveLength(0);
  });
});

describe("campaign create (OS-4, OS-5)", () => {
  it("creates a draft with its digest and steps, and a replay returns the same result", async () => {
    const key = randomUUID();
    const first = await owner().createCampaign(campaignBody(boxes), key);
    expect(first.result).toMatchObject({
      name: "Spring outreach", status: "draft", pausedReason: null, window: { start: "08:00", end: "10:30" }, dailyCapPerMailbox: 2,
      activationApprovalId: null, activatedAt: null, mailboxIds: [...boxes].sort(),
    });
    expect(first.result.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(await owner().createCampaign(campaignBody(boxes), key)).toEqual(first);
    expect(await world.rows("SELECT step_number, delay_business_days, subject FROM outreach_campaign_steps WHERE tenant_id=$1 AND campaign_id=$2 ORDER BY step_number",
      [tenantA, first.result.id])).toEqual([
      { step_number: 1, delay_business_days: 0, subject: "Quick idea for {{company}}" },
      { step_number: 2, delay_business_days: 3, subject: null },
      { step_number: 3, delay_business_days: 5, subject: null }]);
    // The same content in another campaign has the same digest (it binds content, not identity).
    expect((await campaign()).contentDigest).toBe(first.result.contentDigest);
    expect((await campaign({ dailyCapPerMailbox: 3 })).contentDigest).not.toBe(first.result.contentDigest);
    expect((await campaign({ dailyCapPerMailbox: undefined })).dailyCapPerMailbox).toBe(20);
  });

  const invalid: Array<[string, Record<string, unknown>, string]> = [
    ["no steps", { steps: [] }, "steps"],
    ["six steps", { steps: Array.from({ length: 6 }, (_, i) => i === 0 ? { subject: "s", body: "b", delayBusinessDays: 0 } : { body: "b", delayBusinessDays: 1 }) }, "steps"],
    ["a step 1 with a delay", { steps: [{ subject: "s", body: "b", delayBusinessDays: 1 }] }, "steps.0.delayBusinessDays"],
    ["a step 1 without a subject", { steps: [{ body: "b", delayBusinessDays: 0 }] }, "steps.0.subject"],
    ["a follow-up subject", { steps: [{ subject: "s", body: "b", delayBusinessDays: 0 }, { subject: "x", body: "b", delayBusinessDays: 1 }] }, "steps.1.subject"],
    ["a follow-up with no delay", { steps: [{ subject: "s", body: "b", delayBusinessDays: 0 }, { body: "b", delayBusinessDays: 0 }] }, "steps.1.delayBusinessDays"],
    ["a subject with a line break", { steps: [{ subject: "a\nb", body: "b", delayBusinessDays: 0 }] }, "steps.0.subject"],
    ["a window under 30 minutes", { window: { start: "08:00", end: "08:20" } }, "window.end"],
    ["a window that ends before it starts", { window: { start: "10:00", end: "09:00" } }, "window.end"],
    ["a cap of 0", { dailyCapPerMailbox: 0 }, "dailyCapPerMailbox"],
    ["a cap of 51", { dailyCapPerMailbox: 51 }, "dailyCapPerMailbox"],
    ["no mailboxes", { mailboxIds: [] }, "mailboxIds"],
    ["a repeated mailbox", { mailboxIds: [randomUUID(), "same"] }, "mailboxIds"],
    ["an unknown variable in the body", { steps: [{ subject: "s", body: "Hi {{name}}", delayBusinessDays: 0 }] }, "steps.0.body"],
    ["an unknown variable in the subject", { steps: [{ subject: "{{ company }}", body: "b", delayBusinessDays: 0 }] }, "steps.0.subject"],
    ["an unknown variable in a follow-up", { steps: [{ subject: "s", body: "b", delayBusinessDays: 0 }, { body: "{{first_name}} }}", delayBusinessDays: 1 }] }, "steps.1.body"],
  ];
  it.each(invalid)("refuses %s with the field's path", async (_label, change, path) => {
    const body = campaignBody(boxes, change);
    if (path === "mailboxIds" && (change.mailboxIds as string[]).length > 0) body.mailboxIds = [boxes[0], boxes[0]];
    const error = await owner().createCampaign(body, randomUUID()).then(() => null, (e: unknown) => e as ValidationFailed & { details: { issues: Array<{ path: string; message: string }> } });
    expect(error).toMatchObject({ code: "ValidationFailed" });
    expect(error!.details.issues.map((issue) => issue.path)).toContain(path);
    if (path.startsWith("steps") && /body|subject/.test(path) && _label.includes("unknown")) expect(error!.details.issues.find((i) => i.path === path)!.message).toBe("unknown_variable");
  });

  it("refuses a mailbox that is not this tenant's, and stores nothing", async () => {
    const other = await world.mailbox(tenantB, "b@zerosum-solutions.com", { allowed: [tenantB] });
    await expect(owner().createCampaign(campaignBody([boxes[0], other]), randomUUID())).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(await world.rows("SELECT 1 FROM outreach_campaigns WHERE tenant_id=$1", [tenantA])).toHaveLength(0);
  });
});

describe("prospect import (OS-7)", () => {
  it("returns each reason, stores only the good rows, and splits them evenly across the mailboxes", async () => {
    const made = await campaign();
    // A CRM contact whose email consent is denied, and a suppressed address.
    const contactId = randomUUID();
    await world.rows("INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,created_at,updated_at) VALUES ($1,$2,'No Mail','denied@acme9.example',now(),now())", [tenantA, contactId]);
    await world.rows("INSERT INTO crm_contact_consent (tenant_id,contact_id,channel,status,source,recorded_at) VALUES ($1,$2,'email','denied','test',now())", [tenantA, contactId]);
    await world.rows("INSERT INTO suppressions (tenant_id,channel,address,reason,source,created_at) VALUES ($1,'email','gone@acme8.example','unsubscribe','test',now())", [tenantA]);
    const result = await imported(made.id, [
      prospect(1), prospect(2), prospect(3), prospect(4),
      prospect(5, { company: "Broken English Jewelry" }),
      prospect(6, { email: "gone@acme8.example" }),
      prospect(7, { email: "denied@acme9.example" }),
      prospect(1, { firstName: "Again" }),
      prospect(8, { email: "postmaster@acme10.example" }),
      prospect(9, { industry: "" }),
      prospect(10, { email: "not-an-email" }),
      prospect(11, { mailboxId: randomUUID() }),
    ]);
    expect(result.result).toEqual({
      imported: 4, excluded: 0,
      rejected: [
        { index: 4, reason: "hard_suppressed" }, { index: 5, reason: "suppressed" }, { index: 6, reason: "consent_denied" },
        { index: 7, reason: "duplicate" }, { index: 8, reason: "role_address" }, { index: 9, reason: "missing_field" },
        { index: 10, reason: "invalid_email" }, { index: 11, reason: "mailbox_not_in_campaign" },
      ],
    });
    for (const { reason } of result.result.rejected) expect(OUTREACH_ERROR_CODES).toContain(reason);
    const stored = await prospectRows(made.id);
    expect(stored.map((row) => row.email)).toEqual(["pat1@acme1.example", "pat2@acme2.example", "pat3@acme3.example", "pat4@acme4.example"]);
    expect(stored.every((row) => row.status === "pending" && row.next_step === null)).toBe(true);
    const perMailbox = new Map<string, number>();
    for (const row of stored) perMailbox.set(row.mailbox_id, (perMailbox.get(row.mailbox_id) ?? 0) + 1);
    expect([...perMailbox.values()]).toEqual([2, 2]);
  });

  it("asks for only the fields the campaign's variables use, takes a named mailbox, and reserves an excluded address", async () => {
    const plain = await campaign({ steps: [{ subject: "Hello", body: "A note.", delayBusinessDays: 0 }] });
    const result = await imported(plain.id, [
      prospect(1, { firstName: "", company: "", industry: undefined, mailboxId: boxes[1] }),
      { email: "excluded@acme2.example", firstName: "", company: "", excluded: true },
      { email: "excluded@acme2.example", firstName: "", company: "", excluded: true },
      { email: "postmaster@acme3.example", firstName: "", company: "", excluded: true },
      { email: "denied-excluded@acme4.example", firstName: "", company: "Broken English", excluded: true },
    ]);
    expect(result.result).toEqual({ imported: 1, excluded: 3, rejected: [{ index: 2, reason: "duplicate" }] });
    const stored = await prospectRows(plain.id);
    expect(stored.find((row) => row.email === "pat1@acme1.example")!.mailbox_id).toBe(boxes[1]);
    expect(stored.filter((row) => row.status === "excluded")).toHaveLength(3);
    // The address stays reserved for the tenant: another campaign cannot import it.
    const other = await campaign();
    expect((await imported(other.id, [prospect(2, { email: "excluded@acme2.example" })])).result.rejected).toEqual([{ index: 0, reason: "duplicate" }]);
  });

  it("takes an opener, needs one when the campaign uses {{opener}}, and bounds it (OS-5, OS-7)", async () => {
    const made = await campaign({ steps: [{ subject: "Hi {{first_name}}", body: "{{opener}}\n\nWorth a chat?", delayBusinessDays: 0 }] });
    const result = await imported(made.id, [
      prospect(1, { opener: "  Loved your talk on wholesale pricing.  " }),
      prospect(2),
      prospect(3, { opener: "   " }),
      prospect(4, { opener: "{{company}} just opened a store." }),
      { email: "ex@acme5.example", firstName: "", company: "", opener: "ignored", excluded: true },
    ]);
    expect(result.result).toEqual({ imported: 2, excluded: 1, rejected: [{ index: 1, reason: "missing_field" }, { index: 2, reason: "missing_field" }] });
    const stored = await world.rows<{ email: string; opener: string | null }>("SELECT email, opener FROM outreach_prospects WHERE tenant_id=$1 ORDER BY email", [tenantA]);
    expect(stored.map((row) => [row.email, row.opener])).toEqual([
      ["ex@acme5.example", null], ["pat1@acme1.example", "Loved your talk on wholesale pricing."], ["pat4@acme4.example", "{{company}} just opened a store."],
    ]);
    // 300 characters is the longest opener; 301, CR and LF fail the call, name the row, and store nothing.
    const other = await campaign({ steps: [{ subject: "Hi {{first_name}}", body: "{{opener}}", delayBusinessDays: 0 }] });
    expect((await imported(other.id, [prospect(6, { opener: "o".repeat(300) })])).result.imported).toBe(1);
    for (const opener of ["o".repeat(301), "line one\nline two", "line one\rline two"])
      await expect(imported(other.id, [prospect(7), prospect(8, { opener })])).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(await world.rows("SELECT 1 FROM outreach_prospects WHERE tenant_id=$1 AND email IN ('pat7@acme7.example','pat8@acme8.example')", [tenantA])).toHaveLength(0);
    // A campaign that does not use {{opener}} accepts rows with or without one and still stores it.
    const plain = await campaign();
    expect((await imported(plain.id, [prospect(9), prospect(10, { opener: "A line." })])).result.imported).toBe(2);
    // The prospect record carries it.
    const listed = await owner().listProspects(plain.id, {});
    expect(listed.items.map((item: { opener: string | null }) => item.opener ?? "none").sort()).toEqual(["A line.", "none"]);
  });

  it("refuses an opener with CR or LF, or over 300 characters, in the database itself (OS-7)", async () => {
    const made = await campaign();
    await imported(made.id, [prospect(1)]);
    for (const opener of ["a\nb", "a\rb", "", "o".repeat(301)])
      await expect(world.rows("UPDATE outreach_prospects SET opener=$2 WHERE tenant_id=$1", [tenantA, opener])).rejects.toThrow(/outreach_prospects_opener/);
  });

  it("derives the prospect id from the address and refuses an import into an active campaign", async () => {
    const made = await campaign();
    await imported(made.id, [prospect(1)]);
    const row = (await world.rows<{ id: string }>("SELECT id FROM outreach_prospects WHERE tenant_id=$1", [tenantA]))[0]!;
    const { derivedId } = await import("../../src/index.js");
    expect(row.id).toBe(derivedId(tenantA, "outreach-prospect", "pat1@acme1.example"));
    expect((await activate(made.id)).execution.result).toMatchObject({ status: "active" });
    await expect(imported(made.id, [prospect(2)])).rejects.toMatchObject({ code: "Conflict", details: { reason: "campaign_active" } });
    expect(await prospectRows(made.id)).toHaveLength(1);
  });

  it("keeps the 500-row and 5,000-prospect limits", async () => {
    const made = await campaign();
    await expect(imported(made.id, Array.from({ length: 501 }, (_, i) => prospect(i)))).rejects.toMatchObject({ code: "ValidationFailed" });
    await world.rows(
      `INSERT INTO outreach_prospects (tenant_id,id,campaign_id,mailbox_id,email,first_name,company,created_at,updated_at)
       SELECT $1, gen_random_uuid(), $2, $3, 'bulk' || n || '@bulk.example', 'B', 'C', now(), now() FROM generate_series(1, 4999) n`, [tenantA, made.id, boxes[0]]);
    await expect(imported(made.id, [prospect(1), prospect(2)])).rejects.toMatchObject({ code: "ValidationFailed" });
    expect((await imported(made.id, [prospect(1)])).result.imported).toBe(1);
  });

  it("counts the rows it keeps against the 5,000, not the rows it was sent", async () => {
    const made = await campaign();
    await world.rows(
      `INSERT INTO outreach_prospects (tenant_id,id,campaign_id,mailbox_id,email,first_name,company,created_at,updated_at)
       SELECT $1, gen_random_uuid(), $2, $3, 'bulk' || n || '@bulk.example', 'B', 'C', now(), now() FROM generate_series(1, 4999) n`, [tenantA, made.id, boxes[0]]);
    const result = (await imported(made.id, [{ email: "not-an-email", firstName: "X", company: "Y" }, { ...prospect(2), email: "bulk1@bulk.example" }, prospect(1)])).result;
    expect(result.imported).toBe(1);
    expect(result.rejected).toHaveLength(2);
  });
});

describe("activation (OS-8)", () => {
  let from = 0;
  async function ready(count = 4) {
    const made = await campaign();
    const start = from;
    from += count;
    await imported(made.id, Array.from({ length: count }, (_, i) => prospect(start + i + 1 + (start > 0 ? 100 : 0))));
    return made;
  }

  it("is TenantDenied by direct dispatch and for staff, and an approved run makes the campaign active", async () => {
    const made = await ready();
    const payload = { campaignId: made.id, contentDigest: made.contentDigest, prospectsDigest: "0".repeat(64), prospectCount: 4 };
    const direct = directDispatch(world.deps([tenantA]), tenantA, ownerA, memberAuthorize(tenantA, ownerA), { outreach: { tenants: [tenantA] } });
    await expect(direct({
      actionType: OUTREACH_CAMPAIGN_ACTIVATE_ACTION, target: { tenantId: tenantA, type: OUTREACH_CAMPAIGN_TARGET, id: made.id },
      approvalReference: { tenantId: tenantA, id: randomUUID() }, idempotencyKey: randomUUID(), payload,
    })).rejects.toBeInstanceOf(TenantDenied);
    await expect(world.owner(tenantA, staffA, [tenantA]).requestActivation(made.id, randomUUID())).rejects.toBeInstanceOf(TenantDenied);

    const key = randomUUID();
    const { approvalId } = await owner().requestActivation(made.id, key);
    expect((await owner().requestActivation(made.id, key)).approvalId).toBe(approvalId);
    const approval = (await world.rows<{ status: string; summary: string; action_type: string; payload: Record<string, unknown> }>(
      "SELECT status, summary, action_type, payload FROM approvals WHERE tenant_id=$1 AND id=$2", [tenantA, approvalId]))[0]!;
    expect(approval).toMatchObject({ status: "pending", action_type: OUTREACH_CAMPAIGN_ACTIVATE_ACTION });
    expect(approval.summary).toContain("Spring outreach");
    expect(approval.summary).toContain("4 prospects");
    expect(approval.summary).toContain("devin@zerosum-solutions.com");
    expect(approval.summary).toContain("08:00-10:30");
    expect(approval.summary).toContain("Quick idea for {{company}}");
    expect(approval.payload).toMatchObject({ campaignId: made.id, contentDigest: made.contentDigest, prospectCount: 4 });
    // Staff cannot approve.
    const staffSession = world.member_session(tenantA, staffA, [tenantA]);
    await expect(staffSession.approveApproval(approvalId, {}, randomUUID())).rejects.toBeInstanceOf(TenantDenied);

    const done = await world.member_session(tenantA, ownerA, [tenantA]).approveApproval(approvalId, {}, randomUUID());
    expect(done.execution.result).toMatchObject({ status: "active", activationApprovalId: approvalId, pausedReason: null });
    expect((await prospectRows(made.id)).every((row) => row.status === "active" && row.next_step === 1 && row.next_due_on === "2026-11-09")).toBe(true);
    const campaignRow = (await world.rows<{ activated_at: Date }>("SELECT activated_at FROM outreach_campaigns WHERE tenant_id=$1 AND id=$2", [tenantA, made.id]))[0]!;
    expect(campaignRow.activated_at.toISOString()).toBe(new Date(world.time.ms).toISOString());
  });

  it("cuts each field of the approval summary on its own, so a long name never hides the count or the subject", async () => {
    const made = await campaign({ name: "N".repeat(100), steps: [{ subject: "S".repeat(140), body: "Hi", delayBusinessDays: 0 }] });
    await imported(made.id, [prospect(1), prospect(2), prospect(3)]);
    const { approvalId } = await owner().requestActivation(made.id, randomUUID());
    const summary = (await world.rows<{ summary: string }>("SELECT summary FROM approvals WHERE tenant_id=$1 AND id=$2", [tenantA, approvalId]))[0]!.summary;
    expect(summary.length).toBeLessThanOrEqual(500);
    expect(summary).toContain("3 prospects");
    expect(summary).toContain("08:00-10:30");
    expect(summary.endsWith('"')).toBe(true);
  });

  it("starts each prospect on today's date in the tenant's zone, not UTC", async () => {
    const made = await ready(1);
    const saved = world.time.ms;
    // 2026-11-10 03:00Z is still Monday 19:00 in Los Angeles.
    world.time.ms = Date.parse("2026-11-10T03:00:00.000Z");
    try {
      await activate(made.id);
      expect((await prospectRows(made.id))[0]!.next_due_on).toBe("2026-11-09");
    } finally { world.time.ms = saved; }
  });

  it("is campaign_changed when an import lands between the request and the approval", async () => {
    const made = await ready(2);
    const { approvalId } = await owner().requestActivation(made.id, randomUUID());
    await imported(made.id, [prospect(50)]);
    await expect(world.member_session(tenantA, ownerA, [tenantA]).approveApproval(approvalId, {}, randomUUID()))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "campaign_changed" } });
    expect((await owner().getCampaign(made.id)).campaign.status).toBe("draft");
  });

  it("is campaign_changed when a prospect is stopped between the request and the approval", async () => {
    const made = await ready(2);
    const { approvalId } = await owner().requestActivation(made.id, randomUUID());
    const target = (await world.rows<{ id: string }>("SELECT id FROM outreach_prospects WHERE tenant_id=$1 ORDER BY email LIMIT 1", [tenantA]))[0]!.id;
    await owner().stopProspect(target, randomUUID());
    await expect(world.member_session(tenantA, ownerA, [tenantA]).approveApproval(approvalId, {}, randomUUID()))
      .rejects.toMatchObject({ details: { reason: "campaign_changed" } });
  });

  it("refuses with each reason", async () => {
    const reasons: Array<[string, () => Promise<string>]> = [
      ["no_prospects", async () => (await campaign()).id],
      ["mailbox_unavailable", async () => {
        const made = await ready(1);
        await world.rows("UPDATE outreach_mailboxes SET status='reauthorize' WHERE tenant_id=$1 AND id=$2", [tenantA, boxes[0]]);
        return made.id;
      }],
      ["time_zone_missing", async () => { await world.profile(tenantA, { timeZone: null }); return (await ready(1)).id; }],
      ["postal_address_missing", async () => { await world.profile(tenantA, { postalAddress: null }); return (await ready(1)).id; }],
      ["postal_address_placeholder", async () => {
        await world.profile(tenantA, { postalAddress: { ...(await import("./harness.js")).ADDRESS, line1: "PLACEHOLDER: postal address" } });
        return (await ready(1)).id;
      }],
      ["template_placeholder", async () => {
        const made = await campaign({ steps: [{ subject: "Hello", body: "Replace this Placeholder text", delayBusinessDays: 0 }] });
        await imported(made.id, [prospect(1)]);
        return made.id;
      }],
    ];
    for (const [reason, setup] of reasons) {
      const id = await setup();
      await expect(activate(id), reason).rejects.toMatchObject({ code: "Conflict", details: { reason } });
      expect((await owner().getCampaign(id)).campaign.status, reason).toBe("draft");
      await world.profile(tenantA);
      await world.rows("UPDATE outreach_mailboxes SET status='active' WHERE tenant_id=$1", [tenantA]);
    }
  });

  it("refuses an active or completed campaign as not activatable", async () => {
    const made = await ready(1);
    await activate(made.id);
    await expect(activate(made.id)).rejects.toMatchObject({ details: { reason: "campaign_not_activatable" } });
  });
});

describe("pause and stop (OS-9)", () => {
  it("pauses an active campaign, answers a paused one as it is, and resumes only with a new approval that keeps schedules", async () => {
    const made = await campaign();
    await imported(made.id, [prospect(1), prospect(2)]);
    await activate(made.id);
    const key = randomUUID();
    const paused = await owner().pauseCampaign(made.id, key);
    expect(paused.result).toMatchObject({ status: "paused", pausedReason: "owner" });
    expect(await owner().pauseCampaign(made.id, key)).toEqual(paused);
    expect((await owner().pauseCampaign(made.id, randomUUID())).result.status).toBe("paused");
    // A prospect imported while paused is pending; the active ones keep their step and date.
    await world.rows("UPDATE outreach_prospects SET next_step=2, next_due_on='2026-11-12' WHERE tenant_id=$1 AND email='pat1@acme1.example'", [tenantA]);
    await imported(made.id, [prospect(3)]);
    const resumed = await activate(made.id);
    expect(resumed.execution.result).toMatchObject({ status: "active", pausedReason: null });
    expect((await prospectRows(made.id)).map((row) => [row.email, row.status, row.next_step, row.next_due_on])).toEqual([
      ["pat1@acme1.example", "active", 2, "2026-11-12"], ["pat2@acme2.example", "active", 1, "2026-11-09"], ["pat3@acme3.example", "active", 1, "2026-11-09"]]);
  });

  it("answers pausing a draft as it is", async () => {
    const made = await campaign();
    expect((await owner().pauseCampaign(made.id, randomUUID())).result).toMatchObject({ status: "draft", pausedReason: null });
  });

  it("stops one open prospect and leaves the others and the terminal ones alone", async () => {
    const made = await campaign();
    await imported(made.id, [prospect(1), prospect(2)]);
    await activate(made.id);
    const [first, second] = await world.rows<{ id: string }>("SELECT id FROM outreach_prospects WHERE tenant_id=$1 ORDER BY email", [tenantA]);
    const stopped = await owner().stopProspect(first!.id, randomUUID());
    expect(stopped.result).toMatchObject({ id: first!.id, status: "stopped", nextStep: null, nextDueOn: null });
    expect(stopped.result.stoppedAt).toBe(new Date(world.time.ms).toISOString());
    expect((await owner().stopProspect(first!.id, randomUUID())).result.status).toBe("stopped");
    await world.rows("UPDATE outreach_prospects SET status='replied', next_step=NULL, next_due_on=NULL WHERE tenant_id=$1 AND id=$2", [tenantA, second!.id]);
    expect((await owner().stopProspect(second!.id, randomUUID())).result.status).toBe("replied");
  });
});

describe("reads (OS-22)", () => {
  it("lists campaigns, shows one with counts and steps, and pages prospects by cursor with a status filter", async () => {
    const made = await campaign();
    await imported(made.id, Array.from({ length: 5 }, (_, i) => prospect(i + 1)));
    await imported(made.id, [{ email: "ex@acme.example", firstName: "", company: "", excluded: true }]);
    const detail = await owner().getCampaign(made.id);
    expect(detail.campaign.id).toBe(made.id);
    expect(detail.steps.map((step) => [step.stepNumber, step.delayBusinessDays, step.subject])).toEqual([[1, 0, "Quick idea for {{company}}"], [2, 3, null], [3, 5, null]]);
    expect(detail.prospectCounts).toEqual({ pending: 5, excluded: 1 });
    expect(detail.sendsToday).toEqual([...boxes].sort().map((mailboxId) => ({ mailboxId, count: 0 })));
    expect((await owner().listCampaigns()).items.map((c) => c.id)).toEqual([made.id]);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 5; guard += 1) {
      const page = await owner().listProspects(made.id, { limit: "2", ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((p) => p.email));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(["ex@acme.example", "pat1@acme1.example", "pat2@acme2.example", "pat3@acme3.example", "pat4@acme4.example", "pat5@acme5.example"]);
    expect((await owner().listProspects(made.id, { status: "excluded" })).items.map((p) => p.email)).toEqual(["ex@acme.example"]);
    await expect(owner().listProspects(made.id, { cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(owner().listProspects(made.id, { limit: "500" })).rejects.toMatchObject({ code: "ValidationFailed" });
  });
});
