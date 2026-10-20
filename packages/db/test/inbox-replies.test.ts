// M3c storage rules at the SQL level (docs/requirements/inbox-home.md I-4, I-9, H-2): the
// inbox_replies_guard trigger holds for the runtime role, the service role and the table owner
// alike, and crm_deals_won_at stamps, keeps and clears the won date from the write's updated_at.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Transaction } from "../src/scoped.js";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";

const T0 = "2026-10-20T09:00:00.000Z";
const T1 = "2026-10-20T10:00:00.000Z";
const T2 = "2026-10-20T11:00:00.000Z";

let database: TestDatabase;
let fixture: TwoTenantFixture;
let tenantId: string;
let contactId: string;
let otherContactId: string;
const author = randomUUID();
const approver = randomUUID();

type Status = "draft" | "approved" | "sent" | "failed" | "discarded";
/** One reply in the given status, with exactly the step columns that status needs. */
async function reply(status: Status): Promise<string> {
  const id = randomUUID();
  const approved = ["approved", "sent", "failed"].includes(status);
  await fixture.service((tx) => tx.query(
    `INSERT INTO inbox_replies (tenant_id,id,contact_id,subject,body,status,drafted_by,created_at,
       approved_by,approved_at,discarded_by,discarded_at,settled_at)
     VALUES ($1,$2,$3,'Your booking','Original words',$4,$5,$6,$7,$8,$9,$10,$11)`,
    [tenantId, id, contactId, status, author, T0,
      approved ? approver : null, approved ? T1 : null,
      status === "discarded" ? approver : null, status === "discarded" ? T1 : null,
      status === "sent" || status === "failed" ? T2 : null],
  ));
  return id;
}

/** The three writers the guard must stop: runtime (tenant scoped), service role, table owner. */
const writers = (): [string, <R>(work: (tx: Transaction) => Promise<R>) => Promise<R>][] => [
  ["service role", (work) => fixture.service(work)],
  ["admin pool", async (work) => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }],
];

/** Every step statement binds the same actor and time, whether or not its SET uses them. */
const typed = "tenant_id=$1 AND id=$2 AND $3::uuid IS NOT NULL AND $4::timestamptz IS NOT NULL";
async function expectGuarded(name: string, run: () => Promise<unknown>) {
  const error = await run().then(() => null, (caught: unknown) => caught);
  expect(error, name).toMatchObject({ code: "23514", constraint: "inbox_replies_guard" });
}
async function row(id: string) {
  return (await fixture.service((tx) => tx.query<Record<string, unknown>>(
    "SELECT status, subject, body, contact_id, drafted_by, created_at, approved_by, approved_at, discarded_at, settled_at FROM inbox_replies WHERE tenant_id=$1 AND id=$2",
    [tenantId, id],
  ))).rows[0]!;
}

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  tenantId = fixture.a.tenantId;
  contactId = randomUUID();
  otherContactId = randomUUID();
  await fixture.service((tx) => tx.query(
    `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,created_at,updated_at)
     VALUES ($1,$2,'Halden & Rowe','office@halden-rowe.example.com',$4,$4),($1,$3,'Other Customer','other@example.com',$4,$4)`,
    [tenantId, contactId, otherContactId, T0],
  ));
});
afterAll(async () => { await database?.close(); });

