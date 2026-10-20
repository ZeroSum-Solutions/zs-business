// M5 Google OAuth callback (docs/requirements/google-calendar.md G-2, G-3). Original code. The
// request is anonymous; what it may do comes from the signed state alone: the tenant, the member
// who asked, the resource and the connection ID. The connect action then runs through the member
// write path as that member, so a member who is no longer an owner is refused, under the reserved
// key `oauth-google:<connection ID>`. The refresh token is sealed before the action sees it; the
// access token is dropped.
import {
  BindingMismatch,
  CALENDAR_GOOGLE_CONNECT_ACTION,
  Conflict,
  IdempotencyConflict,
  NotFound,
  TenantDenied,
} from "@zs/contracts";
import { readClock } from "../booking/slots.js";
import { getCalendarConnection, googleConnectIdempotencyKey } from "../calendar/connections.js";
import { GOOGLE_EVENTS_SCOPE } from "../calendar/google.js";
import { pkceVerifier, verifyOAuthState, type OAuthState } from "../calendar/oauth-state.js";
import { sealRefreshToken } from "../calendar/seal.js";
import { GoogleRequestFailed, type GoogleTokenGrant } from "../calendar/types.js";
import { requireMember } from "../members/access.js";
import { derivedId } from "./ids.js";
import { memberDispatch, type EdgeDependencies } from "./session.js";

/** G-2: the redirect's `reason` when the connection was not made. */
export type OAuthCallbackReason = "denied" | "exchange_failed" | "no_refresh_token" | "scope_missing" | "forbidden" | "conflict";

export interface OAuthCallbackInput {
  readonly state?: string | undefined;
  readonly code?: string | undefined;
  readonly error?: string | undefined;
}

export type OAuthCallbackOutcome =
  /** No valid state: nothing proves where the caller came from, so no redirect. */
  | { readonly ok: false; readonly status: 400 }
  | { readonly ok: true; readonly connected: true; readonly tenantId: string; readonly connectionId: string }
  | { readonly ok: true; readonly connected: false; readonly reason: OAuthCallbackReason };

export { googleConnectIdempotencyKey };

/** What a reload finds: no row yet, this flow's live connection, or a row that is no longer it. */
type Existing = "none" | "active" | "other";

const MAX_CODE_LENGTH = 2048;

export function createOAuthCallbackSession(deps: EdgeDependencies) {
  return {
    async complete(input: OAuthCallbackInput, signal?: AbortSignal): Promise<OAuthCallbackOutcome> {
      const calendar = deps.calendar;
      if (!calendar) throw new NotFound();
      const now = new Date(readClock(deps.clock));
      const token = input.state ?? "";
      const state = verifyOAuthState(calendar.stateSecrets, token, now);
      if (!state) return { ok: false, status: 400 };
      // The verifier derives from the secret that signed this state, which may be the previous one.
      const signer = verifyOAuthState({ current: calendar.stateSecrets.current }, token, now) !== null
        ? calendar.stateSecrets.current
        : calendar.stateSecrets.previous!;
      const { tenantId, actorId, connectionId } = state;
      const fail = (reason: OAuthCallbackReason): OAuthCallbackOutcome => ({ ok: true, connected: false, reason });
      const connected: OAuthCallbackOutcome = { ok: true, connected: true, tenantId, connectionId };

      if (input.error !== undefined) return fail("denied");

      /**
       * Whether this flow's connection already exists: a reload, or a second tab that won. Only an
       * active row for this state's resource counts as connected; one since retired, needing
       * reauthorization, or made for another resource under a reused key is a conflict.
       */
      const existing = () => deps.db.tenant(tenantId, async (tx): Promise<Existing> => {
        await requireMember(tx, tenantId, actorId, "publish");
        const found = await getCalendarConnection(tx, tenantId, connectionId);
        if (!found) return "none";
        return found.status === "active" && found.resourceId === state.resourceId ? "active" : "other";
      });
      try {
        // Before the code is spent: a member who may no longer connect is refused, and a reload
        // after success answers as the first request did.
        const found = await existing();
        if (found !== "none") return found === "active" ? connected : fail("conflict");
      } catch (error) {
        if (error instanceof TenantDenied) return fail("forbidden");
        throw error;
      }

      const code = input.code;
      if (code === undefined || code.length === 0 || code.length > MAX_CODE_LENGTH) return fail("exchange_failed");
      let grant: GoogleTokenGrant;
      try {
        grant = await calendar.google.exchangeCode({ code, codeVerifier: pkceVerifier(signer, connectionId) }, signal ? { signal } : {});
      } catch (error) {
        if (!(error instanceof GoogleRequestFailed)) throw error;
        // A code already used by a request that went on to connect.
        const found = await existing().catch((): Existing => "none");
        return found === "active" ? connected : fail(found === "other" ? "conflict" : "exchange_failed");
      }
      // A grant that cannot be used is left alone, never revoked: it is stored nowhere, and Google
      // revokes the whole grant for the user and client, which could end another live connection.
      if (!grant.refreshToken) return fail("no_refresh_token");
      if (!grant.scope.split(/\s+/).includes(GOOGLE_EVENTS_SCOPE)) return fail("scope_missing");
      let refreshTokenSealed: string;
      try {
        refreshTokenSealed = sealRefreshToken(calendar.tokenPublicKey, { tenantId, connectionId }, grant.refreshToken);
      } catch {
        return fail("exchange_failed");
      }
      return connect(state, {
        accountEmail: grant.email !== null && grant.email.length >= 3 && grant.email.length <= 254 ? grant.email : null,
        scope: grant.scope.slice(0, 2000),
        refreshTokenSealed,
      }, { connected, fail, existing });
    },
  };

  async function connect(
    state: OAuthState,
    grant: { accountEmail: string | null; scope: string; refreshTokenSealed: string },
    outcomes: {
      connected: OAuthCallbackOutcome;
      fail: (reason: OAuthCallbackReason) => OAuthCallbackOutcome;
      existing: () => Promise<Existing>;
    },
  ): Promise<OAuthCallbackOutcome> {
    const { tenantId, actorId, connectionId, resourceId } = state;
    const idempotencyKey = googleConnectIdempotencyKey(connectionId);
    const run = memberDispatch(deps, { tenantId, actorId });
    try {
      await run({
        actionType: CALENDAR_GOOGLE_CONNECT_ACTION,
        target: { tenantId, type: "calendar_connection", id: connectionId },
        approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
        idempotencyKey,
        payload: { connectionId, resourceId, ...grant },
      });
      return outcomes.connected;
    } catch (error) {
      // The member lost the owner role, or the resource is gone, since the state was signed.
      if (error instanceof TenantDenied) return outcomes.fail("forbidden");
      // Another request for this connection committed first, with its own sealing of the grant.
      if (error instanceof IdempotencyConflict || error instanceof BindingMismatch)
        return (await outcomes.existing().catch((): Existing => "none")) === "active" ? outcomes.connected : outcomes.fail("conflict");
      if (error instanceof Conflict) return outcomes.fail("conflict");
      throw error;
    }
  }
}
export type OAuthCallbackSession = ReturnType<typeof createOAuthCallbackSession>;
