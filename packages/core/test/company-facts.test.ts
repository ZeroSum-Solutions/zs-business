// Company facts (docs/requirements/business-profile.md BP-16..BP-21): opening hours, a tone note and
// policies, each marked with the owner who set it; the one read every prompt builder uses; and the guard
// that fails when a prompt builder reads the profile another way.
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionError, companyFactsForPrompt, NOT_KNOWN, type BusinessHours, type MemberRole } from "@zs/contracts";
import { asService, type Transaction } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { createSession, readCompanyFacts, type EdgeDependencies, type Session } from "../src/index.js";

const START = Date.parse("2026-11-22T09:00:00.000Z");
let now = START;
const clock = { now: () => new Date(now) };

let database: TestDatabase;
let fixture: TwoTenantFixture;
let tenantId: string;
let owner: { userId: string; memberId: string };
let secondOwner: { userId: string; memberId: string };
let staff: { userId: string; memberId: string };
let ownerB: { userId: string; memberId: string };

const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
const sessionFor = (actor: { userId: string }, tenant = tenantId): Session => createSession(deps(), { tenantId: tenant, actorId: actor.userId });
const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(database.servicePool, work);
const facts = (tenant = tenantId) => database.db.tenant(tenant, (tx) => readCompanyFacts(tx, tenant));

async function addMember(tenant: string, role: MemberRole) {
  const userId = randomUUID();
  const memberId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenant, memberId, `${role}-${userId.slice(0, 8)}@example.com`, userId, role, new Date(START)],
  ));
  return { userId, memberId };
}
async function rejection(promise: Promise<unknown>): Promise<ActionError> {
  try { await promise; } catch (error) { if (error instanceof ActionError) return error; throw error; }
  throw new Error("Expected a rejection");
}
async function save(actor: { userId: string }, changes: Record<string, unknown>, tenant = tenantId) {
  const before = await sessionFor(actor, tenant).getBusiness();
  return sessionFor(actor, tenant).updateBusiness({ expectedRevision: before.revision, changes } as never, randomUUID());
}

const WEEKDAY_HOURS: BusinessHours = {
  mon: { open: "09:00", close: "17:30" }, tue: { open: "09:00", close: "17:30" }, wed: { open: "09:00", close: "17:30" },
  thu: { open: "09:00", close: "20:00" }, fri: { open: "09:00", close: "17:30" }, sat: { open: "10:00", close: "14:00" }, sun: null,
};

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  tenantId = fixture.a.tenantId;
  owner = await addMember(tenantId, "owner");
  secondOwner = await addMember(tenantId, "owner");
  staff = await addMember(tenantId, "staff");
  ownerB = await addMember(fixture.b.tenantId, "owner");
});
afterAll(async () => { await database?.close(); });

describe("missing facts read as not known (BP-20)", () => {
  it("a new profile has a name and nothing else, and the prompt says so in words", async () => {
    const read = await facts();
    expect(read.name).toEqual({ status: "known", value: "Tenant A", setBy: null, setAt: null });
    for (const key of ["description", "services", "timeZone", "hours", "tone", "policies"] as const) {
      expect(read[key]).toEqual({ status: "not_known" });
    }
    expect(companyFactsForPrompt(read)).toEqual({
      name: "Tenant A", description: NOT_KNOWN, services: NOT_KNOWN, timeZone: NOT_KNOWN, hours: NOT_KNOWN, tone: NOT_KNOWN, policies: NOT_KNOWN,
    });
  });
});

