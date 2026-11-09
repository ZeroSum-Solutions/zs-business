// The Gmail seam (outreach-sequencer.md OS-21). Original code. The worker depends on this interface only; gmail.ts
// implements it over an injected fetch and fake-gmail.ts keeps it in memory for tests. Every call takes the access
// token for this run and an abort signal; nothing here stores or logs a token.
export interface GmailCallOptions {
  readonly signal?: AbortSignal;
}

/**
 * Why Gmail did not answer as hoped. `code` is ours and token-free (`gmail_network`, `google_403_ratelimitexceeded`,
 * `history_expired`); `reason` is Gmail's own reason word when it sent one. `retry` means the same request may succeed
 * later. A thrown value that is not this class is treated as an unknown outcome by the worker (OS-15).
 */
export class GmailRequestFailed extends Error {
  constructor(
    readonly code: string,
    readonly retry: boolean,
    readonly status: number | null = null,
    readonly reason: string | null = null,
  ) {
    super(`Gmail request failed: ${code}`);
    this.name = "GmailRequestFailed";
  }
}

export interface GmailSendResult {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds: readonly string[];
}

/** One message as `gmail.metadata` shows it: labels and the headers asked for (names lower case), never a body. */
export interface GmailMessageMetadata {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds: readonly string[];
  readonly headers: Readonly<Record<string, string>>;
}

export interface GmailHistoryMessage {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds: readonly string[];
}
export interface GmailHistoryPage {
  readonly messages: readonly GmailHistoryMessage[];
  /** The mailbox's current history id: the cursor to store after the last page. */
  readonly historyId: string;
  readonly nextPageToken: string | null;
}

export interface GmailPort {
  /** `messages.send`. It has no idempotency key: a repeat sends again (OS-15). */
  send(accessToken: string, input: { readonly raw: string; readonly threadId?: string }, options?: GmailCallOptions): Promise<GmailSendResult>;
  /** `messages.get` in metadata format; null when Gmail no longer has the message. */
  getMessageHeaders(accessToken: string, messageId: string, headerNames: readonly string[], options?: GmailCallOptions): Promise<GmailMessageMetadata | null>;
  /** `threads.get` in metadata format; null when Gmail no longer has the thread. */
  getThreadHeaders(accessToken: string, threadId: string, headerNames: readonly string[], options?: GmailCallOptions): Promise<GmailMessageMetadata[] | null>;
  /** `history.list` for `messageAdded`; a start point Gmail no longer keeps throws `history_expired` (404). */
  listHistory(accessToken: string, input: { readonly startHistoryId: string; readonly pageToken?: string }, options?: GmailCallOptions): Promise<GmailHistoryPage>;
  /** `users.getProfile`. */
  getProfile(accessToken: string, options?: GmailCallOptions): Promise<{ readonly emailAddress: string; readonly historyId: string }>;
}

/** The headers the worker reads (OS-19, OS-14); names are matched case-insensitively. */
export const INBOUND_HEADER_NAMES: readonly string[] = Object.freeze([
  "From", "To", "Auto-Submitted", "X-Failed-Recipients", "Content-Type", "Message-ID", "In-Reply-To", "X-Zs-Ref", "Subject",
]);
