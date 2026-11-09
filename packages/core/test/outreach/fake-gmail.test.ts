import { describe, expect, it } from "vitest";
import { FakeGmail } from "../../src/outreach/fake-gmail.js";
import { GmailRequestFailed } from "../../src/outreach/gmail-port.js";
import { buildRawMessage, type RawMessageInput } from "../../src/outreach/mime.js";

const clock = { now: () => new Date("2026-11-09T16:05:00.000Z") };
const message = (change: Partial<RawMessageInput> = {}): string => buildRawMessage({
  fromName: "Sam", fromAddress: "sam@sender.example", to: "pat@acme.example", subject: "Quick idea", body: "Hello\n",
  date: clock.now(), sendId: "send-1", unsubscribeUrl: "https://hub.example/u/t", ...change,
});
async function setup() {
  const fake = new FakeGmail(clock);
  const refresh = fake.addMailbox("sam@sender.example");
  const { accessToken } = await fake.oauth.refreshAccessToken(refresh);
  return { fake, token: accessToken };
}

describe("FakeGmail", () => {
  it("records a send with its decoded headers and body, and it sends again on a repeat (no idempotency key)", async () => {
    const { fake, token } = await setup();
    await fake.send(token, { raw: message() });
    await fake.send(token, { raw: message() });
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[0]).toMatchObject({ mailbox: "sam@sender.example", to: "pat@acme.example", subject: "Quick idea", body: "Hello\n" });
    expect(fake.sent[0]!.headers["x-zs-ref"]).toBe("send-1");
    expect(fake.sent[0]!.headers["message-id"]).toMatch(/^<fake-\d+@mail\.fake\.example>$/);
  });

  it("joins a thread only with a thread id, In-Reply-To, References and a matching subject", async () => {
    const { fake, token } = await setup();
    const first = await fake.send(token, { raw: message() });
    const id = fake.sent[0]!.headers["message-id"]!;
    const followUp = (change: Partial<RawMessageInput>) => message({ subject: "Re: Quick idea", inReplyTo: id, references: [id], ...change });
    expect((await fake.send(token, { raw: followUp({}), threadId: first.threadId })).threadId).toBe(first.threadId);
    expect((await fake.send(token, { raw: followUp({}) })).threadId).not.toBe(first.threadId);
    expect((await fake.send(token, { raw: followUp({ subject: "Re: Another subject" }), threadId: first.threadId })).threadId).not.toBe(first.threadId);
    expect((await fake.send(token, { raw: message({ subject: "Re: Quick idea" }), threadId: first.threadId })).threadId).not.toBe(first.threadId);
  });

  it("plays scripted outcomes: errors record nothing, a timeout after accepting records the message", async () => {
    const { fake, token } = await setup();
    fake.script("sam@sender.example", "send", { status: 429 }, { status: 403, reason: "dailyLimitExceeded" }, "timeout_before", "timeout_after");
    for (const expected of ["google_429", "google_403_dailylimitexceeded", "gmail_network"])
      await expect(fake.send(token, { raw: message() })).rejects.toMatchObject({ code: expected });
    expect(fake.sent).toHaveLength(0);
    await expect(fake.send(token, { raw: message() })).rejects.toBeInstanceOf(GmailRequestFailed);
    expect(fake.sent).toHaveLength(1);
    await fake.send(token, { raw: message() });
    expect(fake.sent).toHaveLength(2);
  });

  it("answers inbound mail through history with a cursor, pages and expiry", async () => {
    const { fake, token } = await setup();
    const start = fake.currentHistoryId("sam@sender.example");
    fake.setHistoryPageSize("sam@sender.example", 2);
    for (let n = 0; n < 5; n += 1) fake.receive("sam@sender.example", { from: `p${n}@acme.example` });
    const ids: string[] = [];
    let page = await fake.listHistory(token, { startHistoryId: start });
    ids.push(...page.messages.map((m) => m.id));
    while (page.nextPageToken !== null) {
      page = await fake.listHistory(token, { startHistoryId: start, pageToken: page.nextPageToken });
      ids.push(...page.messages.map((m) => m.id));
    }
    expect(ids).toHaveLength(5);
    expect((await fake.listHistory(token, { startHistoryId: page.historyId })).messages).toEqual([]);
    fake.expireHistoryThrough("sam@sender.example", Number(start) + 1);
    await expect(fake.listHistory(token, { startHistoryId: start })).rejects.toMatchObject({ code: "history_expired", status: 404 });
  });

  it("returns only the requested headers, null for a missing message or thread, and 401 for an unknown token", async () => {
    const { fake, token } = await setup();
    const sent = await fake.send(token, { raw: message() });
    const metadata = await fake.getMessageHeaders(token, sent.id, ["X-Zs-Ref", "Message-ID"]);
    expect(Object.keys(metadata!.headers).sort()).toEqual(["message-id", "x-zs-ref"]);
    expect(metadata!.labelIds).toEqual(["SENT"]);
    expect(await fake.getMessageHeaders(token, "nope", ["From"])).toBeNull();
    expect(await fake.getThreadHeaders(token, "nope", ["From"])).toBeNull();
    expect((await fake.getThreadHeaders(token, sent.threadId, ["From"]))).toHaveLength(1);
    await expect(fake.send("stale-token", { raw: message() })).rejects.toMatchObject({ status: 401 });
    expect(await fake.getProfile(token)).toMatchObject({ emailAddress: "sam@sender.example" });
  });

  it("scripts the token endpoint and records revokes", async () => {
    const fake = new FakeGmail(clock);
    const refresh = fake.addMailbox("sam@sender.example");
    fake.script("sam@sender.example", "refresh", { status: "invalid_grant" });
    await expect(fake.oauth.refreshAccessToken(refresh)).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(fake.oauth.refreshAccessToken("unknown")).rejects.toMatchObject({ code: "invalid_grant" });
    await fake.oauth.refreshAccessToken(refresh);
    await fake.oauth.revoke(refresh);
    expect(fake.revoked).toEqual([refresh]);
  });
});