describe("saving hours, tone and policies (BP-16..BP-19)", () => {
  it("stores each fact with the saving owner and the instant, and the read returns them with that provenance", async () => {
    now = START + 1_000;
    const saved = await save(owner, {
      hours: WEEKDAY_HOURS,
      tone: "  Warm and plain. First names, no jargon.  ",
      policies: [
        { title: "Cancellation", text: "Cancel or move up to 24 hours before at no cost." },
        { title: "Deposits", text: "A 20% deposit holds a custom order." },
      ],
      timeZone: "Europe/London",
    });
    const at = new Date(now).toISOString();
    const mark = { setBy: owner.memberId, setAt: at, revision: saved.result.revision };
    expect(saved.result).toMatchObject({
      hours: WEEKDAY_HOURS,
      tone: "Warm and plain. First names, no jargon.",
      policies: [
        { title: "Cancellation", text: "Cancel or move up to 24 hours before at no cost.", ...mark },
        { title: "Deposits", text: "A 20% deposit holds a custom order.", ...mark },
      ],
      factMarks: { hours: mark, tone: mark, timeZone: mark },
    });
    // Staff read the same values and marks.
    expect(await sessionFor(staff).getBusiness()).toEqual(saved.result);

    const read = await facts();
    expect(read.hours).toEqual({ status: "known", value: WEEKDAY_HOURS, setBy: owner.memberId, setAt: at });
    expect(read.tone).toEqual({ status: "known", value: "Warm and plain. First names, no jargon.", setBy: owner.memberId, setAt: at });
    expect(read.policies).toEqual({ status: "known", value: saved.result.policies });
    expect(companyFactsForPrompt(read)).toMatchObject({
      timeZone: "Europe/London",
      hours: { mon: "09:00-17:30", thu: "09:00-20:00", sat: "10:00-14:00", sun: "closed" },
      tone: "Warm and plain. First names, no jargon.",
      policies: [
        { title: "Cancellation", text: "Cancel or move up to 24 hours before at no cost." },
        { title: "Deposits", text: "A 20% deposit holds a custom order." },
      ],
    });
  });

  it("a later save by another owner marks only what it changed; an unchanged policy keeps its first mark", async () => {
    const before = await sessionFor(owner).getBusiness();
    now = START + 2_000;
    const saved = await save(secondOwner, {
      tone: "Warm and plain.",
      policies: [
        { title: "Cancellation", text: "Cancel or move up to 24 hours before at no cost." },
        { title: "Refunds", text: "Refunds go back to the card within 10 days." },
      ],
    });
    const mark = { setBy: secondOwner.memberId, setAt: new Date(now).toISOString(), revision: saved.result.revision };
    expect(saved.result.factMarks).toEqual({ ...before.factMarks, tone: mark });
    expect(saved.result.policies).toEqual([
      before.policies[0],
      { title: "Refunds", text: "Refunds go back to the card within 10 days.", ...mark },
    ]);
  });

  it("clearing a fact removes its mark and it reads as not known again", async () => {
    const saved = await save(owner, { tone: null, policies: [] });
    expect(saved.result).toMatchObject({ tone: null, policies: [] });
    expect(saved.result.factMarks).not.toHaveProperty("tone");
    const read = await facts();
    expect(read.tone).toEqual({ status: "not_known" });
    expect(read.policies).toEqual({ status: "not_known" });
    expect(read.hours.status).toBe("known");
  });

  it("names the field for hours, tone and policies outside their shapes, and writes nothing", async () => {
    const before = await sessionFor(owner).getBusiness();
    const refuse = async (changes: Record<string, unknown>) =>
      rejection(sessionFor(owner).updateBusiness({ expectedRevision: before.revision, changes } as never, randomUUID()));
    const closedAllWeek = Object.fromEntries(Object.keys(WEEKDAY_HOURS).map((day) => [day, null]));
    expect(await refuse({ hours: closedAllWeek })).toMatchObject({ code: "ValidationFailed", details: { issues: [{ path: "changes.hours" }] } });
    expect(await refuse({ hours: { ...WEEKDAY_HOURS, mon: { open: "18:00", close: "09:00" } } }))
      .toMatchObject({ code: "ValidationFailed", details: { issues: [{ path: "changes.hours.mon.close" }] } });
    expect(await refuse({ hours: { ...WEEKDAY_HOURS, mon: { open: "9am", close: "17:00" } } })).toMatchObject({ code: "ValidationFailed" });
    const { sun: _sun, ...sixDays } = WEEKDAY_HOURS;
    expect(await refuse({ hours: sixDays })).toMatchObject({ code: "ValidationFailed" });
    expect(await refuse({ tone: "   " })).toMatchObject({ code: "ValidationFailed", details: { issues: [{ path: "changes.tone" }] } });
    expect(await refuse({ tone: "x".repeat(501) })).toMatchObject({ code: "ValidationFailed" });
    expect(await refuse({ policies: [{ title: "Refunds", text: "A" }, { title: "refunds", text: "B" }] }))
      .toMatchObject({ code: "ValidationFailed", details: { issues: [{ path: "changes.policies" }] } });
    expect(await refuse({ policies: Array.from({ length: 11 }, (_, i) => ({ title: `P${i}`, text: "Text" })) })).toMatchObject({ code: "ValidationFailed" });
    expect(await refuse({ policies: [{ title: "Two\nlines", text: "Text" }] })).toMatchObject({ code: "ValidationFailed" });
    // A client may not write a mark itself.
    expect(await refuse({ policies: [{ title: "Refunds", text: "A", setBy: staff.memberId }] })).toMatchObject({ code: "ValidationFailed" });
    expect(await sessionFor(owner).getBusiness()).toEqual(before);
  });

  it("replays a save stored before the company facts existed with them empty, not as an invalid result", async () => {
    const before = await sessionFor(owner).getBusiness();
    const key = randomUUID();
    const body = { expectedRevision: before.revision, changes: { legalName: "Halden Rowe Ltd" } };
    const first = await sessionFor(owner).updateBusiness(body, key);
    await fixture.service((tx) => tx.query(
      "UPDATE actions SET result = result - 'hours' - 'tone' - 'policies' - 'factMarks' WHERE tenant_id=$1 AND idempotency_key=$2", [tenantId, key]));
    const replay = await sessionFor(owner).updateBusiness(body, key);
    expect(replay.result).toMatchObject({ revision: first.result.revision, hours: null, tone: null, policies: [], factMarks: {} });
  });
});

