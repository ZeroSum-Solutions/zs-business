// An in-memory Gmail and Google token endpoint for tests (outreach-sequencer.md OS-25). Original code. It keeps
// mailboxes, threads, history ids and messages; records every sent message with its decoded headers and body; plays
// scripted outcomes per call; and lets a test add inbound mail (a reply, a bounce, an out-of-office). It follows the
// two Gmail rules the sequencer depends on: a sent message joins a thread only with a matching thread id, In-Reply-To
// and References and a matching subject; and it has no idempotency key, so a repeated send sends again.
import { GmailRequestFailed, type GmailCallOptions, type GmailHistoryPage, type GmailMessageMetadata, type GmailPort, type GmailSendResult } from "./gmail-port.js";
import { parseRawMessage } from "./mime.js";

export type FakeOp = "send" | "getMessage" | "getThread" | "history" | "profile" | "refresh";
/** What a scripted call does. `accept` is the default when nothing is scripted. */
export type FakeOutcome =
  | "accept"
  | "timeout_before"
  | "timeout_after"
  | "history_404"
  | { readonly status: 400 | 401 | 404 | 429 | 500 | 503 }
  | { readonly status: 403; readonly reason: string }
  | { readonly status: "invalid_grant" };

export interface FakeSentMessage {
  readonly mailbox: string;
  readonly id: string;
  readonly threadId: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly raw: string;
  readonly at: Date;
}
export interface FakeCall {
  readonly op: FakeOp;
  readonly mailbox: string | null;
}

interface StoredMessage {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds: string[];
  readonly headers: Record<string, string>;
  readonly historyId: number;
  readonly at: Date;
}
interface Mailbox {
  readonly address: string;
  readonly refreshToken: string;
  historyId: number;
  oldestHistoryId: number;
  readonly messages: Map<string, StoredMessage>;
  readonly threads: Map<string, string[]>;
  readonly script: Map<FakeOp, FakeOutcome[]>;
  historyPageSize: number;
}

const normalizeSubject = (subject: string) => subject.replace(/^(\s*re:\s*)+/i, "").trim().toLowerCase();

export class FakeGmail implements GmailPort {
  readonly sent: FakeSentMessage[] = [];
  readonly calls: FakeCall[] = [];
  /** Addresses a revoke was called for, by refresh token. */
  readonly revoked: string[] = [];
  /** Every access token minted, to prove none reaches a log. */
  readonly accessTokens: string[] = [];
  private readonly mailboxes = new Map<string, Mailbox>();
  private readonly tokens = new Map<string, string>();
  private counter = 0;

  constructor(private readonly clock: { now(): Date }) {}

  private next(prefix: string): string {
    this.counter += 1;
    return `${prefix}${this.counter}`;
  }

  /** Adds a mailbox and returns the refresh token a test seals for it. */
  addMailbox(address: string, refreshToken = `fake-refresh-${address}`): string {
    const key = address.toLowerCase();
    this.mailboxes.set(key, {
      address: key, refreshToken, historyId: 1000, oldestHistoryId: 0, messages: new Map(), threads: new Map(), script: new Map(), historyPageSize: 100,
    });
    return refreshToken;
  }

  private box(address: string): Mailbox {
    const box = this.mailboxes.get(address.toLowerCase());
    if (!box) throw new Error(`FakeGmail has no mailbox ${address}`);
    return box;
  }

  /** Queues outcomes for the next calls of `op` on a mailbox. */
  script(address: string, op: FakeOp, ...outcomes: FakeOutcome[]): void {
    const box = this.box(address);
    box.script.set(op, [...(box.script.get(op) ?? []), ...outcomes]);
  }
  setHistoryPageSize(address: string, size: number): void {
    this.box(address).historyPageSize = size;
  }
  /** Gmail no longer keeps history at or before `historyId`. */
  expireHistoryThrough(address: string, historyId: number): void {
    this.box(address).oldestHistoryId = historyId;
  }
  /** Gmail forgets a thread (the owner deleted it). */
  deleteThread(address: string, threadId: string): void {
    const box = this.box(address);
    for (const id of box.threads.get(threadId) ?? []) box.messages.delete(id);
    box.threads.delete(threadId);
  }

  private take(box: Mailbox | null, op: FakeOp): FakeOutcome {
    this.calls.push({ op, mailbox: box?.address ?? null });
    return box?.script.get(op)?.shift() ?? "accept";
  }

