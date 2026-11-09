import { describe, expect, it } from "vitest";
import { createGmailClient, GMAIL_RESPONSE_LIMIT_BYTES } from "../../src/outreach/gmail.js";
import { GmailRequestFailed } from "../../src/outreach/gmail-port.js";

interface Seen { method: string; url: URL; headers: Record<string, string>; body: unknown; redirect: string | undefined }
function stub(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = async (input: string, init: RequestInit) => {
    const entry: Seen = {
      method: String(init.method), url: new URL(input), headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined, redirect: init.redirect,
    };
    seen.push(entry);
    return respond(entry);
  };
  return { seen, client: createGmailClient({ fetch, config: { baseUrl: "https://gmail.test" } }) };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const TOKEN = "access-token-value";
const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as GmailRequestFailed);

describe("createGmailClient requests (OS-21)", () => {
  it("sends raw and threadId with a POST to messages.send and a bearer token in the header only", async () => {
    const { seen, client } = stub(() => json(200, { id: "m1", threadId: "t1", labelIds: ["SENT"] }));
    expect(await client.send(TOKEN, { raw: "cmF3", threadId: "t0" })).toEqual({ id: "m1", threadId: "t1", labelIds: ["SENT"] });
    await client.send(TOKEN, { raw: "cmF3" });
    expect(seen[0]).toMatchObject({ method: "POST", redirect: "manual", body: { raw: "cmF3", threadId: "t0" } });
    expect(seen[0]!.url.pathname).toBe("/gmail/v1/users/me/messages/send");
    expect(seen[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[1]!.body).toEqual({ raw: "cmF3" });
    for (const entry of seen) expect(entry.url.href).not.toContain(TOKEN);
  });

  it("reads message metadata with the header names in the query, and returns null for a message Gmail lost", async () => {
    const { seen, client } = stub((request) => request.url.pathname.endsWith("/gone")
      ? json(404, { error: { code: 404, status: "NOT_FOUND" } })
      : json(200, { id: "m1", threadId: "t1", labelIds: ["INBOX"], payload: { headers: [
        { name: "From", value: "a@b.c" }, { name: "X-Zs-Ref", value: "ref-1" }, { name: "Received", value: "ignored" }] } }));
    const message = await client.getMessageHeaders(TOKEN, "m1", ["From", "X-Zs-Ref"]);
    expect(message).toEqual({ id: "m1", threadId: "t1", labelIds: ["INBOX"], headers: { from: "a@b.c", "x-zs-ref": "ref-1" } });
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url.pathname).toBe("/gmail/v1/users/me/messages/m1");
    expect(seen[0]!.url.searchParams.get("format")).toBe("metadata");
    expect(seen[0]!.url.searchParams.getAll("metadataHeaders")).toEqual(["From", "X-Zs-Ref"]);
    expect(await client.getMessageHeaders(TOKEN, "gone", ["From"])).toBeNull();
  });

  it("reads thread metadata, null when the thread is gone", async () => {
    const { seen, client } = stub((request) => request.url.pathname.endsWith("/gone")
      ? json(404, {})
      : json(200, { messages: [{ id: "m1", threadId: "t1", labelIds: ["SENT"], payload: { headers: [{ name: "Message-ID", value: "<x@y>" }] } }, { id: "m2", threadId: "t1" }] }));
    expect(await client.getThreadHeaders(TOKEN, "t1", ["Message-ID"])).toEqual([
      { id: "m1", threadId: "t1", labelIds: ["SENT"], headers: { "message-id": "<x@y>" } },
      { id: "m2", threadId: "t1", labelIds: [], headers: {} },
    ]);
    expect(seen[0]!.url.pathname).toBe("/gmail/v1/users/me/threads/t1");
    expect(seen[0]!.url.searchParams.get("format")).toBe("metadata");
    expect(await client.getThreadHeaders(TOKEN, "gone", ["Message-ID"])).toBeNull();
  });

  it("lists messageAdded history and answers the cursor and the next page", async () => {
    const { seen, client } = stub(() => json(200, {
      history: [{ id: "5", messagesAdded: [{ message: { id: "m1", threadId: "t1", labelIds: ["INBOX"] } }, { message: { id: "m2", threadId: "t2" } }] }, { id: "6" }],
      nextPageToken: "next", historyId: "77",
    }));
    expect(await client.listHistory(TOKEN, { startHistoryId: "50", pageToken: "p1" })).toEqual({
      messages: [{ id: "m1", threadId: "t1", labelIds: ["INBOX"] }, { id: "m2", threadId: "t2", labelIds: [] }], historyId: "77", nextPageToken: "next",
    });
    expect(seen[0]!.url.pathname).toBe("/gmail/v1/users/me/history");
    expect(Object.fromEntries(seen[0]!.url.searchParams)).toEqual({ startHistoryId: "50", historyTypes: "messageAdded", maxResults: "100", pageToken: "p1" });
  });

  it("maps a history 404 to history_expired", async () => {
    const { client } = stub(() => json(404, { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }));
    expect(await failure(client.listHistory(TOKEN, { startHistoryId: "1" }))).toMatchObject({ code: "history_expired", retry: false, status: 404 });
  });

  it("reads the profile", async () => {
    const { seen, client } = stub(() => json(200, { emailAddress: "me@example.com", historyId: "123", messagesTotal: 9 }));
    expect(await client.getProfile(TOKEN)).toEqual({ emailAddress: "me@example.com", historyId: "123" });
    expect(seen[0]!.url.pathname).toBe("/gmail/v1/users/me/profile");
  });
});