describe("the owner is the only writer (BP-19)", () => {
  it("refuses staff through the action, and their read is unchanged", async () => {
    const before = await sessionFor(staff).getBusiness();
    expect(await rejection(sessionFor(staff).updateBusiness({ expectedRevision: before.revision, changes: { tone: "Pushy." } }, randomUUID())))
      .toMatchObject({ code: "TenantDenied" });
    expect(await sessionFor(staff).getBusiness()).toEqual(before);
  });

  it("refuses a direct write as the runtime role that names a staff member, or no member, as the setter", async () => {
    const write = (marks: Record<string, unknown>) => database.db.tenant(tenantId, (tx) => tx.query(
      "UPDATE business_profiles SET tone='Pushy.', fact_marks=fact_marks || $2::jsonb WHERE tenant_id=$1", [tenantId, JSON.stringify(marks)]));
    const markOf = (setBy: string) => ({ tone: { setBy, setAt: new Date(now).toISOString(), revision: 99 } });
    await expect(write(markOf(staff.memberId))).rejects.toThrow(/Only an owner/);
    await expect(write(markOf(randomUUID()))).rejects.toThrow(/Only an owner/);
    // Tenant B's owner is no owner of A.
    await expect(write(markOf(ownerB.memberId))).rejects.toThrow(/Only an owner/);
    const policy = [{ title: "Refunds", text: "None.", setBy: staff.memberId, setAt: new Date(now).toISOString(), revision: 99 }];
    await expect(database.db.tenant(tenantId, (tx) => tx.query(
      "UPDATE business_profiles SET policies=$2::jsonb WHERE tenant_id=$1", [tenantId, JSON.stringify(policy)]))).rejects.toThrow(/Only an owner/);
    expect((await facts()).tone).toEqual({ status: "not_known" });
  });

  it("a write that changes a fact without marking it drops the old mark: the value stays, the setter reads as not recorded", async () => {
    const before = await sessionFor(owner).getBusiness();
    expect(before.factMarks.timeZone).toBeDefined();
    // What a setup step or an operator script does: change the zone and nothing else.
    await service((tx) => tx.query("UPDATE business_profiles SET time_zone='Europe/Paris', revision=revision+1 WHERE tenant_id=$1", [tenantId]));
    const after = await sessionFor(owner).getBusiness();
    expect(after.factMarks.timeZone).toBeUndefined();
    expect(after.factMarks.hours).toEqual(before.factMarks.hours);
    expect((await facts()).timeZone).toEqual({ status: "known", value: "Europe/Paris", setBy: null, setAt: null });
  });

  it("keeps tenant B's facts apart: B reads its own, and A's owner cannot write B's", async () => {
    const a = await facts();
    expect(await facts(fixture.b.tenantId)).toMatchObject({ hours: { status: "not_known" }, tone: { status: "not_known" } });
    await save(ownerB, { tone: "Tenant B only." }, fixture.b.tenantId);
    expect((await facts(fixture.b.tenantId)).tone).toMatchObject({ status: "known", value: "Tenant B only.", setBy: ownerB.memberId });
    expect(await rejection(sessionFor(owner, fixture.b.tenantId).updateBusiness({ expectedRevision: 2, changes: { tone: "From A" } }, randomUUID())))
      .toMatchObject({ code: "TenantDenied" });
    expect(await facts()).toEqual(a);
  });
});