describe("inbox_replies_guard (I-4)", () => {
  it("refuses changing the words, customer, author or draft time, for the service role and the table owner", async () => {
    const changes: [string, string, unknown][] = [
      ["body", "body=$3", "Different words"],
      ["subject", "subject=$3", "Different subject"],
      ["contact", "contact_id=$3", null],
      ["drafted_by", "drafted_by=$3", randomUUID()],
      ["created_at", "created_at=$3", "2026-10-21T00:00:00.000Z"],
      ["id", "id=$3", randomUUID()],
    ];
    for (const status of ["draft", "approved", "sent"] as const) {
      const id = await reply(status);
      const before = await row(id);
      for (const [writer, run] of writers())
        for (const [column, set, value] of changes)
          await expectGuarded(`${writer} ${status} ${column}`, () => run((tx) => tx.query(
            `UPDATE inbox_replies SET ${set} WHERE tenant_id=$1 AND id=$2`, [tenantId, id, value ?? otherContactId])));
      expect(await row(id)).toEqual(before);
    }
  });

  it("allows only draft to approved or discarded, and approved to sent or failed", async () => {
    const step = {
      approved: "status='approved', approved_by=$3, approved_at=$4",
      discarded: "status='discarded', discarded_by=$3, discarded_at=$4",
      sent: "status='sent', settled_at=$4",
      failed: "status='failed', settled_at=$4",
      // A backward move also clears the later step's columns. The guard runs before the status
      // checks, so it is what refuses every one of these.
      draft: "status='draft', approved_by=NULL, approved_at=NULL, discarded_by=NULL, discarded_at=NULL, settled_at=NULL",
    } satisfies Record<Status, string>;
    const refused: [Status, Status][] = [
      ["draft", "sent"], ["draft", "failed"],
      ["approved", "draft"], ["approved", "discarded"],
      ["discarded", "approved"], ["discarded", "draft"], ["discarded", "sent"],
      ["sent", "approved"], ["sent", "failed"], ["sent", "draft"],
      ["failed", "sent"], ["failed", "approved"],
    ];
    for (const [writer, run] of writers()) {
      for (const [from, to] of refused) {
        const id = await reply(from);
        await expectGuarded(`${writer} ${from} -> ${to}`, () => run((tx) => tx.query(
          `UPDATE inbox_replies SET ${step[to]} WHERE ${typed}`, [tenantId, id, approver, T2])));
        expect((await row(id)).status, `${writer} ${from} -> ${to}`).toBe(from);
      }
    }
    for (const [from, to] of [["draft", "approved"], ["draft", "discarded"], ["approved", "sent"], ["approved", "failed"]] as const) {
      const id = await reply(from);
      await fixture.service((tx) => tx.query(`UPDATE inbox_replies SET ${step[to]} WHERE ${typed}`, [tenantId, id, approver, T2]));
      expect((await row(id)).status).toBe(to);
    }
  });

  it("refuses rewriting a step's record without a status change", async () => {
    const rewrites: [Status, string][] = [
      ["approved", "approved_at=$3"], ["approved", "approved_by=gen_random_uuid()"],
      ["sent", "settled_at=$3"], ["failed", "settled_at=$3"], ["sent", "approved_at=$3"],
      ["discarded", "discarded_at=$3"], ["discarded", "discarded_by=gen_random_uuid()"],
      ["approved", "status='approved', approved_at=$3"],
    ];
    for (const [writer, run] of writers())
      for (const [status, set] of rewrites) {
        const id = await reply(status);
        const before = await row(id);
        await expectGuarded(`${writer} ${status} ${set}`, () => run((tx) => tx.query(
          `UPDATE inbox_replies SET ${set} WHERE tenant_id=$1 AND id=$2 AND $3::timestamptz IS NOT NULL`,
          [tenantId, id, "2026-10-22T00:00:00.000Z"])));
        expect(await row(id)).toEqual(before);
      }
    // A no-op update changes nothing, so it passes; the service role may still delete (erasure).
    const id = await reply("approved");
    await fixture.service((tx) => tx.query("UPDATE inbox_replies SET status=status WHERE tenant_id=$1 AND id=$2", [tenantId, id]));
    expect((await fixture.service((tx) => tx.query("DELETE FROM inbox_replies WHERE tenant_id=$1 AND id=$2", [tenantId, id]))).rowCount).toBe(1);
  });

  it("keeps the approval and discard records through every later step, settling included", async () => {
    // Settling may not rewrite who approved or when (I-4 "never rewrites an earlier step").
    const settles = ["approved_by=gen_random_uuid()", "approved_at=$3", "approved_by=gen_random_uuid(), approved_at=$3"];
    for (const [writer, run] of writers())
      for (const outcome of ["sent", "failed"] as const)
        for (const set of settles) {
          const id = await reply("approved");
          const before = await row(id);
          await expectGuarded(`${writer} approved -> ${outcome} with ${set}`, () => run((tx) => tx.query(
            `UPDATE inbox_replies SET status='${outcome}', settled_at=$3, ${set} WHERE tenant_id=$1 AND id=$2 AND $3::timestamptz IS NOT NULL`,
            [tenantId, id, "2026-10-22T00:00:00.000Z"])));
          expect(await row(id)).toEqual(before);
        }
    // The plain settle still works and keeps the approval as it was.
    const id = await reply("approved");
    await fixture.service((tx) => tx.query(
      "UPDATE inbox_replies SET status='sent', settled_at=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, id, T2]));
    expect(await row(id)).toMatchObject({ status: "sent", approved_by: approver, approved_at: new Date(T1) });
  });

  it("lets the runtime role insert drafts only, never a reply that is already approved or settled", async () => {
    const insert = (columns: string, values: unknown[]) => fixture.a.run((tx) => tx.query(
      `INSERT INTO inbox_replies (tenant_id,id,contact_id,subject,body,drafted_by,created_at${columns})
       VALUES ($1,$2,$3,'S','B',$4,$5${values.map((_, index) => `,$${index + 6}`).join("")})`,
      [tenantId, randomUUID(), contactId, author, T0, ...values]));
    for (const [columns, values] of [
      [",status,approved_by,approved_at", ["approved", approver, T1]],
      [",status,approved_by,approved_at,settled_at", ["sent", approver, T1, T2]],
      [",status,discarded_by,discarded_at", ["discarded", approver, T1]],
      [",status", ["draft"]],
    ] as [string, unknown[]][])
      await expect(insert(columns, values), columns).rejects.toMatchObject({ code: "42501" });
    const id = randomUUID();
    await fixture.a.run((tx) => tx.query(
      `INSERT INTO inbox_replies (tenant_id,id,contact_id,channel,subject,body,drafted_by,created_at)
       VALUES ($1,$2,$3,'email','S','B',$4,$5)`, [tenantId, id, contactId, author, T0]));
    expect(await row(id)).toMatchObject({ status: "draft", approved_at: null, settled_at: null });
  });

  it("holds for the runtime role too, which also lacks the grants for text and settle columns", async () => {
    const approved = await reply("approved");
    await expectGuarded("runtime approved -> draft", () => fixture.a.run((tx) => tx.query(
      "UPDATE inbox_replies SET status='draft', approved_by=NULL, approved_at=NULL WHERE tenant_id=$1 AND id=$2", [tenantId, approved])));
    await expectGuarded("runtime approved_at rewrite", () => fixture.a.run((tx) => tx.query(
      "UPDATE inbox_replies SET approved_at=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, approved, T2])));
    for (const set of ["body='x'", "subject='x'", "settled_at=now()", "contact_id=contact_id", "created_at=created_at"])
      await expect(fixture.a.run((tx) => tx.query(`UPDATE inbox_replies SET ${set} WHERE tenant_id=$1 AND id=$2`, [tenantId, approved])), set)
        .rejects.toMatchObject({ code: "42501" });
    await expect(fixture.a.run((tx) => tx.query("DELETE FROM inbox_replies WHERE tenant_id=$1 AND id=$2", [tenantId, approved])))
      .rejects.toMatchObject({ code: "42501" });
    expect((await row(approved)).status).toBe("approved");
    // Tenant B sees none of it.
    expect((await fixture.b.run((tx) => tx.query("SELECT 1 FROM inbox_replies WHERE tenant_id=$1", [tenantId]))).rowCount).toBe(0);
  });

  it("ties each status to its step columns", async () => {
    const insert = (status: Status, subject = "S", settled: string | null = null) => fixture.service((tx) => tx.query(
      `INSERT INTO inbox_replies (tenant_id,id,contact_id,subject,body,status,drafted_by,created_at,settled_at)
       VALUES ($1,$2,$3,$4,'B',$5,$6,$7,$8)`,
      [tenantId, randomUUID(), contactId, subject, status, author, T0, settled]));
    await expect(insert("approved")).rejects.toMatchObject({ code: "23514", constraint: "inbox_replies_approval_state" });
    await expect(insert("discarded")).rejects.toMatchObject({ code: "23514", constraint: "inbox_replies_discard_state" });
    await expect(insert("draft", "S", T1)).rejects.toMatchObject({ code: "23514", constraint: "inbox_replies_settle_state" });
    await expect(insert("draft", "")).rejects.toMatchObject({ code: "23514", constraint: "inbox_replies_subject_length" });
    await expect(insert("draft", "s".repeat(201))).rejects.toMatchObject({ code: "23514", constraint: "inbox_replies_subject_length" });
  });
});

describe("crm_deals_won_at (H-2)", () => {
  let pipelineId: string;
  const stages = { open: randomUUID(), won: randomUUID(), paid: randomUUID(), lost: randomUUID() };
  const wonAt = async (id: string) => (await fixture.service((tx) => tx.query<{ won_at: Date | null }>(
    "SELECT won_at FROM crm_deals WHERE tenant_id=$1 AND id=$2", [tenantId, id]))).rows[0]!.won_at?.toISOString() ?? null;
  const insertDeal = (run: <R>(work: (tx: Transaction) => Promise<R>) => Promise<R>, stage: keyof typeof stages, at: string) => {
    const id = randomUUID();
    return run((tx) => tx.query(
      `INSERT INTO crm_deals (tenant_id,id,contact_id,pipeline_id,stage_id,title,revision,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,'Commission',1,$6,$6)`, [tenantId, id, contactId, pipelineId, stages[stage], at])).then(() => id);
  };
  const moveTo = (run: <R>(work: (tx: Transaction) => Promise<R>) => Promise<R>, id: string, stage: keyof typeof stages, at: string) =>
    run((tx) => tx.query("UPDATE crm_deals SET stage_id=$3, revision=revision+1, updated_at=$4 WHERE tenant_id=$1 AND id=$2",
      [tenantId, id, stages[stage], at]));

  beforeAll(async () => {
    pipelineId = randomUUID();
    await fixture.service(async (tx) => {
      await tx.query("INSERT INTO crm_pipelines (tenant_id,id,name) VALUES ($1,$2,'Sales')", [tenantId, pipelineId]);
      await tx.query(
        `INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position,outcome)
         VALUES ($1,$3,$2,'New',0,'open'),($1,$4,$2,'Won',1,'won'),($1,$5,$2,'Paid',2,'won'),($1,$6,$2,'Lost',3,'lost')`,
        [tenantId, pipelineId, stages.open, stages.won, stages.paid, stages.lost]);
    });
  });

  it("stamps updated_at on entering a won stage, keeps it between won stages, clears it on leaving", async () => {
    for (const [name, run] of [["runtime", fixture.a.run], ["service role", fixture.service]] as const) {
      const id = await insertDeal(run, "open", T0);
      expect(await wonAt(id), name).toBeNull();
      await moveTo(run, id, "won", T1);
      expect(await wonAt(id), name).toBe(T1);
      await moveTo(run, id, "paid", T2);
      expect(await wonAt(id), name).toBe(T1);
      // Naming the same stage again keeps the date as well.
      await moveTo(run, id, "paid", "2026-10-20T12:00:00.000Z");
      expect(await wonAt(id), name).toBe(T1);
      await moveTo(run, id, "open", "2026-10-20T13:00:00.000Z");
      expect(await wonAt(id), name).toBeNull();
      await moveTo(run, id, "won", "2026-10-20T14:00:00.000Z");
      expect(await wonAt(id), name).toBe("2026-10-20T14:00:00.000Z");
      await moveTo(run, id, "lost", "2026-10-20T15:00:00.000Z");
      expect(await wonAt(id), name).toBeNull();
    }
  });

  it("sets the date for a deal inserted in a won stage, and ignores a supplied won_at", async () => {
    const id = await insertDeal(fixture.service, "won", T1);
    expect(await wonAt(id)).toBe(T1);
    const forged = randomUUID();
    await fixture.service((tx) => tx.query(
      `INSERT INTO crm_deals (tenant_id,id,contact_id,pipeline_id,stage_id,title,revision,created_at,updated_at,won_at)
       VALUES ($1,$2,$3,$4,$5,'Commission',1,$6,$6,$7)`, [tenantId, forged, contactId, pipelineId, stages.open, T1, T0]));
    expect(await wonAt(forged)).toBeNull();
    // Value and source updates leave the date alone, and runtime cannot write it.
    await fixture.a.run((tx) => tx.query(
      "UPDATE crm_deals SET value_minor=500, currency='USD', lead_source='website' WHERE tenant_id=$1 AND id=$2", [tenantId, id]));
    expect(await wonAt(id)).toBe(T1);
    await expect(fixture.a.run((tx) => tx.query("UPDATE crm_deals SET won_at=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, id, T2])))
      .rejects.toMatchObject({ code: "42501" });
    // The service role may write the column, but the trigger keeps the date the stage gave.
    await fixture.service((tx) => tx.query("UPDATE crm_deals SET won_at=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, id, T2]));
    expect(await wonAt(id)).toBe(T1);
    await fixture.service((tx) => tx.query("UPDATE crm_deals SET won_at=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, forged, T2]));
    expect(await wonAt(forged)).toBeNull();
    await expect(fixture.a.run((tx) => tx.query("UPDATE crm_deals SET currency=NULL WHERE tenant_id=$1 AND id=$2", [tenantId, id])))
      .rejects.toMatchObject({ code: "23514", constraint: "crm_deals_value_currency" });
  });
});
