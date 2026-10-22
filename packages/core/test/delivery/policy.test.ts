// M3d pure rules: pricing, consent decisions, keywords, tokens, payload schema, worker config.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { messageSendRequestedSchema } from "@zs/contracts";
import {
  approvalsFromRecords,
  backoffMs,
  consentBlock,
  createDeliveryWorker,
  createFakeProvider,
  deliveryContentDigest,
  signUnsubscribeToken,
  smsKeyword,
  smsSegments,
  verifyUnsubscribeToken,
} from "../../src/index.js";

describe("smsSegments", () => {
  it.each([
    ["", 1], ["a".repeat(160), 1], ["a".repeat(161), 2], ["a".repeat(306), 2], ["a".repeat(307), 3],
    // Extension characters take two septets.
    ["€".repeat(80), 1], ["€".repeat(81), 2],
    // Anything outside GSM 03.38 switches the whole message to UCS-2.
    ["é".repeat(160), 1], ["ł".repeat(70), 1], ["ł".repeat(71), 2], ["ł".repeat(134), 2], ["ł".repeat(135), 3],
    ["🙂".repeat(35), 1], ["🙂".repeat(36), 2],
  ])("%j is %d segment(s)", (text, segments) => {
    expect(smsSegments(text)).toBe(segments);
  });
});

describe("consentBlock", () => {
  it.each([
    ["email", "transactional", null, false, null],
    ["email", "transactional", "granted", false, null],
    ["email", "transactional", "denied", false, "consent_denied"],
    ["email", "marketing", null, false, "consent_missing"],
    ["email", "marketing", "granted", false, null],
    ["sms", "transactional", null, false, "consent_missing"],
    ["sms", "transactional", "granted", false, null],
    ["sms", "marketing", "denied", false, "consent_denied"],
    ["email", "transactional", "granted", true, "suppressed"],
  ] as const)("%s %s consent=%s suppressed=%s -> %s", (channel, purpose, consent, suppressed, expected) => {
    expect(consentBlock({ channel, purpose, consent, suppressed })).toBe(expected);
  });
});

it.each([
  ["STOP", "stop"], [" stop ", "stop"], ["Stop.", "stop"], ["STOPALL", "stop"], ["Unsubscribe", "stop"], ["cancel", "stop"],
  ["end", "stop"], ["QUIT", "stop"], ["revoke", "stop"], ["opt out", "stop"], ["opt-out", "stop"],
  ["START", "start"], ["unstop", "start"], ["Yes!", "start"], ["HELP", "help"], ["info", "help"],
  ["please stop texting me", null], ["stopping by later", null], ["", null],
  // D-9: the bound applies to what is left once surrounding spaces and punctuation are gone.
  [" ".repeat(65) + "STOP", "stop"], ["\n".repeat(200) + "start!!!" + " ".repeat(200), "start"], [".".repeat(100) + "HELP?", "help"],
  [" ".repeat(65) + "x".repeat(65), null], ["stop " + "x".repeat(70), null],
])("smsKeyword(%j) is %s", (body, keyword) => {
  expect(smsKeyword(body)).toBe(keyword);
});

describe("unsubscribe tokens", () => {
  const secret = "unsubscribe-secret-unsubscribe-secret";
  const ref = { tenantId: randomUUID(), deliveryId: randomUUID() };

  it("round-trips and refuses tampering", () => {
    const token = signUnsubscribeToken(secret, ref);
    expect(token).toMatch(/^zsu1_[A-Za-z0-9_-]{64}$/);
    expect(verifyUnsubscribeToken({ current: secret }, token)).toEqual(ref);
    const flipped = token.slice(0, 10) + (token[10] === "A" ? "B" : "A") + token.slice(11);
    expect(verifyUnsubscribeToken({ current: secret }, flipped)).toBeNull();
    expect(verifyUnsubscribeToken({ current: "other-secret-other-secret-other" }, token)).toBeNull();
    expect(verifyUnsubscribeToken({ current: secret }, token.replace("zsu1_", "zsb1_"))).toBeNull();
    expect(verifyUnsubscribeToken({ current: secret }, `${token}=`)).toBeNull();
  });
});