  private fail(outcome: FakeOutcome): never {
    if (typeof outcome === "object") {
      if (outcome.status === "invalid_grant") throw new GmailRequestFailed("invalid_grant", false, 400);
      const reason = "reason" in outcome ? outcome.reason : null;
      throw new GmailRequestFailed(`google_${outcome.status}${reason ? `_${reason.toLowerCase()}` : ""}`,
        outcome.status === 429 || outcome.status >= 500 || (outcome.status === 403 && /ratelimit/i.test(reason ?? "")), outcome.status, reason);
    }
    throw new GmailRequestFailed("gmail_network", true);
  }

  private authorize(accessToken: string, options?: GmailCallOptions): Mailbox | null {
    if (options?.signal?.aborted) throw new GmailRequestFailed("gmail_network", true);
    const address = this.tokens.get(accessToken);
    return address === undefined ? null : this.box(address);
  }

  private store(box: Mailbox, input: { threadId: string; labelIds: string[]; headers: Record<string, string> }): StoredMessage {
    box.historyId += 1;
    const message: StoredMessage = { id: this.next("msg-"), ...input, historyId: box.historyId, at: this.clock.now() };
    box.messages.set(message.id, message);
    box.threads.set(message.threadId, [...(box.threads.get(message.threadId) ?? []), message.id]);
    return message;
  }

  // --- the token endpoint (the worker's `GoogleClient` subset) ---

  readonly oauth = {
    refreshAccessToken: async (refreshToken: string): Promise<{ accessToken: string; expiresInSeconds: number }> => {
      const box = [...this.mailboxes.values()].find((candidate) => candidate.refreshToken === refreshToken) ?? null;
      const outcome = this.take(box, "refresh");
      if (box === null) throw new GmailRequestFailed("invalid_grant", false, 400);
      if (outcome !== "accept") this.fail(outcome);
      const accessToken = `fake-access-${this.next("")}-${box.address}`;
      this.tokens.set(accessToken, box.address);
      this.accessTokens.push(accessToken);
      return { accessToken, expiresInSeconds: 3600 };
    },
    revoke: async (refreshToken: string): Promise<void> => {
      this.revoked.push(refreshToken);
    },
  };

  // --- GmailPort ---

  async send(accessToken: string, input: { readonly raw: string; readonly threadId?: string }, options?: GmailCallOptions): Promise<GmailSendResult> {
    const box = this.authorize(accessToken, options);
    const outcome = this.take(box, "send");
    if (box === null) throw new GmailRequestFailed("google_401", false, 401);
    if (outcome === "timeout_before") this.fail(outcome);
    if (outcome !== "accept" && outcome !== "timeout_after") this.fail(outcome);
    const parsed = parseRawMessage(input.raw);
    const subject = parsed.headers.subject ?? "";
    let threadId = input.threadId;
    const thread = threadId === undefined ? undefined : box.threads.get(threadId);
    const first = thread === undefined ? undefined : box.messages.get(thread[0]!);
    const joins = thread !== undefined && first !== undefined && parsed.headers["in-reply-to"] !== undefined && parsed.headers.references !== undefined
      && normalizeSubject(first.headers.subject ?? "") === normalizeSubject(subject);
    if (!joins) threadId = this.next("thr-");
    const messageIdHeader = `<${this.next("fake-")}@mail.fake.example>`;
    const headers: Record<string, string> = { ...parsed.headers, "message-id": messageIdHeader };
    const stored = this.store(box, { threadId: threadId!, labelIds: ["SENT"], headers });
    this.sent.push({
      mailbox: box.address, id: stored.id, threadId: stored.threadId, to: parsed.headers.to ?? "", subject, body: parsed.body, headers, raw: input.raw, at: stored.at,
    });
    if (outcome === "timeout_after") this.fail("timeout_after");
    return { id: stored.id, threadId: stored.threadId, labelIds: ["SENT"] };
  }

  async getMessageHeaders(accessToken: string, messageId: string, headerNames: readonly string[], options?: GmailCallOptions): Promise<GmailMessageMetadata | null> {
    const box = this.authorize(accessToken, options);
    const outcome = this.take(box, "getMessage");
    if (box === null) throw new GmailRequestFailed("google_401", false, 401);
    if (outcome !== "accept") this.fail(outcome);
    const message = box.messages.get(messageId);
    return message ? this.metadata(message, headerNames) : null;
  }

