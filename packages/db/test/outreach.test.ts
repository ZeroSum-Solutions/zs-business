// Outreach storage rules (20261109100000_outreach_sequencer.sql; outreach-sequencer.md OS-4, OS-15, OS-24): the runtime
// role reads and writes only its tenant's rows and only the columns the contract names, never reads a sealed
// token, cannot change a step, a send or an inbound event, and cannot mark a mailbox `reauthorize`.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";

const T0 = "2026-11-09T16:00:00.000Z";
// A well-formed sealed token (shape only; nothing here opens it).
const SEALED = `zsg1.${"A".repeat(43)}.${"B".repeat(16)}.${"C".repeat(60)}`;

let database: TestDatabase;
let fixture: TwoTenantFixture;
const ids = { mailbox: randomUUID(), campaign: randomUUID(), approval: randomUUID(), prospect: randomUUID(), send: randomUUID(), inbound: randomUUID() };
const TABLES = [
  "outreach_mailboxes", "outreach_campaigns", "outreach_campaign_steps", "outreach_campaign_mailboxes",
  "outreach_prospects", "outreach_sends", "outreach_inbound_events",
] as const;

const denied = (run: () => Promise<unknown>) => run().then(() => null, (error: unknown) => error);

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  const tenantId = fixture.a.tenantId;
  await fixture.service(async (tx) => {
    await tx.query(
      `INSERT INTO approvals (tenant_id,id,action_type,target_type,target_id,payload,summary,requested_by,requested_at,expires_at,status,decided_by,decided_at)
       VALUES ($1,$2,'outreach.campaign.activate','outreach_campaign',$3,'{}','Activate',$4,$5,'2026-11-16T16:00:00Z','approved',$4,$5)`,
      [tenantId, ids.approval, ids.campaign, randomUUID(), T0]);
    await tx.query(
      `INSERT INTO outreach_mailboxes (tenant_id,id,email,display_name,status,sealed_refresh_token,created_at,updated_at)
       VALUES ($1,$2,'sender@example.com','Sender','active',$3,$4,$4)`, [tenantId, ids.mailbox, SEALED, T0]);
    await tx.query(
      `INSERT INTO outreach_campaigns (tenant_id,id,name,status,window_start_min,window_end_min,content_digest,activation_approval_id,activated_at,created_by,created_at,updated_at)
       VALUES ($1,$2,'First','active',480,630,$3,$4,$5,$6,$5,$5)`, [tenantId, ids.campaign, "a".repeat(64), ids.approval, T0, randomUUID()]);
    await tx.query(
      `INSERT INTO outreach_campaign_steps (tenant_id,campaign_id,step_number,delay_business_days,subject,body)
       VALUES ($1,$2,1,0,'Hello','Body'), ($1,$2,2,3,NULL,'Follow up')`, [tenantId, ids.campaign]);
    await tx.query(`INSERT INTO outreach_campaign_mailboxes (tenant_id,campaign_id,mailbox_id) VALUES ($1,$2,$3)`, [tenantId, ids.campaign, ids.mailbox]);
    await tx.query(
      `INSERT INTO outreach_prospects (tenant_id,id,campaign_id,mailbox_id,email,first_name,company,status,next_step,next_due_on,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'sam@acme.example','Sam','Acme','active',1,'2026-11-09',$5,$5)`, [tenantId, ids.prospect, ids.campaign, ids.mailbox, T0]);
    await tx.query(
      `INSERT INTO outreach_sends (tenant_id,id,campaign_id,prospect_id,mailbox_id,step_number,status,recipient_address,subject,body,local_send_date,attempt_started_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,1,'sending','sam@acme.example','Hello','Body','2026-11-09',$6,$6,$6)`,
      [tenantId, ids.send, ids.campaign, ids.prospect, ids.mailbox, T0]);
    await tx.query(
      `INSERT INTO outreach_inbound_events (tenant_id,id,mailbox_id,gmail_message_id,prospect_id,kind,received_at,recorded_at)
       VALUES ($1,$2,$3,'m1',$4,'reply',$5,$5)`, [tenantId, ids.inbound, ids.mailbox, ids.prospect, T0]);
  });
});
afterAll(async () => { await database?.close(); });

