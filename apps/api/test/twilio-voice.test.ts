// Missed-call text-back (docs/requirements/twilio.md T-10..T-14, first slice): signed fixture
// requests only. Twilio is never called; the delivery worker runs over the fake provider.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvalForAction,
  approvalsFromRecords,
  assignVoiceNumber,
  createDeliveryWorker,
  createFakeProvider,
  creditWallet,
  signTwilioRequest,
  type FakeProvider,
} from "@zs/core";
import {
  createApiHarness,
  NOW,
  clock,
  PREVIOUS_TWILIO_AUTH_TOKEN,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WEBHOOK_BASE_URL,
  UNSUBSCRIBE_SECRET,
  type ApiHarness,
} from "./helpers.js";

const NUMBER_A = "+15555550100";
const NUMBER_B = "+15555550101";
const FORWARD = "+15555550199";
const BOOKING_URL = "https://book.haldenrowe.example/reserve";
const DISCLOSURE = "Halden & Rowe: press 1 to get our booking link by text. We will send one text. Reply STOP to opt out.";
const newSid = (prefix: string) => `${prefix}${randomBytes(16).toString("hex")}`;
let nextCaller = 10;
const caller = () => `+155555502${String(nextCaller++).padStart(2, "0")}`;

let h: ApiHarness;
let provider: FakeProvider;
const tenantA = () => h.a.tenantId;
const tenantB = () => h.b.tenantId;

async function post(tenantId: string, suffix: string, fields: Record<string, string>, options: { token?: string; unsigned?: boolean; app?: ApiHarness["app"] } = {}) {
  const params = new URLSearchParams({ AccountSid: TWILIO_ACCOUNT_SID, ...fields });
  const path = `/webhooks/twilio/voice/${tenantId}${suffix}`;
  const signature = signTwilioRequest(options.token ?? TWILIO_AUTH_TOKEN, TWILIO_WEBHOOK_BASE_URL + path, params);
  const response = await (options.app ?? h.app).request(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(options.unsigned ? {} : { "X-Twilio-Signature": signature }) },
    body: params.toString(),
  });
  return { status: response.status, text: await response.text() };
}
const incoming = (tenantId: string, callSid: string, from: string, to = NUMBER_A) =>
  post(tenantId, "", { CallSid: callSid, From: from, To: to, AccountSid: TWILIO_ACCOUNT_SID });
const dialed = (tenantId: string, callSid: string, status: string) =>
  post(tenantId, "/dial", { CallSid: callSid, DialCallStatus: status, AccountSid: TWILIO_ACCOUNT_SID });
const pressed = (tenantId: string, callSid: string, digits: string, version = "v1") =>
  post(tenantId, `/gather?v=${version}`, { CallSid: callSid, Digits: digits, AccountSid: TWILIO_ACCOUNT_SID });
const recorded = (tenantId: string, callSid: string, extra: Record<string, string> = {}) =>
  post(tenantId, "/recording", {
    CallSid: callSid, RecordingSid: newSid("RE"), RecordingStatus: "completed", RecordingDuration: "12",
    AccountSid: TWILIO_ACCOUNT_SID, ...extra,
  });

/** An incoming call followed by the dial leg ending, as Twilio sends them. */
async function missedCall(from = caller(), tenantId = tenantA(), status = "no-answer") {
  const callSid = newSid("CA");
  await incoming(tenantId, callSid, from, tenantId === tenantA() ? NUMBER_A : NUMBER_B);
  const dial = await dialed(tenantId, callSid, status);
  return { callSid, from, dial };
}

const q = <T = Record<string, any>>(sql: string, params: unknown[] = []) =>
  h.fixture.service(async (tx) => (await tx.query(sql, params)).rows as T[]);
/** Reads as the runtime role under one tenant's scope; the service role has no grants on the voice tables. */
const qt = <T = Record<string, any>>(tenantId: string, sql: string, params: unknown[] = []) =>
  h.database.db.tenant(tenantId, async (tx) => (await tx.query(sql, params)).rows as T[]);