  async getThreadHeaders(accessToken: string, threadId: string, headerNames: readonly string[], options?: GmailCallOptions): Promise<GmailMessageMetadata[] | null> {
    const box = this.authorize(accessToken, options);
    const outcome = this.take(box, "getThread");
    if (box === null) throw new GmailRequestFailed("google_401", false, 401);
    if (outcome !== "accept") this.fail(outcome);
    const ids = box.threads.get(threadId);
    return ids === undefined ? null : ids.map((id) => this.metadata(box.messages.get(id)!, headerNames));
  }

  async listHistory(accessToken: string, input: { readonly startHistoryId: string; readonly pageToken?: string }, options?: GmailCallOptions): Promise<GmailHistoryPage> {
    const box = this.authorize(accessToken, options);
    const outcome = this.take(box, "history");
    if (box === null) throw new GmailRequestFailed("google_401", false, 401);
    const start = Number(input.startHistoryId);
    if (outcome === "history_404" || !Number.isFinite(start) || start < box.oldestHistoryId) throw new GmailRequestFailed("history_expired", false, 404);
    if (outcome !== "accept") this.fail(outcome);
    const after = [...box.messages.values()].filter((message) => message.historyId > start).sort((a, b) => a.historyId - b.historyId);
    const offset = input.pageToken === undefined ? 0 : Number(input.pageToken);
    const page = after.slice(offset, offset + box.historyPageSize);
    const more = offset + box.historyPageSize < after.length;
    return {
      messages: page.map((message) => ({ id: message.id, threadId: message.threadId, labelIds: message.labelIds })),
      historyId: String(box.historyId),
      nextPageToken: more ? String(offset + box.historyPageSize) : null,
    };
  }

  async getProfile(accessToken: string, options?: GmailCallOptions): Promise<{ emailAddress: string; historyId: string }> {
    const box = this.authorize(accessToken, options);
    const outcome = this.take(box, "profile");
    if (box === null) throw new GmailRequestFailed("google_401", false, 401);
    if (outcome !== "accept") this.fail(outcome);
    return { emailAddress: box.address, historyId: String(box.historyId) };
  }

  private metadata(message: StoredMessage, names: readonly string[]): GmailMessageMetadata {
    const wanted = new Set(names.map((name) => name.toLowerCase()));
    return {
      id: message.id, threadId: message.threadId, labelIds: [...message.labelIds],
      headers: Object.fromEntries(Object.entries(message.headers).filter(([name]) => wanted.has(name))),
    };
  }

  // --- test helpers: inbound mail and inspection ---

  /** The address a sent message was addressed to and its decoded parts, in send order. */
  sentTo(address: string): FakeSentMessage[] {
    return this.sent.filter((message) => message.to.toLowerCase() === address.toLowerCase());
  }
  sendCalls(): number {
    return this.calls.filter((call) => call.op === "send").length;
  }
  /** Adds a message to a mailbox as if it arrived (INBOX) or was sent by the owner by hand (`labels: ["SENT"]`). */
  receive(address: string, input: { from: string; subject?: string; threadId?: string; headers?: Record<string, string>; labels?: string[] }): { id: string; threadId: string } {
    const box = this.box(address);
    const threadId = input.threadId !== undefined && box.threads.has(input.threadId) ? input.threadId : this.next("thr-");
    const stored = this.store(box, {
      threadId, labelIds: input.labels ?? ["INBOX"],
      headers: { from: input.from, subject: input.subject ?? "Re: hello", "message-id": `<${this.next("in-")}@mail.fake.example>`, ...(input.headers ?? {}) },
    });
    return { id: stored.id, threadId };
  }
  reply(address: string, threadId: string, from: string, headers: Record<string, string> = {}): { id: string; threadId: string } {
    return this.receive(address, { from, threadId, headers });
  }
  /** A Gmail delivery failure notice for `failed`, in the thread of the message that bounced. */
  bounce(address: string, threadId: string | undefined, failed: string): { id: string; threadId: string } {
    return this.receive(address, {
      from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "Delivery Status Notification (Failure)",
      ...(threadId === undefined ? {} : { threadId }),
      headers: { "x-failed-recipients": failed, "auto-submitted": "auto-replied", "content-type": "multipart/report; report-type=delivery-status; boundary=\"b\"" },
    });
  }
  outOfOffice(address: string, threadId: string, from: string): { id: string; threadId: string } {
    return this.receive(address, { from, threadId, subject: "Automatic reply", headers: { "auto-submitted": "auto-replied" } });
  }
  currentHistoryId(address: string): string {
    return String(this.box(address).historyId);
  }
}