describe("tenant isolation under the runtime role", () => {
  it("shows tenant A its rows (mailboxes by allowed column) and tenant B none", async () => {
    for (const table of TABLES) {
      const columns = table === "outreach_mailboxes" ? "tenant_id, id, email, status" : "*";
      expect(await fixture.a.run(async (tx) => (await tx.query(`SELECT ${columns} FROM ${table}`)).rowCount), table).toBeGreaterThan(0);
      expect(await fixture.b.run(async (tx) => (await tx.query(`SELECT ${columns} FROM ${table}`)).rowCount), table).toBe(0);
      expect(await fixture.b.run(async (tx) => (await tx.query(`SELECT ${columns} FROM ${table} WHERE tenant_id=$1`, [fixture.a.tenantId])).rowCount), table).toBe(0);
    }
  });

  it("refuses tenant B every write against tenant A's rows", async () => {
    const a = fixture.a.tenantId;
    const updates = [
      ["outreach_mailboxes", "display_name='X'"], ["outreach_campaigns", "status='paused', paused_reason='owner'"],
      ["outreach_prospects", "status='stopped'"],
    ] as const;
    for (const [table, set] of updates)
      expect(await fixture.b.run(async (tx) => (await tx.query(`UPDATE ${table} SET ${set} WHERE tenant_id=$1`, [a])).rowCount), table).toBe(0);
    // Inserting a row under A's tenant id from B's context breaks the policy's check.
    expect(await denied(() => fixture.b.run((tx) => tx.query(
      `INSERT INTO outreach_mailboxes (tenant_id,id,email,display_name,status,sealed_refresh_token,created_at,updated_at)
       VALUES ($1,$2,'b@example.com','B','active',$3,$4,$4)`, [a, randomUUID(), SEALED, T0])))).toMatchObject({ code: "42501" });
    expect(await denied(() => fixture.b.run((tx) => tx.query(
      `INSERT INTO outreach_campaign_steps (tenant_id,campaign_id,step_number,delay_business_days,subject,body)
       VALUES ($1,$2,3,2,NULL,'x')`, [a, ids.campaign])))).toMatchObject({ code: "42501" });
  });

  it("does not let tenant B point a prospect at tenant A's campaign or mailbox", async () => {
    const b = fixture.b.tenantId;
    expect(await denied(() => fixture.service((tx) => tx.query(
      `INSERT INTO outreach_prospects (tenant_id,id,campaign_id,mailbox_id,email,first_name,company,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'x@acme.example','X','Acme',$5,$5)`, [b, randomUUID(), ids.campaign, ids.mailbox, T0])))).toMatchObject({ code: "23503" });
  });
});