const count = async (table: string, tenantId = tenantA()) =>
  Number((await qt<{ n: string }>(tenantId, `SELECT count(*) AS n FROM ${table} WHERE tenant_id=$1`, [tenantId]))[0]!.n);

function worker() {
  return createDeliveryWorker({
    service: (work) => h.fixture.service(work),
    providers: { email: provider, sms: provider },
    approvals: approvalsFromRecords(approvalForAction, clock),
    clock,
    generateId: randomUUID,
    config: {
      workerId: "voice-test", leaseMs: 60_000, providerTimeoutMs: 5_000, maxAttempts: 4, backoffBaseMs: 1_000,
      backoffMaxMs: 60_000, dedupeMarginMs: 60_000, pricing: { currency: "usd", email: 2, smsSegment: 3 },
      unsubscribe: { secret: UNSUBSCRIBE_SECRET, baseUrl: "https://api.example.test/public/v1/unsubscribe" },
    },
  });
}

beforeAll(async () => {
  h = await createApiHarness({
    twilioWebhook: { tokens: { current: TWILIO_AUTH_TOKEN, previous: PREVIOUS_TWILIO_AUTH_TOKEN } },
  });
  provider = createFakeProvider({ clock });
  await h.fixture.service(async (tx) => {
    await tx.query(
      `INSERT INTO sms_numbers (tenant_id,phone_number,help_reply,created_at,updated_at)
       VALUES ($1,$2,NULL,$5,$5),($3,$4,NULL,$5,$5)`, [tenantA(), NUMBER_A, tenantB(), NUMBER_B, NOW]);
    await tx.query("UPDATE tenants SET name='Halden & Rowe' WHERE tenant_id=$1", [tenantA()]);
    await assignVoiceNumber(tx, {
      tenantId: tenantA(), forwardTo: FORWARD, bookingUrl: BOOKING_URL, textbackEnabled: true,
      disclosure: { version: "v1", text: DISCLOSURE }, now: new Date(NOW),
    });
    await assignVoiceNumber(tx, { tenantId: tenantB(), forwardTo: FORWARD, now: new Date(NOW) });
    await creditWallet(tx, { tenantId: tenantA(), ledgerId: randomUUID(), amount: 1000, idempotencyKey: `credit:${randomUUID()}`, now: new Date(NOW) });
  });
});
afterAll(async () => h.close());

describe("signature and shape (T-10)", () => {
  it("answers a signed incoming call with a Dial that names the action URL", async () => {
    const result = await incoming(tenantA(), newSid("CA"), caller());
    expect(result.status).toBe(200);
    expect(result.text).toContain(`<Dial timeout="20" action="${TWILIO_WEBHOOK_BASE_URL}/webhooks/twilio/voice/${tenantA()}/dial">${FORWARD}</Dial>`);
  });

  it("rejects a forged, an unsigned and a wrong-token request with 401 and stores nothing", async () => {
    const before = await count("voice_calls");
    const sid = newSid("CA");
    const fields = { CallSid: sid, From: caller(), To: NUMBER_A };
    expect((await post(tenantA(), "", fields, { token: "f".repeat(32) })).status).toBe(401);
    expect((await post(tenantA(), "", fields, { unsigned: true })).status).toBe(401);
    expect(await count("voice_calls")).toBe(before);
  });

  it("answers 400 for a bad CallSid", async () => {
    expect((await incoming(tenantA(), "CA123", caller())).status).toBe(400);
  });

  it("hangs up on a wrong To and stores nothing", async () => {
    const before = await count("voice_calls");
    const result = await incoming(tenantA(), newSid("CA"), caller(), "+15555550177");
    expect(result.text).toContain("<Hangup/>");
    expect(await count("voice_calls")).toBe(before);
  });

  it("dials without an action when text-back is off", async () => {
    const result = await post(tenantB(), "", { CallSid: newSid("CA"), From: caller(), To: NUMBER_B });
    expect(result.text).toContain(`<Dial timeout="20">${FORWARD}</Dial>`);
    expect(result.text).not.toContain("action=");
  });
});

