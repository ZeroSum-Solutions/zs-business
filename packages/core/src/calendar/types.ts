// The Google seam (docs/requirements/google-calendar.md). Original code. The worker and the API
// depend on this interface only; google.ts implements it over an injected fetch, and tests pass
// an in-process fake Google server.
export interface RequestOptions {
  readonly signal?: AbortSignal;
}

/** Why Google did not answer as hoped. `retry` means the same request may succeed later. */
export class GoogleRequestFailed extends Error {
  constructor(
    /** For example `google_network`, `invalid_grant`, `sync_token_expired` (410), `google_403_forbidden`. */
    readonly code: string,
    readonly retry: boolean,
    readonly status: number | null = null,
  ) {
    super(`Google request failed: ${code}`);
    this.name = "GoogleRequestFailed";
  }
}

export interface GoogleTokenGrant {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  /** Present on a code exchange with access_type=offline and prompt=consent. */
  readonly refreshToken: string | null;
  /** Space-separated granted scopes. */
  readonly scope: string;
  /** The `email` claim of the id_token, when Google sent one (read, not verified: it came straight from the token endpoint over TLS). */
  readonly email: string | null;
}

export interface GoogleEventTime {
  readonly dateTime?: string;
  readonly date?: string;
  readonly timeZone?: string;
}
/** The event fields this system reads (G-7); everything else is ignored. */
export interface GoogleEvent {
  readonly id: string;
  readonly status?: string;
  readonly transparency?: string;
  readonly eventType?: string;
  readonly start?: GoogleEventTime;
  readonly end?: GoogleEventTime;
  readonly attendees?: ReadonlyArray<{ readonly self?: boolean; readonly responseStatus?: string }>;
  readonly extendedProperties?: { readonly private?: Readonly<Record<string, string>> };
}
export interface GoogleEventPage {
  readonly items: readonly GoogleEvent[];
  readonly nextPageToken: string | null;
  /** Only on the last page. */
  readonly nextSyncToken: string | null;
}

export type ListEventsQuery =
  | { readonly calendarId: string; readonly syncToken: string; readonly pageToken?: string }
  | { readonly calendarId: string; readonly timeMin: string; readonly timeMax: string; readonly pageToken?: string };

export interface NewGoogleEvent {
  /** a-v and 0-9, 5 to 1024 characters (G-10). */
  readonly id: string;
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly privateProperties: Readonly<Record<string, string>>;
}

export interface GoogleClient {
  /** G-1: the consent screen URL. */
  authorizeUrl(input: { readonly state: string; readonly codeChallenge: string }): string;
  /** G-2: code to tokens. Throws GoogleRequestFailed. */
  exchangeCode(input: { readonly code: string; readonly codeVerifier: string }, options?: RequestOptions): Promise<GoogleTokenGrant>;
  /** G-6: a fresh access token; `invalid_grant` (retry false) when the grant is gone. */
  refreshAccessToken(refreshToken: string, options?: RequestOptions): Promise<{ accessToken: string; expiresInSeconds: number }>;
  /** G-9: revokes the grant; an already invalid token resolves too. */
  revoke(token: string, options?: RequestOptions): Promise<void>;
  /** G-6: one page; a 410 throws `sync_token_expired`. */
  listEvents(accessToken: string, query: ListEventsQuery, options?: RequestOptions): Promise<GoogleEventPage>;
  /** G-10: `exists` when Google answers 409 for the chosen ID. */
  insertEvent(accessToken: string, calendarId: string, event: NewGoogleEvent, options?: RequestOptions): Promise<"created" | "exists">;
  /** G-8: opens a push channel; expiration in Unix milliseconds. */
  watch(accessToken: string, input: {
    readonly calendarId: string; readonly channelId: string; readonly address: string; readonly token: string;
  }, options?: RequestOptions): Promise<{ resourceId: string; expiresAt: number }>;
  /** G-8, G-9: closes a channel; one Google no longer knows resolves too. */
  stopChannel(accessToken: string, input: { readonly channelId: string; readonly resourceId: string }, options?: RequestOptions): Promise<void>;
}