describe("column and statement grants", () => {
  it("never lets the runtime role read the sealed token, the history cursor or the lease", async () => {
    for (const column of ["sealed_refresh_token", "history_id", "history_checked_at", "lease_token", "lease_expires_at"])
      expect(await denied(() => fixture.a.run((tx) => tx.query(`SELECT ${column} FROM outreach_mailboxes`))), column).toMatchObject({ code: "42501" });
    expect(await denied(() => fixture.a.run((tx) => tx.query("SELECT * FROM outreach_mailboxes")))).toMatchObject({ code: "42501" });
  });

  it("keeps a campaign's steps immutable and its sends and inbound events out of the runtime role's hands", async () => {
    const a = fixture.a.tenantId;
    for (const sql of [
      "UPDATE outreach_campaign_steps SET body='Changed' WHERE tenant_id=$1",
      "DELETE FROM outreach_campaign_steps WHERE tenant_id=$1",
      "UPDATE outreach_campaign_mailboxes SET mailbox_id=mailbox_id WHERE tenant_id=$1",
      "DELETE FROM outreach_campaign_mailboxes WHERE tenant_id=$1",
      "UPDATE outreach_sends SET status='sent' WHERE tenant_id=$1",
      "DELETE FROM outreach_sends WHERE tenant_id=$1",
      "UPDATE outreach_inbound_events SET kind='reply' WHERE tenant_id=$1",
      "DELETE FROM outreach_inbound_events WHERE tenant_id=$1",
      "DELETE FROM outreach_prospects WHERE tenant_id=$1",
      "DELETE FROM outreach_campaigns WHERE tenant_id=$1",
      "DELETE FROM outreach_mailboxes WHERE tenant_id=$1",
    ]) expect(await denied(() => fixture.a.run((tx) => tx.query(sql, [a]))), sql).toMatchObject({ code: "42501" });
    expect(await denied(() => fixture.a.run((tx) => tx.query(
      `INSERT INTO outreach_sends (tenant_id,id,campaign_id,prospect_id,mailbox_id,step_number,status,recipient_address,subject,body,local_send_date,attempt_started_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,2,'sent','sam@acme.example','S','B','2026-11-09',$6,$6,$6)`,
      [a, randomUUID(), ids.campaign, ids.prospect, ids.mailbox, T0])))).toMatchObject({ code: "42501" });
  });

  it("lets the service role never update a step or an inbound event", async () => {
    expect(await denied(() => fixture.service((tx) => tx.query("UPDATE outreach_campaign_steps SET body='x' WHERE tenant_id=$1", [fixture.a.tenantId])))).toMatchObject({ code: "42501" });
    expect(await denied(() => fixture.service((tx) => tx.query("UPDATE outreach_inbound_events SET kind='reply' WHERE tenant_id=$1", [fixture.a.tenantId])))).toMatchObject({ code: "42501" });
    expect(await denied(() => fixture.service((tx) => tx.query("DELETE FROM outreach_sends WHERE tenant_id=$1", [fixture.a.tenantId])))).toMatchObject({ code: "42501" });
  });

  it("lets the runtime role insert a draft campaign and its steps, but never start one", async () => {
    const a = fixture.a.tenantId;
    const id = randomUUID();
    await fixture.a.run(async (tx) => {
      await tx.query(
        `INSERT INTO outreach_campaigns (tenant_id,id,name,window_start_min,window_end_min,content_digest,created_by,created_at,updated_at)
         VALUES ($1,$2,'Second',480,630,$3,$4,$5,$5)`, [a, id, "b".repeat(64), randomUUID(), T0]);
      await tx.query(
        `INSERT INTO outreach_campaign_steps (tenant_id,campaign_id,step_number,delay_business_days,subject,body) VALUES ($1,$2,1,0,'Hi','Body')`, [a, id]);
    });
    expect(await fixture.a.run(async (tx) => (await tx.query<{ status: string }>("SELECT status FROM outreach_campaigns WHERE tenant_id=$1 AND id=$2", [a, id])).rows[0]!.status)).toBe("draft");
    // The status column is not insertable: a runtime insert cannot start a campaign.
    expect(await denied(() => fixture.a.run((tx) => tx.query(
      `INSERT INTO outreach_campaigns (tenant_id,id,name,status,window_start_min,window_end_min,content_digest,created_by,created_at,updated_at)
       VALUES ($1,$2,'Third','active',480,630,$3,$4,$5,$5)`, [a, randomUUID(), "b".repeat(64), randomUUID(), T0])))).toMatchObject({ code: "42501" });
    // A campaign cannot leave draft without an activation approval (the CHECK), even for the service role.
    expect(await denied(() => fixture.service((tx) => tx.query(
      "UPDATE outreach_campaigns SET status='active' WHERE tenant_id=$1 AND id=$2", [a, id])))).toMatchObject({ code: "23514" });
  });

  it("lets the runtime role change a campaign's status columns and a prospect's schedule, nothing else", async () => {
    const a = fixture.a.tenantId;
    await fixture.a.run((tx) => tx.query(
      "UPDATE outreach_prospects SET status='stopped', stopped_at=$3, updated_at=$3 WHERE tenant_id=$1 AND id=$2", [a, ids.prospect, T0]));
    await fixture.service((tx) => tx.query(
      "UPDATE outreach_prospects SET status='active', stopped_at=NULL WHERE tenant_id=$1 AND id=$2", [a, ids.prospect]));
    expect(await denied(() => fixture.a.run((tx) => tx.query(
      "UPDATE outreach_prospects SET email='other@example.com' WHERE tenant_id=$1 AND id=$2", [a, ids.prospect])))).toMatchObject({ code: "42501" });
    expect(await denied(() => fixture.a.run((tx) => tx.query(
      "UPDATE outreach_campaigns SET content_digest=$3 WHERE tenant_id=$1 AND id=$2", [a, ids.campaign, "c".repeat(64)])))).toMatchObject({ code: "42501" });
    expect(await denied(() => fixture.a.run((tx) => tx.query(
      "UPDATE outreach_campaigns SET window_end_min=700 WHERE tenant_id=$1 AND id=$2", [a, ids.campaign])))).toMatchObject({ code: "42501" });
  });
});

