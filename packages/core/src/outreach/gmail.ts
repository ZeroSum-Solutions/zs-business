// The Gmail adapter over an injected fetch (outreach-sequencer.md OS-21). Original code written from Google's public
// Gmail API v1 behaviour in our own words. Tokens travel in the Authorization header only; they never reach a URL, an
// error message or a log line. Answers are read up to 1 MiB.
import { z } from "zod";
import { secureUrlProblem } from "../edge/auth.js";
import {
  GmailRequestFailed,
  type GmailCallOptions,
  type GmailHistoryPage,
  type GmailMessageMetadata,
  type GmailPort,
  type GmailSendResult,
} from "./gmail-port.js";

export const GMAIL_DEFAULT_BASE_URL = "https://gmail.googleapis.com";
/** OS-21: no answer is read past this size. */
export const GMAIL_RESPONSE_LIMIT_BYTES = 1024 * 1024;
const HISTORY_PAGE_SIZE = 100;
/** The message the test fetch guard throws; the adapter lets it through instead of mapping it to a network error. */
export const REAL_GOOGLE_CALL_IN_TEST = "real_google_call_in_test";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export const gmailClientConfigSchema = z.strictObject({
  baseUrl: z.string().superRefine((value, ctx) => {
    const problem = secureUrlProblem("baseUrl", value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  }).default(GMAIL_DEFAULT_BASE_URL),
});
export type GmailClientConfig = z.input<typeof gmailClientConfigSchema>;

const TOO_LARGE = Symbol("too large");

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > GMAIL_RESPONSE_LIMIT_BYTES) {
        await reader.cancel().catch(() => {});
        return TOO_LARGE;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/** A provider word that may go into an error code: letters only, so nothing token-shaped can pass. */
const word = (value: unknown): string | null => (typeof value === "string" && /^[A-Za-z]{1,60}$/.test(value) ? value.toLowerCase() : null);
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Gmail answers `{ error: { code, message, errors: [{ reason }], status } }`. Only the status and one reason word are kept. */
function failure(status: number, body: unknown): GmailRequestFailed {
  const error = record(record(body)?.error);
  const first = Array.isArray(error?.errors) ? record(error.errors[0]) : null;
  const reason = word(first?.reason) ?? word(error?.status);
  const limited = status === 403 && (reason === "ratelimitexceeded" || reason === "userratelimitexceeded");
  return new GmailRequestFailed(`google_${status}${reason ? `_${reason}` : ""}`, status === 429 || status >= 500 || limited, status, reason);
}
const unreadable = (status: number) => new GmailRequestFailed("gmail_unreadable_response", true, status);

const sendSchema = z.object({ id: z.string().min(1).max(100), threadId: z.string().min(1).max(100), labelIds: z.array(z.string().max(100)).max(100).default([]) });
const headerSchema = z.object({ name: z.string().max(200), value: z.string().max(10_000) });
const messageSchema = z.object({
  id: z.string().min(1).max(100),
  threadId: z.string().min(1).max(100),
  labelIds: z.array(z.string().max(100)).max(100).default([]),
  payload: z.object({ headers: z.array(headerSchema).max(200).default([]) }).default({ headers: [] }),
});
const threadSchema = z.object({ messages: z.array(messageSchema).max(500).default([]) });
const historySchema = z.object({
  history: z.array(z.object({
    messagesAdded: z.array(z.object({ message: z.object({
      id: z.string().min(1).max(100), threadId: z.string().min(1).max(100), labelIds: z.array(z.string().max(100)).max(100).default([]),
    }) })).default([]),
  })).max(1000).default([]),
  nextPageToken: z.string().min(1).max(4096).optional(),
  historyId: z.string().min(1).max(40),
});
const profileSchema = z.object({ emailAddress: z.string().min(3).max(254), historyId: z.string().min(1).max(40) });

function metadata(message: z.infer<typeof messageSchema>, wanted: ReadonlySet<string>): GmailMessageMetadata {
  const headers: Record<string, string> = {};
  for (const { name, value } of message.payload.headers) {
    const key = name.toLowerCase();
    if (wanted.has(key)) headers[key] ??= value;
  }
  return { id: message.id, threadId: message.threadId, labelIds: message.labelIds, headers };
}

export function createGmailClient(deps: { readonly config?: GmailClientConfig; readonly fetch?: Fetch } = {}): GmailPort {
  const parsed = gmailClientConfigSchema.safeParse(deps.config ?? {});
  if (!parsed.success) throw new Error(`Invalid Gmail config: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  const base = parsed.data.baseUrl.replace(/\/+$/, "");
  const doFetch: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const users = `${base}/gmail/v1/users/me`;

  async function call(method: "GET" | "POST", url: string, accessToken: string, json: unknown, options: GmailCallOptions | undefined) {
    try {
      const response = await doFetch(url, {
        method,
        redirect: "manual",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", ...(json === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return { status: response.status, body: await readJson(response) };
    } catch (error) {
      // A guard that stops a test from reaching Google must not look like a flaky network.
      if (error instanceof Error && error.message === REAL_GOOGLE_CALL_IN_TEST) throw error;
      // The cause is dropped: it could name the URL.
      throw new GmailRequestFailed("gmail_network", true);
    }
  }
  const ok = (status: number) => status >= 200 && status < 300;
  const headerQuery = (names: readonly string[]) => names.map((name) => `metadataHeaders=${encodeURIComponent(name)}`).join("&");

  return {
    async send(accessToken, input, options): Promise<GmailSendResult> {
      const { status, body } = await call("POST", `${users}/messages/send`, accessToken,
        { raw: input.raw, ...(input.threadId === undefined ? {} : { threadId: input.threadId }) }, options);
      if (body === TOO_LARGE) throw new GmailRequestFailed("gmail_response_too_large", false, status);
      if (!ok(status)) throw failure(status, body);
      const sent = sendSchema.safeParse(body);
      // The message left; only the receipt is unreadable. The worker settles this as an unknown outcome.
      if (!sent.success) throw unreadable(status);
      return sent.data;
    },

    async getMessageHeaders(accessToken, messageId, headerNames, options) {
      const { status, body } = await call("GET",
        `${users}/messages/${encodeURIComponent(messageId)}?format=metadata&${headerQuery(headerNames)}`, accessToken, undefined, options);
      if (body === TOO_LARGE) throw new GmailRequestFailed("gmail_response_too_large", false, status);
      if (status === 404) return null;
      if (!ok(status)) throw failure(status, body);
      const message = messageSchema.safeParse(body);
      if (!message.success) throw unreadable(status);
      return metadata(message.data, new Set(headerNames.map((name) => name.toLowerCase())));
    },

    async getThreadHeaders(accessToken, threadId, headerNames, options) {
      const { status, body } = await call("GET",
        `${users}/threads/${encodeURIComponent(threadId)}?format=metadata&${headerQuery(headerNames)}`, accessToken, undefined, options);
      if (body === TOO_LARGE) throw new GmailRequestFailed("gmail_response_too_large", false, status);
      if (status === 404) return null;
      if (!ok(status)) throw failure(status, body);
      const thread = threadSchema.safeParse(body);
      if (!thread.success) throw unreadable(status);
      const wanted = new Set(headerNames.map((name) => name.toLowerCase()));
      return thread.data.messages.map((message) => metadata(message, wanted));
    },

    async listHistory(accessToken, input, options): Promise<GmailHistoryPage> {
      const query = new URLSearchParams({ startHistoryId: input.startHistoryId, historyTypes: "messageAdded", maxResults: String(HISTORY_PAGE_SIZE) });
      if (input.pageToken !== undefined) query.set("pageToken", input.pageToken);
      const { status, body } = await call("GET", `${users}/history?${query.toString()}`, accessToken, undefined, options);
      if (body === TOO_LARGE) throw new GmailRequestFailed("gmail_response_too_large", false, status);
      // A start point Gmail no longer keeps (OS-19): the caller resets its cursor.
      if (status === 404) throw new GmailRequestFailed("history_expired", false, 404);
      if (!ok(status)) throw failure(status, body);
      const page = historySchema.safeParse(body);
      if (!page.success) throw unreadable(status);
      return {
        messages: page.data.history.flatMap((entry) => entry.messagesAdded.map((added) => added.message)),
        historyId: page.data.historyId,
        nextPageToken: page.data.nextPageToken ?? null,
      };
    },

    async getProfile(accessToken, options) {
      const { status, body } = await call("GET", `${users}/profile`, accessToken, undefined, options);
      if (body === TOO_LARGE) throw new GmailRequestFailed("gmail_response_too_large", false, status);
      if (!ok(status)) throw failure(status, body);
      const profile = profileSchema.safeParse(body);
      if (!profile.success) throw unreadable(status);
      return profile.data;
    },
  };
}