describe("the dial result (T-11)", () => {
  it("offers the disclosure after no-answer", async () => {
    const { dial } = await missedCall();
    expect(dial.text).toContain("<Gather");
    expect(dial.text).toContain("press 1 to get our booking link by text");
    expect(dial.text).toContain("<Record");
  });

  it("hangs up after completed and canceled calls", async () => {
    for (const status of ["completed", "canceled"]) {
      const { dial } = await missedCall(caller(), tenantA(), status);
      expect(dial.text).toContain("<Hangup/>");
      expect(dial.text).not.toContain("<Gather");
    }
  });

  it("answers a repeated dial callback the same way and charges nothing more", async () => {
    const { callSid, dial } = await missedCall();
    const again = await dialed(tenantA(), callSid, "no-answer");
    expect(again.text).toBe(dial.text);
    expect(await qt(tenantA(), "SELECT 1 FROM actions WHERE tenant_id=$1 AND idempotency_key=$2", [tenantA(), `twilio-voice:${callSid}:dial`])).toHaveLength(1);
  });

  it("gives no offer to a suppressed number", async () => {
    const from = caller();
    await q("INSERT INTO suppressions (tenant_id,channel,address,reason,source,created_at) VALUES ($1,'sms',$2,'stop','test:seed',$3)", [tenantA(), from, NOW]);
    const { dial } = await missedCall(from);
    expect(dial.text).not.toContain("<Gather");
    expect(dial.text).toContain("<Record");
  });

  it("gives no second offer to the same number within 24 hours", async () => {
    const from = caller();
    expect((await missedCall(from)).dial.text).toContain("<Gather");
    expect((await missedCall(from)).dial.text).not.toContain("<Gather");
  });
});

describe("the opt-in (T-12)", () => {
  it("records the consent and sends one text with the booking link, once", async () => {
    const { callSid, from } = await missedCall();
    const first = await pressed(tenantA(), callSid, "1");
    expect(first.text).toContain("on its way");
    const replay = await pressed(tenantA(), callSid, "1");
    expect(replay.status).toBe(200);

    const contacts = await qt(tenantA(), "SELECT id FROM crm_contacts WHERE tenant_id=$1 AND e164_phone=$2", [tenantA(), from]);
    expect(contacts).toHaveLength(1);
    expect(await qt(tenantA(), "SELECT status, source FROM crm_contact_consent WHERE tenant_id=$1 AND contact_id=$2 AND channel='sms'",
      [tenantA(), contacts[0]!.id])).toEqual([{ status: "granted", source: `twilio-voice:${callSid}` }]);
    const consents = await qt(tenantA(), "SELECT disclosure_text, disclosure_version FROM voice_textback_consents WHERE tenant_id=$1 AND call_sid=$2", [tenantA(), callSid]);
    expect(consents).toEqual([{ disclosure_text: DISCLOSURE, disclosure_version: "v1" }]);
    expect(await qt(tenantA(), "SELECT 1 FROM outbox WHERE tenant_id=$1 AND payload->>'contactId'=$2", [tenantA(), contacts[0]!.id])).toHaveLength(1);

    const to = () => provider.delivered.filter((d) => JSON.stringify(d.request).includes(from));
    await worker().runOnce();
    expect(to()).toHaveLength(1);
    expect(JSON.stringify(to()[0]!.request)).toContain(BOOKING_URL);
    await worker().runOnce();
    expect(to()).toHaveLength(1);
  });

  it("writes nothing for no key or another key", async () => {
    for (const digits of ["2", ""]) {
      const { callSid } = await missedCall();
      const consentsBefore = await count("voice_textback_consents");
      const result = await pressed(tenantA(), callSid, digits);
      expect(result.text).not.toContain("on its way");
      expect(await count("voice_textback_consents")).toBe(consentsBefore);
    }
  });

  it("sends nothing when the wording version in the URL is not the one offered", async () => {
    const { callSid } = await missedCall();
    const before = await count("voice_textback_consents");
    expect((await pressed(tenantA(), callSid, "1", "v9")).text).not.toContain("on its way");
    expect(await count("voice_textback_consents")).toBe(before);
  });

  it("sends nothing when a denial was recorded between the dial result and the key", async () => {
    const { callSid, from } = await missedCall();
    const contact = randomUUID();
    await q("INSERT INTO crm_contacts (tenant_id,id,display_name,e164_phone,created_at,updated_at) VALUES ($1,$2,'Guest',$3,$4,$4)", [tenantA(), contact, from, NOW]);
    await q("INSERT INTO crm_contact_consent (tenant_id,contact_id,channel,status,source,recorded_at) VALUES ($1,$2,'sms','denied','test',$3)", [tenantA(), contact, NOW]);
    const result = await pressed(tenantA(), callSid, "1");
    expect(result.text).not.toContain("on its way");
    expect(await qt(tenantA(), "SELECT 1 FROM voice_textback_consents WHERE tenant_id=$1 AND call_sid=$2", [tenantA(), callSid])).toHaveLength(0);
  });

  it("blocks the text when STOP arrives before it is sent", async () => {
    const { callSid, from } = await missedCall();
    await pressed(tenantA(), callSid, "1");
    await q("INSERT INTO suppressions (tenant_id,channel,address,reason,source,created_at) VALUES ($1,'sms',$2,'stop','test:inbound',$3)", [tenantA(), from, NOW]);
    await worker().runOnce();
    expect(provider.delivered.filter((d) => JSON.stringify(d.request).includes(from))).toHaveLength(0);
    const rows = await q(
      `SELECT d.status, d.final_reason FROM message_deliveries d JOIN crm_contacts c ON c.tenant_id=d.tenant_id AND c.id=d.contact_id
        WHERE d.tenant_id=$1 AND c.e164_phone=$2`, [tenantA(), from]);
    expect(rows).toEqual([{ status: "blocked", final_reason: "suppressed" }]);
  });
});