describe("prospect opener (20261110100000; outreach-sequencer.md OS-5, OS-7)", () => {
  it("lets the runtime role insert one line of 1..300 characters, refuses CR, LF, empty and longer, and never updates it", async () => {
    const a = fixture.a.tenantId;
    const insert = (email: string, opener: string | null) => fixture.a.run((tx) => tx.query(
      `INSERT INTO outreach_prospects (tenant_id,id,campaign_id,mailbox_id,email,first_name,company,opener,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,'Sam','Acme',$6,'pending',$7,$7)`, [a, randomUUID(), ids.campaign, ids.mailbox, email, opener, T0]));
    await insert("one@acme.example", "Read your post on boilers.");
    await insert("two@acme.example", "x".repeat(300));
    await insert("none@acme.example", null);
    for (const [index, bad] of ["a\nb", "a\rb", "", "x".repeat(301)].entries())
      expect(await denied(() => insert(`bad${index}@acme.example`, bad))).toMatchObject({ code: "23514" });
    const stored = await fixture.a.run(async (tx) => (await tx.query<{ opener: string | null }>(
      "SELECT opener FROM outreach_prospects WHERE tenant_id=$1 AND email LIKE '%@acme.example' AND email <> 'sam@acme.example' ORDER BY email", [a])).rows.map((r) => r.opener?.length ?? null));
    expect(stored).toEqual([null, 26, 300]);
    expect(await denied(() => fixture.a.run((tx) => tx.query(
      "UPDATE outreach_prospects SET opener='changed' WHERE tenant_id=$1 AND id=$2", [a, ids.prospect])))).toMatchObject({ code: "42501" });
    // The other tenant never sees these rows (the table's RLS is unchanged).
    expect(await fixture.b.run(async (tx) => (await tx.query("SELECT 1 FROM outreach_prospects WHERE opener IS NOT NULL")).rowCount)).toBe(0);
  });
});