// BP-20: every agent prompt builder reads the business only through readCompanyFacts. A prompt builder is a
// core source file that builds a model request (`TextModelRequest`, a `system:` text) or a `*Prompt` input.
const SOURCE = fileURLToPath(new URL("../src", import.meta.url));
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
function isPromptBuilder(source: string): boolean {
  const code = stripComments(source);
  return /\bTextModelRequest\b/.test(code) || /\b[A-Z]\w*Prompt\b/.test(code) || /\bsystem\s*:/.test(code);
}
/** The ways a builder could read the business that are not the one read. */
function otherProfileReads(source: string): string[] {
  const code = stripComments(source);
  const patterns: [RegExp, string][] = [
    [/\bbusiness_profiles\b/, "reads business_profiles"],
    [/\b(?:FROM|JOIN)\s+(?:public\.)?tenants\b/i, "reads tenants"],
    [/\bgetBusinessProfile\b/, "calls getBusinessProfile"],
  ];
  return patterns.filter(([pattern]) => pattern.test(code)).map(([, label]) => label);
}

describe("one read for every prompt builder (BP-20)", () => {
  it.each([
    ["SQL on the profile", "const r = await tx.query('SELECT tone FROM business_profiles WHERE tenant_id=$1'); const p: FollowUpPrompt = r;"],
    ["the tenant's name", "const x = { system: S, input: await tx.query(`SELECT name FROM tenants WHERE tenant_id=$1`) };"],
    ["a JOIN on tenants", "const q = `SELECT t.name FROM intake_items i JOIN tenants t ON t.tenant_id=i.tenant_id`; let r: TextModelRequest;"],
    ["the profile handler", "const p = await getBusinessProfile(tx, id); const req: TextModelRequest = { system: S, input: p };"],
  ])("flags a prompt builder that reads %s", (_label, source) => {
    expect(isPromptBuilder(source)).toBe(true);
    expect(otherProfileReads(source).length).toBeGreaterThan(0);
  });

  it("does not flag a builder that uses the one read, or a comment that names the table", () => {
    const source = "// business_profiles is read by readCompanyFacts\nconst company = companyFactsForPrompt(await readCompanyFacts(tx, id)); let r: TextModelRequest;";
    expect(isPromptBuilder(source)).toBe(true);
    expect(otherProfileReads(source)).toEqual([]);
  });

  it("no prompt builder in core reads the profile or the tenant's name another way, and each one with business facts uses readCompanyFacts", async () => {
    const files: string[] = [];
    async function visit(path: string): Promise<void> {
      for (const item of await readdir(path, { withFileTypes: true })) {
        const file = join(path, item.name);
        if (item.isDirectory()) await visit(file);
        else if (/\.ts$/.test(file)) files.push(file);
      }
    }
    await visit(SOURCE);
    const builders: string[] = [];
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (!isPromptBuilder(source)) continue;
      const name = relative(SOURCE, file);
      builders.push(name);
      violations.push(...otherProfileReads(source).map((label) => `${name}: ${label}`));
      if (/\bcompanyFactsForPrompt\b/.test(stripComments(source)) && !/\breadCompanyFacts\b/.test(stripComments(source)))
        violations.push(`${name}: renders company facts it did not read with readCompanyFacts`);
    }
    // The detector finds the builders that exist today, so it is not passing on an empty list.
    expect(builders).toEqual(expect.arrayContaining(["agents/candidates.ts", "templates/suggest.ts", "browser/fake-runner.ts"]));
    expect(violations).toEqual([]);
    // The two builders that put the business in a prompt read it through the one read.
    for (const name of ["agents/candidates.ts", "templates/suggest.ts"]) {
      expect(stripComments(await readFile(join(SOURCE, name), "utf8"))).toMatch(/\breadCompanyFacts\(/);
    }
  });
});