describe("voicemail (T-13)", () => {
  it("files one voicemail per call and ignores a replay", async () => {
    const { callSid, from } = await missedCall();
    const fields = { RecordingSid: newSid("RE") };
    expect((await recorded(tenantA(), callSid, fields)).status).toBe(200);
    expect((await recorded(tenantA(), callSid, { RecordingSid: newSid("RE") })).status).toBe(200);
    const rows = await qt(tenantA(), "SELECT caller_e164, duration_seconds, status FROM voicemails WHERE tenant_id=$1 AND call_sid=$2", [tenantA(), callSid]);
    expect(rows).toEqual([{ caller_e164: from, duration_seconds: 12, status: "new" }]);
  });

  it("ignores a recording that is not completed or has no length", async () => {
    const { callSid } = await missedCall();
    await recorded(tenantA(), callSid, { RecordingStatus: "failed" });
    await recorded(tenantA(), callSid, { RecordingDuration: "0" });
    expect(await qt(tenantA(), "SELECT 1 FROM voicemails WHERE tenant_id=$1 AND call_sid=$2", [tenantA(), callSid])).toHaveLength(0);
  });

  it("hangs up on the Record action callback", async () => {
    const { callSid } = await missedCall();
    expect((await post(tenantA(), "/recording?step=done", { CallSid: callSid })).text).toContain("<Hangup/>");
  });
});

describe("tenant isolation", () => {
  it("hides tenant A's calls, consents and voicemails from tenant B under the runtime role", async () => {
    const { callSid } = await missedCall();
    await pressed(tenantA(), callSid, "1");
    await recorded(tenantA(), callSid);
    for (const table of ["voice_calls", "voice_textback_consents", "voicemails", "voice_numbers", "voice_textback_disclosures"]) {
      const seen = await h.database.db.tenant(tenantB(), async (tx) => (await tx.query(`SELECT * FROM ${table} WHERE tenant_id=$1`, [tenantA()])).rows);
      expect(seen).toEqual([]);
    }
  });

  it("changes nothing when tenant A's CallSid is posted to tenant B's URLs", async () => {
    const { callSid } = await missedCall();
    const before = [await count("voice_calls", tenantB()), await count("voice_textback_consents", tenantB()), await count("voicemails", tenantB())];
    await dialed(tenantB(), callSid, "no-answer");
    await pressed(tenantB(), callSid, "1");
    await recorded(tenantB(), callSid);
    expect([await count("voice_calls", tenantB()), await count("voice_textback_consents", tenantB()), await count("voicemails", tenantB())]).toEqual(before);
  });
});