describe("runtime guards on campaigns and prospects (review fix B6; 20261109110000)", () => {
  const approval = async (tenantId: string, status: string, target: string, action = "outreach.campaign.activate") => {
    const id = randomUUID();
    const decided = status === "pending" ? [null, null] : [randomUUID(), T0];
    await fixture.service((tx) => tx.query(
      `INSERT INTO approvals (tenant_id,id,action_type,target_type,target_id,payload,summary,requested_by,requested_at,expires_at,status,decided_by,decided_at,revoked_by,revoked_at)
       VALUES ($1,$2,$3,'outreach_campaign',$4,'{}','Activate',$5,$6,'2026-11-16T16:00:00Z',$7,$8,$9,$10,$11)`,
      [tenantId, id, action, target, randomUUID(), T0, status, decided[0], decided[1], status === "revoked" ? randomUUID() : null, status === "revoked" ? T0 : null]));
    return id;
  };
  const pausedCampaign = async (tenantId: string, approvalId: string) => {
    const id = randomUUID();
    await fixture.service((tx) => tx.query(
      `INSERT INTO outreach_campaigns (tenant_id,id,name,status,paused_reason,window_start_min,window_end_min,content_digest,activation_approval_id,activated_at,created_by,created_at,updated_at)
       VALUES ($1,$2,'Paused','paused','owner',480,630,$3,$4,$5,$6,$5,$5)`, [tenantId, id, "d".repeat(64), approvalId, T0, randomUUID()]));
    return id;
  };

  it("never lets the runtime role complete or un-draft a campaign", async () => {
    const a = fixture.a.tenantId;
    for (const status of ["completed", "draft"])
      expect(await denied(() => fixture.a.run((tx) => tx.query(
        "UPDATE outreach_campaigns SET status=$3 WHERE tenant_id=$1 AND id=$2", [a, ids.campaign, status]))), status).toMatchObject({ code: "42501" });
  });

  it("starts a paused campaign for the runtime role only against an approved activation of that very campaign", async () => {
    const a = fixture.a.tenantId;
    const start = (campaign: string, approvalId: string) => fixture.a.run((tx) => tx.query(
      "UPDATE outreach_campaigns SET status='active', paused_reason=NULL, activation_approval_id=$3 WHERE tenant_id=$1 AND id=$2", [a, campaign, approvalId]));
    const pending = await approval(a, "pending", randomUUID());
    const campaign = await pausedCampaign(a, pending);
    expect(await denied(() => start(campaign, pending)), "pending").toMatchObject({ code: "42501" });
    const elsewhere = await approval(a, "approved", randomUUID());
    expect(await denied(() => start(campaign, elsewhere)), "another campaign's approval").toMatchObject({ code: "42501" });
    const other = await approval(a, "approved", campaign, "outreach.campaign.pause");
    expect(await denied(() => start(campaign, other)), "another action").toMatchObject({ code: "42501" });
    const revoked = await approval(a, "revoked", campaign);
    expect(await denied(() => start(campaign, revoked)), "revoked").toMatchObject({ code: "42501" });
    const good = await approval(a, "approved", campaign);
    await start(campaign, good);
    expect((await fixture.service((tx) => tx.query<{ status: string }>("SELECT status FROM outreach_campaigns WHERE tenant_id=$1 AND id=$2", [a, campaign]))).rows[0]!.status).toBe("active");
    // An active campaign's approval cannot be swapped by the runtime role to one that is not approved.
    expect(await denied(() => fixture.a.run((tx) => tx.query(
      "UPDATE outreach_campaigns SET activation_approval_id=$3 WHERE tenant_id=$1 AND id=$2", [a, campaign, pending])))).toMatchObject({ code: "42501" });
    // Pausing it is always allowed.
    await fixture.a.run((tx) => tx.query("UPDATE outreach_campaigns SET status='paused', paused_reason='owner' WHERE tenant_id=$1 AND id=$2", [a, campaign]));
    // The service role (the worker) is not held by the guard.
    await fixture.service((tx) => tx.query("UPDATE outreach_campaigns SET status='completed', paused_reason=NULL WHERE tenant_id=$1 AND id=$2", [a, campaign]));
  });

  it("never reopens or reschedules a prospect for the runtime role", async () => {
    const a = fixture.a.tenantId;
    const row = randomUUID();
    await fixture.service((tx) => tx.query(
      `INSERT INTO outreach_prospects (tenant_id,id,campaign_id,mailbox_id,email,first_name,company,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'guard@acme.example','Gus','Acme','pending',$5,$5)`, [a, row, ids.campaign, ids.mailbox, T0]));
    await fixture.a.run((tx) => tx.query(
      "UPDATE outreach_prospects SET status='active', next_step=1, next_due_on='2026-11-09' WHERE tenant_id=$1 AND id=$2", [a, row]));
    expect(await denied(() => fixture.a.run((tx) => tx.query(
      "UPDATE outreach_prospects SET next_step=2, next_due_on='2026-11-12' WHERE tenant_id=$1 AND id=$2", [a, row])))).toMatchObject({ code: "42501" });
    await fixture.service((tx) => tx.query(
      "UPDATE outreach_prospects SET status='replied', next_step=NULL, next_due_on=NULL WHERE tenant_id=$1 AND id=$2", [a, row]));
    for (const status of ["active", "pending", "stopped"])
      expect(await denied(() => fixture.a.run((tx) => tx.query(
        "UPDATE outreach_prospects SET status=$3, next_step=1, next_due_on='2026-11-09' WHERE tenant_id=$1 AND id=$2", [a, row, status]))), status).toMatchObject({ code: "42501" });
  });

  it("lets the runtime role clear a mailbox pause (the reconnect) and nothing else of its schedule state", async () => {
    const a = fixture.a.tenantId;
    await fixture.service((tx) => tx.query(
      "UPDATE outreach_mailboxes SET paused_until='9999-12-31T00:00:00Z', pause_reason='history_gap' WHERE tenant_id=$1 AND id=$2", [a, ids.mailbox]));
    await fixture.a.run((tx) => tx.query("UPDATE outreach_mailboxes SET paused_until=NULL, pause_reason=NULL WHERE tenant_id=$1 AND id=$2", [a, ids.mailbox]));
    expect(await denied(() => fixture.a.run((tx) => tx.query(
      "UPDATE outreach_mailboxes SET history_resume_token='x' WHERE tenant_id=$1 AND id=$2", [a, ids.mailbox])))).toMatchObject({ code: "42501" });
  });
});