describe("createGmailClient error mapping (OS-15)", () => {
  const body = (status: number, reason: string, message = "secret detail ya29.token-looking-text") =>
    json(status, { error: { code: status, message, errors: [{ message, domain: "usageLimits", reason }], status: "X" } });
  const cases: Array<[string, Response, { code: string; retry: boolean; status: number; reason: string | null }]> = [
    ["400", body(400, "invalidArgument"), { code: "google_400_invalidargument", retry: false, status: 400, reason: "invalidargument" }],
    ["401", body(401, "authError"), { code: "google_401_autherror", retry: false, status: 401, reason: "autherror" }],
    ["403 insufficientPermissions", body(403, "insufficientPermissions"), { code: "google_403_insufficientpermissions", retry: false, status: 403, reason: "insufficientpermissions" }],
    ["403 rateLimitExceeded", body(403, "rateLimitExceeded"), { code: "google_403_ratelimitexceeded", retry: true, status: 403, reason: "ratelimitexceeded" }],
    ["403 userRateLimitExceeded", body(403, "userRateLimitExceeded"), { code: "google_403_userratelimitexceeded", retry: true, status: 403, reason: "userratelimitexceeded" }],
    ["403 dailyLimitExceeded", body(403, "dailyLimitExceeded"), { code: "google_403_dailylimitexceeded", retry: false, status: 403, reason: "dailylimitexceeded" }],
    ["429", body(429, "rateLimitExceeded"), { code: "google_429_ratelimitexceeded", retry: true, status: 429, reason: "ratelimitexceeded" }],
    ["500", json(500, {}), { code: "google_500", retry: true, status: 500, reason: null }],
    ["503", json(503, "not an object"), { code: "google_503", retry: true, status: 503, reason: null }],
  ];
  it.each(cases)("maps %s on send without keeping the response text", async (_label, response, expected) => {
    const { client } = stub(() => response.clone());
    const error = await failure(client.send(TOKEN, { raw: "x" }));
    expect(error).toBeInstanceOf(GmailRequestFailed);
    expect(error).toMatchObject(expected);
    expect(JSON.stringify(error)).not.toContain("secret detail");
    expect((error as Error).message).not.toContain("ya29");
  });

  it("maps a thrown fetch to a retryable gmail_network without the cause", async () => {
    const client = createGmailClient({ fetch: async () => { throw new Error(`socket closed for https://gmail.test/?access_token=${TOKEN}`); } });
    const error = await failure(client.send(TOKEN, { raw: "x" }));
    expect(error).toMatchObject({ code: "gmail_network", retry: true, status: null });
    expect(String((error as Error).message) + JSON.stringify(error)).not.toContain(TOKEN);
  });

  it("maps an abort to gmail_network", async () => {
    const controller = new AbortController();
    const client = createGmailClient({ fetch: async (_url, init) => { await new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))); return json(200, {}); } });
    const pending = failure(client.send(TOKEN, { raw: "x" }, { signal: controller.signal }));
    controller.abort();
    expect(await pending).toMatchObject({ code: "gmail_network", retry: true });
  });

  it("treats an unreadable success body as an unknown-outcome error and refuses an oversize answer", async () => {
    const { client } = stub(() => new Response("<html>", { status: 200 }));
    expect(await failure(client.send(TOKEN, { raw: "x" }))).toMatchObject({ code: "gmail_unreadable_response", retry: true });
    const big = createGmailClient({ fetch: async () => new Response("x".repeat(GMAIL_RESPONSE_LIMIT_BYTES + 10), { status: 200 }) });
    expect(await failure(big.getProfile(TOKEN))).toMatchObject({ code: "gmail_response_too_large", retry: false });
  });

  it("rejects a base URL that is not https or loopback", () => {
    expect(() => createGmailClient({ config: { baseUrl: "http://gmail.example.com" } })).toThrow(/Invalid Gmail config/);
    expect(() => createGmailClient({ config: { baseUrl: "http://127.0.0.1:9999" } })).not.toThrow();
  });
});

describe("the fetch guard (OS-25)", () => {
  it("throws real_google_call_in_test when the real client runs without an injected fetch", async () => {
    const client = createGmailClient();
    await expect(client.getProfile(TOKEN)).rejects.toThrow("real_google_call_in_test");
    await expect(client.send(TOKEN, { raw: "x" })).rejects.toThrow("real_google_call_in_test");
    await expect(fetch("https://oauth2.googleapis.com/token")).rejects.toThrow("real_google_call_in_test");
    await expect(fetch("https://accounts.google.com/o/oauth2/v2/auth")).rejects.toThrow("real_google_call_in_test");
    await expect(fetch(new URL("https://gmail.googleapis.com/gmail/v1/users/me/profile"))).rejects.toThrow("real_google_call_in_test");
  });

  it("does not stop a loopback fake server", async () => {
    await expect(fetch("http://127.0.0.1:1/")).rejects.not.toThrow("real_google_call_in_test");
  });
});