describe("replays and races (T-14)", () => {
  it("replays the stored answer to a repeated incoming webhook after the settings change", async () => {
    const callSid = newSid("CA");
    const from = caller();
    const first = await incoming(tenantA(), callSid, from);
    await q("UPDATE voice_numbers SET forward_to_e164='+15555550188', ring_seconds=30 WHERE tenant_id=$1", [tenantA()]);
    try {
      expect((await incoming(tenantA(), callSid, from)).text).toBe(first.text);
    } finally {
      await q("UPDATE voice_numbers SET forward_to_e164=$2, ring_seconds=20 WHERE tenant_id=$1", [tenantA(), FORWARD]);
    }
  });

  it("charges the limits once when two dial callbacks arrive together", async () => {
    let takes = 0;
    const counting = await createApiHarness({
      twilioWebhook: { limiter: { take: async () => { takes += 1; return { ok: true as const }; } } },
    });
    try {
      await counting.fixture.service(async (tx) => {
        await tx.query("INSERT INTO sms_numbers (tenant_id,phone_number,created_at,updated_at) VALUES ($1,$2,$3,$3)", [counting.a.tenantId, NUMBER_A, NOW]);
        await assignVoiceNumber(tx, {
          tenantId: counting.a.tenantId, forwardTo: FORWARD, bookingUrl: BOOKING_URL, textbackEnabled: true,
          disclosure: { version: "v1", text: DISCLOSURE }, now: new Date(NOW),
        });
      });
      const callSid = newSid("CA");
      await post(counting.a.tenantId, "", { CallSid: callSid, From: caller(), To: NUMBER_A }, { app: counting.app });
      const [one, two] = await Promise.all([
        post(counting.a.tenantId, "/dial", { CallSid: callSid, DialCallStatus: "no-answer" }, { app: counting.app }),
        post(counting.a.tenantId, "/dial", { CallSid: callSid, DialCallStatus: "no-answer" }, { app: counting.app }),
      ]);
      expect(one.text).toBe(two.text);
      expect(takes).toBe(2);
    } finally {
      await counting.close();
    }
  });
});

describe("limiter failure (T-14)", () => {
  it("apologizes and hangs up without an offer or a recording", async () => {
    const broken = await createApiHarness({
      twilioWebhook: { limiter: { take: async () => { throw new Error("limiter down"); } } },
    });
    try {
      await broken.fixture.service(async (tx) => {
        await tx.query("INSERT INTO sms_numbers (tenant_id,phone_number,created_at,updated_at) VALUES ($1,$2,$3,$3)", [broken.a.tenantId, NUMBER_A, NOW]);
        await assignVoiceNumber(tx, {
          tenantId: broken.a.tenantId, forwardTo: FORWARD, bookingUrl: BOOKING_URL, textbackEnabled: true,
          disclosure: { version: "v1", text: DISCLOSURE }, now: new Date(NOW),
        });
      });
      const callSid = newSid("CA");
      await post(broken.a.tenantId, "", { CallSid: callSid, From: caller(), To: NUMBER_A }, { app: broken.app });
      const result = await post(broken.a.tenantId, "/dial", { CallSid: callSid, DialCallStatus: "no-answer" }, { app: broken.app });
      expect(result.text).toContain("<Say>");
      expect(result.text).toContain("<Hangup/>");
      expect(result.text).not.toContain("<Gather");
      expect(result.text).not.toContain("<Record");
    } finally {
      await broken.close();
    }
  });
});