describe("mailbox status", () => {
  it("lets the runtime role set a mailbox active or disconnected and refuses reauthorize", async () => {
    const a = fixture.a.tenantId;
    expect(await denied(() => fixture.a.run((tx) => tx.query(
      "UPDATE outreach_mailboxes SET status='reauthorize' WHERE tenant_id=$1 AND id=$2", [a, ids.mailbox])))).toMatchObject({ code: "42501" });
    expect(await denied(() => fixture.a.run((tx) => tx.query(
      `INSERT INTO outreach_mailboxes (tenant_id,id,email,display_name,status,sealed_refresh_token,created_at,updated_at)
       VALUES ($1,$2,'x@example.com','X','reauthorize',$3,$4,$4)`, [a, randomUUID(), SEALED, T0])))).toMatchObject({ code: "42501" });
    // The worker's word: the service role may.
    await fixture.service((tx) => tx.query("UPDATE outreach_mailboxes SET status='reauthorize' WHERE tenant_id=$1 AND id=$2", [a, ids.mailbox]));
    await fixture.a.run((tx) => tx.query("UPDATE outreach_mailboxes SET status='active', sealed_refresh_token=$3 WHERE tenant_id=$1 AND id=$2", [a, ids.mailbox, SEALED]));
    await fixture.a.run((tx) => tx.query("UPDATE outreach_mailboxes SET status='disconnected', sealed_refresh_token=NULL WHERE tenant_id=$1 AND id=$2", [a, ids.mailbox]));
    await fixture.a.run((tx) => tx.query("UPDATE outreach_mailboxes SET status='active', sealed_refresh_token=$3 WHERE tenant_id=$1 AND id=$2", [a, ids.mailbox, SEALED]));
  });

  it("holds a sealed token exactly when the mailbox is not disconnected", async () => {
    expect(await denied(() => fixture.service((tx) => tx.query(
      "UPDATE outreach_mailboxes SET sealed_refresh_token=NULL WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, ids.mailbox])))).toMatchObject({ code: "23514" });
    expect(await denied(() => fixture.service((tx) => tx.query(
      "UPDATE outreach_mailboxes SET sealed_refresh_token='not-sealed' WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, ids.mailbox])))).toMatchObject({ code: "23514" });
  });
});

describe("the send record", () => {
  it("allows one attempt per prospect and step while it is sending, sent, uncertain or lost, and a retry after not_sent", async () => {
    const a = fixture.a.tenantId;
    const insert = (status: string) => fixture.service((tx) => tx.query(
      `INSERT INTO outreach_sends (tenant_id,id,campaign_id,prospect_id,mailbox_id,step_number,status,recipient_address,subject,body,local_send_date,attempt_started_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,2,$6,'sam@acme.example','S','B','2026-11-09',$7,$7,$7)`,
      [a, randomUUID(), ids.campaign, ids.prospect, ids.mailbox, status, T0]));
    await insert("not_sent");
    await insert("not_sent");
    await insert("sending");
    for (const status of ["sending", "uncertain", "lost"])
      expect(await denied(() => insert(status)), status).toMatchObject({ code: "23505", constraint: "outreach_sends_one_attempt" });
    // Step 1 already has its `sending` row from the fixture.
    expect(await denied(() => fixture.service((tx) => tx.query(
      `INSERT INTO outreach_sends (tenant_id,id,campaign_id,prospect_id,mailbox_id,step_number,status,recipient_address,subject,body,local_send_date,attempt_started_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,1,'uncertain','sam@acme.example','S','B','2026-11-09',$6,$6,$6)`,
      [a, randomUUID(), ids.campaign, ids.prospect, ids.mailbox, T0])))).toMatchObject({ code: "23505" });
  });

  it("keeps a prospect's address unique across the tenant", async () => {
    expect(await denied(() => fixture.service((tx) => tx.query(
      `INSERT INTO outreach_prospects (tenant_id,id,campaign_id,mailbox_id,email,first_name,company,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'sam@acme.example','Sam','Acme',$5,$5)`,
      [fixture.a.tenantId, randomUUID(), ids.campaign, ids.mailbox, T0])))).toMatchObject({ code: "23505", constraint: "outreach_prospects_email_unique" });
  });
});

describe("campaign shape", () => {
  it("refuses a step that breaks the step rules and a window shorter than 30 minutes", async () => {
    const a = fixture.a.tenantId;
    const step = (n: number, subject: string | null, delay: number) => fixture.service((tx) => tx.query(
      `INSERT INTO outreach_campaign_steps (tenant_id,campaign_id,step_number,delay_business_days,subject,body) VALUES ($1,$2,$3,$4,$5,'x')`,
      [a, ids.campaign, n, delay, subject]));
    expect(await denied(() => step(3, "Own subject", 2))).toMatchObject({ code: "23514" });
    expect(await denied(() => step(3, null, 0))).toMatchObject({ code: "23514" });
    expect(await denied(() => step(3, null, 31))).toMatchObject({ code: "23514" });
    expect(await denied(() => step(6, null, 2))).toMatchObject({ code: "23514" });
    expect(await denied(() => fixture.service((tx) => tx.query(
      `INSERT INTO outreach_campaigns (tenant_id,id,name,window_start_min,window_end_min,content_digest,created_by,created_at,updated_at)
       VALUES ($1,$2,'Short',480,500,$3,$4,$5,$5)`, [a, randomUUID(), "a".repeat(64), randomUUID(), T0])))).toMatchObject({ code: "23514" });
    await step(3, null, 2);
  });
});