describe("content digest", () => {
  const base = {
    messageId: randomUUID(), contactId: randomUUID(), channel: "email", purpose: "transactional",
    subject: "Hello", body: "See you Tuesday.",
  } as const;
  it("changes with any field the approval covers", () => {
    const digest = deliveryContentDigest(base);
    expect(deliveryContentDigest({ ...base })).toBe(digest);
    for (const change of [{ body: "See you Wednesday." }, { subject: "Hi" }, { contactId: randomUUID() },
      { purpose: "marketing" as const }, { messageId: randomUUID() }])
      expect(deliveryContentDigest({ ...base, ...change })).not.toBe(digest);
  });
});

describe("message.send_requested payload (D-1)", () => {
  const ids = { messageId: randomUUID(), contactId: randomUUID() };
  it("needs a one-line subject for email and none for SMS, and carries no address", () => {
    expect(messageSendRequestedSchema.safeParse({ ...ids, channel: "email", purpose: "transactional", subject: "Hi", body: "x" }).success).toBe(true);
    expect(messageSendRequestedSchema.safeParse({ ...ids, channel: "email", purpose: "transactional", body: "x" }).success).toBe(false);
    expect(messageSendRequestedSchema.safeParse({ ...ids, channel: "email", purpose: "transactional", subject: "a\nBcc: x", body: "x" }).success).toBe(false);
    expect(messageSendRequestedSchema.parse({ ...ids, channel: "sms", purpose: "marketing", body: "x" }).subject).toBeNull();
    expect(messageSendRequestedSchema.safeParse({ ...ids, channel: "sms", purpose: "marketing", subject: "Hi", body: "x" }).success).toBe(false);
    expect(messageSendRequestedSchema.safeParse({ ...ids, channel: "sms", purpose: "marketing", body: "x", to: "+15555550100" }).success).toBe(false);
  });
});

describe("worker config", () => {
  const clock = { now: () => new Date("2026-10-20T09:00:00.000Z") };
  const provider = createFakeProvider({ clock });
  const deps = {
    service: async () => { throw new Error("unused"); },
    providers: { email: provider, sms: provider },
    approvals: { check: async () => "approved" as const },
    clock,
    generateId: randomUUID,
  };
  const config = {
    workerId: "w", pricing: { email: 1, smsSegment: 1 },
    unsubscribe: { secret: "x".repeat(32), baseUrl: "https://api.example.test/public/v1/unsubscribe" },
  };
  it("applies defaults and refuses a provider timeout that could outlive the lease", () => {
    expect(createDeliveryWorker({ ...deps, config }).config).toMatchObject({ leaseMs: 60_000, providerTimeoutMs: 15_000, maxAttempts: 6 });
    expect(() => createDeliveryWorker({ ...deps, config: { ...config, leaseMs: 10_000, providerTimeoutMs: 6_000 } })).toThrow(/half of leaseMs/);
    expect(() => createDeliveryWorker({ ...deps, config: { ...config, unsubscribe: { ...config.unsubscribe, secret: "short" } } })).toThrow();
  });
  it("backs off exponentially up to the cap", () => {
    expect([1, 2, 3, 4, 10].map((attempt) => backoffMs(attempt, 1_000, 5_000))).toEqual([1_000, 2_000, 4_000, 5_000, 5_000]);
  });
});

describe("approvalsFromRecords (M3b approvalForAction behind the port)", () => {
  it.each([
    [null, "missing"],
    [{ kind: "direct" }, "approved"],
    [{ kind: "stored", standing: "approved" }, "approved"],
    [{ kind: "stored", standing: "pending" }, "missing"],
    [{ kind: "stored", standing: "revoked" }, "revoked"],
    [{ kind: "stored", standing: "expired" }, "revoked"],
    [{ kind: "stored", standing: "rejected" }, "revoked"],
  ] as const)("%j -> %s", async (found, expected) => {
    const seen: unknown[] = [];
    const port = approvalsFromRecords(async (_tx, tenantId, actionId, now) => {
      seen.push([tenantId, actionId, now.toISOString()]);
      return found;
    }, { now: () => new Date("2026-10-20T09:00:00.000Z") });
    const tx = { query: async () => { throw new Error("unused"); } } as never;
    expect(await port.check(tx, { tenantId: "t", actionId: "a", messageId: "m", contentDigest: "d" })).toBe(expected);
    expect(seen).toEqual([["t", "a", "2026-10-20T09:00:00.000Z"]]);
  });
});
