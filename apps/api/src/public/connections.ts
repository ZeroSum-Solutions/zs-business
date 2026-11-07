// docs/requirements/connections.md C-5: the anonymous connections callback and its status call. Like the
// Google callback it trusts only the signed attempt token (a header the dashboard forwards from its cookie)
// and the browser key of the browser that started the connect, and it stages a grant for the owner to
// confirm: the grant goes back in a header, never in the redirect's URL, and nothing is connected here.
import { CONNECT_ATTEMPT_HEADER, CONNECT_BROWSER_KEY_HEADER, CONNECT_GRANT_HEADER } from "@zs/contracts";
import { Hono, type Context } from "hono";
import {
  apiErrorBody,
  createConnectionsCallback,
  type ConnectionLimiter,
  type ConnectionStateSecrets,
  type ConnectorPort,
  type EdgeDependencies,
} from "@zs/core";
import type { AppEnv } from "../app.js";

export interface ConnectionsApiConfig {
  /** The signed client of the connections worker (C-3). */
  readonly connector: ConnectorPort;
  /** Signs and verifies the attempt and grant tokens; `previous` keeps verifying through a rotation. */
  readonly stateSecrets: ConnectionStateSecrets;
  /** The dashboard page the callback redirects to (CONNECTIONS_RETURN_URL). */
  readonly returnUrl: string;
  /** The shared limiter (C-4, C-5, C-12); defaults to the Postgres one on the app's database. */
  readonly limiter?: ConnectionLimiter;
  /** Receives what each callback did, for logs; never a token or an ID. */
  readonly report?: (event: { readonly route: "callback" | "status"; readonly outcome: string }) => void;
}

/** The callback lands in a browser: nothing may cache it, and the query must not leak as a Referer. */
const CALLBACK_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;
const MAX_QUERY_VALUE = 2048;

export function connectionsCallbackRoutes(
  config: ConnectionsApiConfig,
  requestEdge: (c: Context<AppEnv>) => EdgeDependencies,
) {
  const answer = async (c: Context<AppEnv>, route: "callback" | "status") => {
    const callback = createConnectionsCallback(requestEdge(c));
    const query = (name: string) => {
      const value = c.req.query(name);
      return value !== undefined && value.length <= MAX_QUERY_VALUE ? value : undefined;
    };
    const input = {
      attempt: c.req.header(CONNECT_ATTEMPT_HEADER),
      browserKey: c.req.header(CONNECT_BROWSER_KEY_HEADER),
      accountId: query("connected_account_id"),
      sessionUri: query("session_uri"),
    };
    const outcome = await (route === "callback" ? callback.callback(input, c.var.signal) : callback.status(input, c.var.signal));
    config.report?.({ route, outcome: outcome.kind === "error" ? `error:${outcome.reason}` : outcome.kind });
    for (const [name, value] of Object.entries(CALLBACK_HEADERS)) c.header(name, value);
    // C-5: nothing proves where the caller came from without a valid attempt, so there is no redirect.
    if (outcome.kind === "invalid") return c.json(apiErrorBody("ValidationFailed", "Invalid connection attempt"), 400);
    const target = new URL(config.returnUrl);
    if (outcome.kind === "error") {
      target.searchParams.set("connection", "error");
      target.searchParams.set("reason", outcome.reason);
    } else {
      target.searchParams.set("connection", outcome.kind);
      if (outcome.kind === "confirm") c.header(CONNECT_GRANT_HEADER, outcome.grant);
    }
    return c.redirect(target.toString(), 303);
  };
  return new Hono<AppEnv>()
    .get("/oauth/connections/callback", (c) => answer(c, "callback"))
    .get("/oauth/connections/callback/status", (c) => answer(c, "status"));
}
