# Connections: one place a business connects its outside accounts

Status: draft contract, revision 4 (2026-11-07). Code follows this file; a change to a
numbered rule needs a new revision of this file first. Extends `hub-access.md` (H-1..H-12):
connection reads are new `/mcp` tools behind a new scope, under the same token guard,
limits and usage rules. Reuses the connect shapes of `google-calendar.md` (G-1, G-2, G-4).

Revision 4 (2026-11-07, Track K of the four-verticals goal): the public Shopify app needs an
embedded page, session tokens, expiring offline tokens, install-to-tenant binding with no
operator and the compliance webhooks. Added: a native Shopify tier and C-18 to C-28 (at the end
of "Evidence and decisions"). Changed: C-4 (no typed shop domain once the native tier is on),
C-7 (`tier` also `native`), C-13 (a native disconnect deletes the sealed tokens and asks Shopify
to uninstall with the stored token (`appUninstall`, as today), then marks the row `disconnected`; the uninstall webhook that follows is idempotent), C-14 (the
sealed tokens and the install ledger are stored; still no orders or customer data).

Revision 3 (2026-11-07, Devin's direction): the managed tier opens on production now, with
Zero Sum Solutions (tenant 1) first, instead of waiting for the two-week preview measurement.
That measurement keeps running on preview as monitoring only and gates nothing. C-17 is
rewritten to say what opening on production needs and what was seen on the first production
runs; the pilot is still Shopify with the same two read tools. Client tenants other than
Zero Sum connect only after the Shopify distribution choice in C-17 is made. No other rule changed.

Revision 2 (2026-11-06, four-model escalation audit of revision 1 by GPT-6.1 Sol, Gemini 4
Argon, DeepSeek V4.1 Flash and Grok): the pilot is cut to Shopify on preview, with two read
tools. The connect link is the direct `connected_accounts/link` call, and Composio's deferred
verification (`complete_auth`) closes connect-link fixation. Connect attempts are rows, so
retries, Cancel and the sweep act on known accounts only. The worker gets one authorization
rule per operation, a replay-proof request signature and an organization-wide budget. Every
deadline fits the existing 10 second request deadline. The role model, the column grants, the
migration details, the dashboard routes and cookies, the error envelope, revocation and the
retention text are now stated. The vertical picker, the other seven toolkits,
`connection_usage` and the 20 second `/mcp` deadline are gone.

Scope: an owner connects a Shopify store once, on the Connections screen. Agents that hold an
automation token with `connections:read` then read that store's orders through `/mcp`.
Revisions 2 and 3 cover connect, confirm, cancel, list, health, reconnect, disconnect and two curated
**read** tools on the managed tier (Composio), on preview and on production for Zero Sum's own
tenant. Other client tenants wait for the Shopify distribution choice (C-17).

Out of scope for this revision: other toolkits (the catalog shape admits them; each needs a
revision that names its tools and passes the pilot checks), writes into outside accounts (the one
exception is the app uninstalling itself on disconnect, C-13),
Composio webhooks and triggers, Tool Router sessions, moving Google Calendar onto the port, our
own OAuth apps for new providers, white-label consent, more than one live account per toolkit,
per-token toolkit limits, a usage table and screen for connection runs, a dedicated database
role for workers (all workers share one pattern today; Known limits).

## Evidence and decisions

- Direction (Devin, 2026-11-06): two tiers. Our own verified OAuth apps for core providers on
  the sealed-token path (Google Calendar is built; Stripe, Twilio and Resend have their own
  contracts). Composio managed auth for the long tail behind one adapter. The Composio Pro
  pilot ($29/month) is approved. Brief and reviews:
  `/Users/zero-suminc./Inbox/plans/_unassigned/2026-11/2026-11-06-hub-architecture-decision.md`.
- Composio facts (public docs, read 2026-11-06; no text copied). REST v3.1 at
  `https://backend.composio.dev/api/v3.1`, header `x-api-key`.
  - Connected accounts belong to a `user_id` the application chooses. One Composio project per
    environment; the tenant boundary stays in the application.
  - `POST /connected_accounts/link` (`auth_config_id`, `user_id`, `callback_url`) returns
    `redirect_url` and `connected_account_id` before the person signs in. The pre-issued account ID
    is not proof of who consented. The reference also lists an optional `connection_data` object
    "to pre-fill connection fields"; the hosted form did not honor it for Shopify (Known limits),
    so the worker does not send it.
  - Deferred verification: when it is on for the project, the callback carries an opaque
    `session_uri`, and the account is finished only by
    `POST /connected_accounts/complete_auth { session_uri, user_id }`. That call is single use
    and Composio checks the `user_id`. Where the setting lives is not in the guides; the pilot
    gate finds it.
  - `GET /connected_accounts/:id` returns the account's `user_id`, toolkit, auth config,
    `status` (`INITIATED`, `INITIALIZING`, `ACTIVE`, `INACTIVE`, `FAILED`, `EXPIRED`,
    `REVOKED`) and a `state` block with partly masked credential values. Lifecycle status is
    not proof the credential still works.
  - `POST /tools/execute/:tool_slug` takes `user_id`, `connected_account_id`, `version` and
    `arguments`. It also accepts `custom_auth_params`, `custom_connection_data` and `text`,
    which this contract forbids. A failed call can answer HTTP 200 with `successful: false`.
  - `DELETE /connected_accounts/:id` removes the record; `revoke_on_delete` defaults to false.
    `POST /connected_accounts/:id/revoke` asks the provider to revoke, but answers 400 for a toolkit
    with no revoke configuration, and the Shopify toolkit has none (its metadata names no
    revocation endpoint). That is why a Shopify disconnect ended `revoke_outcome=failed` and the app
    stayed installed (preview run 3, 2026-11-07).
  - `POST /tools/execute/proxy` (Proxy Execute) sends one HTTP request to the provider with the
    connected account's credential: `connected_account_id`, `user_id`, `endpoint` (a path relative
    to the toolkit's base URL, or an absolute URL), `method`, `body`. It answers the provider's
    own `status`, `data` and `headers`. The Shopify toolkit's base URL is
    `https://<store>.myshopify.com/admin/api/<version>`.
  - Project API key permissions are by area: connected-accounts write covers link, delete and
    revoke together; tool execution, Proxy Execute, sessions and auth configs are separate.
    So the key cannot limit tools to our catalog: the worker does (C-3).
  - Rate limit on Pro: 10,000 requests per minute per organization, shared by every project
    and endpoint. Provider quotas apply on top and, with managed auth, are partly shared with
    other Composio customers.
  - Retention: tool arguments and results are logged for up to one year by default. Zero data
    retention does not cover Composio-managed OAuth apps outside Enterprise.
- Patterns reused (read only, never edited): Mish `apps/daemon/src/connectors/composio.ts`
  checks the account against the expected user, auth config and toolkit before trusting a
  callback.
- Google Calendar already settled: a browser key made by the dashboard; a callback that stages
  and an owner who confirms, because the callback navigation carries no session; a connect
  action under a reserved key; dedicated dashboard routes for the connect cookies
  (`apps/dashboard/src/lib/server/calendar-connect.ts`); a worker that owns provider state
  under a login that may `SET ROLE service_role` (G-6).
- Code facts this revision builds on: the dashboard proxy relays only `content-type`,
  `content-disposition` and `x-content-type-options` back (`api-proxy.ts`), so a token in a
  response header needs a dedicated route; every `/v1`, `/oauth` and `/mcp` request has a
  fixed 10 second deadline (`apps/api/src/app.ts`); the read-scope expiry check names its
  scopes in text (`20261106100000_hub_access.sql`); the isolation test expects `42501` or
  zero rows from a forbidden update (`packages/db/test/isolation.test.ts`).
- Keys: after the worker split, worker-only secrets live in their own Vercel project, so the
  API and `/mcp` functions cannot read them. The Composio key is one such secret: whoever
  holds it can act as any tenant at Composio.

## Numbered rules

- **C-1 One port, two tiers.** A `ConnectorPort` in core with one method per worker operation
  (C-3). Revision 2 has one adapter, `composio`. The `native` tier keeps its own contracts.
  Callers outside the adapter never see a Composio ID or slug they could pass back: they use
  our connection IDs and our tool names (C-6).
- **C-2 Identity at Composio.** One Composio project per environment (`production`,
  `preview`). A tenant's Composio `user_id` is `zsb:<env>:<tenantId>`. Only the worker builds
  it, from its own `CONNECTIONS_ENV` and the tenant of a verified request (C-3); a request
  whose `env` differs is refused. We store Composio account IDs; we never receive, store or
  log a provider token. The key has the areas connected accounts (read and write), tool
  execution and Proxy Execute (added for the uninstall in C-13; it lets the holder send any request as
  the account, so only the worker holds the key and only the catalog's fixed request goes through it);
  no sessions, no auth-config write. The Shopify auth config is
  made once per project in the Composio dashboard and named in worker config
  (`CONNECTIONS_SHOPIFY_AUTH_CONFIG_ID`).
- **C-3 Worker boundary.** `COMPOSIO_API_KEY` lives only in the worker project, which serves
  `POST /internal/connections/<operation>`. No query string is accepted.
  - Signature: the API signs `env`, the worker's host, the method, the path, a timestamp, a
    128-bit random `jti` and the SHA-256 of the raw body with HMAC-SHA-256 under
    `CONNECTIONS_INTERNAL_SECRET` (a different value per environment;
    `CONNECTIONS_INTERNAL_PREVIOUS_SECRET` verifies through a rotation). The API therefore
    holds `CONNECTIONS_ENV` too: a request signed for one environment never verifies in the
    other, even if a secret were shared. The API accepts the optional previous internal
    secret, refuses one equal to the current, and always signs with the current one. The worker refuses a
    timestamp more than 60 seconds off, a host or `env` that is not its own, and a `jti` it
    has seen (table `connector_request_nonces`, kept 5 minutes); tags are compared in
    constant time; redirects are not followed.
  - The body names the tenant (a UUID). The API takes it from the session or the token, never
    from client input. The worker trusts the API for the tenant and enforces everything else.
  - Operations and what each checks before any Composio call:
    - `link {tenantId, toolkit, attemptId, shopDomain}`: toolkit in the catalog; makes the
      link with the configured auth config and `callback_url = CONNECTIONS_CALLBACK_URL`
      (worker config, one exact dashboard URL per environment, registered on the auth
      config); records the attempt (C-4).
    - `complete {tenantId, attemptId, sessionUri}`: the attempt is the tenant's, `started` and
      unexpired; redeems `session_uri` (C-5); reads the account; reads identity.
    - `cancel {tenantId, attemptId}`: the attempt is the tenant's and not `confirmed`.
    - `run {tenantId, connectionId, tool, arguments}`: the row is the tenant's and `active`;
      the account read from Composio matches the row (C-5's match); the tool is in the row's
      toolkit catalog; the arguments pass the strict schema again.
    - `disconnect {tenantId, connectionId}`: the row is the tenant's and `disconnecting`.
  - A compromised API function can therefore make links and run catalog reads for a tenant it
    names. It cannot read the key, reach Proxy Execute, call a tool outside the catalog,
    choose the account, or replay a request.
  - Off: without the worker config the internal routes and the cron route answer 404, and
    `CRON_SECRET` (shared with other crons) is not checked by connections. The worker reads a
    request body as it arrives and refuses it at 64 KiB, before the signature check; a body
    that takes over 5 seconds to arrive, or whose caller goes away, is a 400. The request's
    abort signal stops the operation's Composio calls. Without
    `CONNECTIONS_WORKER_URL` and the secret in the API, every `/v1/connections` route answers
    404 and the C-10 tools are unlisted (a call is JSON-RPC `-32601`, H-5).
- **C-4 Connect.** The Connections screen's Shopify card asks for the store's
  `*.myshopify.com` domain and calls the dashboard's own
  `POST /api/connections/shopify/connect { shopDomain }`. The dashboard makes or keeps a
  browser key as `bindConnectStart` does (G-1; cookie `zs-connect-browser`, httpOnly,
  `SameSite=Lax`, path `/api/connections`, 10 minutes, `Secure` over https) and sends
  `SHA-256(browserKey)` with the body to the API's
  `POST /v1/connections/:toolkit/connect` (permission `integrations`, checked before the toolkit
  and the body, so a caller without it gets 403 even for a malformed body; toolkit matches
  `^[a-z0-9_-]{1,40}$` and is in the catalog, else 404; `shopDomain` matches
  `^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$`).
  - Refused with 409 `already_connected` while the tenant has a row for that toolkit in
    `active`, `reauthorize` or `disconnecting`. Reconnect is disconnect, then connect (C-13).
  - Limits before the worker call: `conn-connect:<tenantId>` 10 per hour, in the shared
    store, all or nothing. The charge returns a receipt. The API gives the unit back (once, in
    the window it was taken in, never below zero) only when the worker marks a refused link
    `beforeProvider`: the refusal came before the first call to Composio. Those are our own
    refusals: an unknown toolkit or a missing auth config of ours, the native tier refusing a
    Composio Shopify link (C-18), and our own organization budget refusing the call (C-12) or
    failing to be read. Once the call to Composio starts, the charge stands whatever happens: any
    status or error envelope (a documented 400, 404 or 422 included), a timeout, a network error,
    an unreadable body, or a failure after an account exists. Composio gives no guarantee, from
    an error answer or from its account list, that nothing was created, so no later answer can
    prove it. A refund also takes one unit of `conn-connect-refund:<tenantId>` (3 an hour) first.
    That bounds refunds to 3 per refund window per tenant; it is not a flat cap on attempts,
    since the charge and refund windows are separate and a boundary can allow a burst across two
    windows. The refund only gives back a rate-limit unit; no money or billing credit moves. It
    runs inside the request deadline (1.5 s); a refused allowance or a failed allowance check keeps the
    charge and is reported (`connect_refund`: `capped` or `failed`). A refund call that throws or
    is cut off is reported `commit_unknown`: it may still have committed, so the charge may or
    may not have come back. Every Composio link failure except a 402 or 429 (which raise the `cooldown` report) raises a
    `link_refused` worker
    report (class and request id only) so an operator sees a run of them; no report claims or
    removes an account. `beforeProvider` is not in the wire body (the strict contract is
    unchanged): the worker sets the response header `x-zs-link-before-provider: 1`, so the API and
    the worker deploy in either order (an older API ignores it, an older worker never sends it).
  - The API makes a random attempt ID and a random connection ID and asks the worker to
    `link`. The worker inserts `connection_attempts` (`tenant_id`, `id`, `connection_id`,
    `toolkit`, `composio_account_id`, `auth_config_id`, `created_by` (the member's
    `tenant_members.id`, which the API reads in the same transaction as the permission check),
    `browser_hash`, `status` `started`, `expires_at` 10 minutes ahead, `created_at`) and returns
    `redirect_url` and the Composio account ID.
  - A link refused for the budget or a Composio 429 is 429 `rate_limited` with the worker's
    `retryAfterSeconds` (60 when it gives none). When the attempt insert fails after Composio
    made the account, the worker deletes that account at once if no attempt or connection row
    names it; if the delete fails it records the attempt as `cancelling` so the sweep removes
    it, and only if that also fails does it report `link_orphan` to the operator, with the
    Composio account ID so the operator can remove it.
  - The API answers `{ authorizeUrl }` and an attempt token `zca1.<body>.<tag>` in the
    `X-Zs-Connect-Attempt` header, signed by `CONNECTIONS_STATE_SECRET` (domain-separated;
    `CONNECTIONS_STATE_PREVIOUS_SECRET` verifies through a rotation). It names the tenant, the
    member, the toolkit, the attempt ID, the connection ID, the Composio account ID, the auth
    config ID, the browser hash and the expiry.
  - The dashboard route keeps it in `zs-connect-attempt` (httpOnly, `SameSite=Lax`, path
    `/api/connections`, 10 minutes) only when the API answered 200, and returns only
    `{ authorizeUrl }`. The attempt never goes in a URL.
  - Two tabs: the browser key is kept, so both links stay bound to the browser, but the
    attempt cookie holds the newest attempt (last start wins). The older link finishes with
    `reason=attempt_changed` and its account is swept (C-9). Its callback carries no account
    ID, so the worker finds the account in the redemption answer (C-5); the redemption
    activates that account at Composio, and the sweep removes it.
- **C-5 Callback, stage, confirm.**
  - Callback. Composio redirects to the dashboard's `GET /api/connections/callback`
    (`CONNECTIONS_CALLBACK_URL`). Composio's redirect carries `session_uri` and nothing else:
    no account ID, user ID or toolkit (observed 2026-11-07, C-17). The dashboard forwards only
    `session_uri`, and `connected_account_id` if a callback ever has one, with the attempt token in `X-Zs-Connect-Attempt` and the browser key in
    `X-Zs-Browser-Key`, to the API's anonymous `GET /oauth/connections/callback`. The API
    answers 400 when the attempt is missing, forged or expired (the dashboard shows
    `reason=invalid_attempt`); otherwise 303 to `CONNECTIONS_RETURN_URL` with
    `connection=confirm`, `connection=connected` or `connection=error&reason=…`. The
    dashboard rebuilds its own redirect to `/account/connections` from that answer (never the
    API's address), with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
  - Checks, in order, first failure answers: `browser_mismatch` when the browser key's
    SHA-256 differs from the attempt's (constant time); `attempt_changed` when the query carries an
    account ID that differs from the attempt's (a missing one is the normal case and passes); `forbidden` when the member no longer holds
    `integrations` (read in a tenant transaction for the attempt's tenant); `rate_limited`
    over `conn-callback:<tenantId>` (30 per hour); `connected` when the attempt's connection
    row exists, is `active`, and has the attempt's toolkit and Composio account (a reload; the
    attempt token carries no external account ID, so the account ID is the binding),
    `conflict` when it exists otherwise.
  - Then the worker's `complete`, bounded by 7 seconds of the 10 second deadline. It first
    locks the attempt: `cancelling`, `cancelled`, `swept` or a missing attempt is
    `invalid_attempt`, `confirmed` is `conflict`, and one past `expires_at` is `expired`. A
    callback that carries a `session_uri` records `session_presented_at`; a status call (no
    `session_uri`) on an attempt that never had one is `not_connected`. It redeems only a
    `started` attempt, and it moves the attempt to `verified` with a conditional update that
    fails (`invalid_attempt`) if a cancel or the sweep moved it meanwhile:
    - redeem `session_uri` with the tenant's `user_id`. Composio's answer names the account
      and toolkit. Because the callback names no account, this answer is what ties the session
      to the attempt: the account must equal the account ID the attempt stored at link time,
      and a toolkit that differs from the attempt's is refused. A session that names the
      tenant's other attempt's account ends this link as `attempt_changed` (two tabs, C-4); any
      other account is `not_connected`. The next step then checks the user. While a
      redemption may still be in flight (a callback that redeems leases the attempt for 8 seconds and frees it when the
      redemption returns),
      another callback or status call for the attempt answers `rate_limited` and never reads
      the account, so a fabricated session cannot ride a racing call into the lost-answer
      path. If Composio says the session is
      unknown or used (404) and an earlier callback for this attempt had presented a session,
      read the account instead: only this browser held that `session_uri`, so an account that
      is now `ACTIVE` for this `user_id` was redeemed by our earlier, lost call. On the first
      presentation a 404 is final, as are a 400 (Composio checked `user_id`) and a redemption
      that names another account or toolkit: the answer is `not_connected` and `session_presented_at` is
      cleared, so no status call can verify the attempt afterwards. A 401, 403 or 410 is our key
      or project (`provider_unavailable`, reported as `key_refused`), never the used-session
      path; that, a 429 and a spent budget also clear `session_presented_at`, since nothing was
      redeemed. Only a call with no answer (network, timeout, 5xx) leaves it for the retry;
    - read the account once and refuse it unless its ID, `user_id`, toolkit and auth config
      are the attempt's and its status is `ACTIVE` (`not_connected`). `INITIATED` or
      `INITIALIZING` answers `pending`; the page then calls the dashboard's
      `GET /api/connections/callback/status`, which repeats this step without the redemption,
      at most 5 times, 2 seconds apart (2 to 10 s after the callback), while the attempt is valid. Each status call costs one
      unit in `conn-status:<tenantId>` (120 per hour), `conn-status-attempt:<attemptId>` (5 per
      hour) and C-12's `conn-minute` and `conn-day` buckets, all or nothing;
    - read identity with the toolkit's identity tool, on that account only, and keep the
      store's numeric ID as `external_account_id` and the shop name as the label (C-6). The
      attempt moves to `verified`.
  - Stage. On success the callback connects nothing (G-2). It answers a grant token
    `zcg1.<body>.<tag>` in `X-Zs-Connect-Grant`: the attempt's fields, the external account
    ID, the label, 10 minutes. The dashboard keeps it in `zs-connect-grant` (httpOnly,
    `SameSite=Strict`, path `/api/connections`).
  - Read. `GET /v1/connections/pending` (permission `integrations`) answers
    `{ grantId, toolkit, shopDomain, accountLabel, expiresAt, tokensWithAccess }`.
    `grantId` is the base64url SHA-256 of the grant. `tokensWithAccess` counts the tenant's
    live tokens with `connections:read`, which will read this store once it is confirmed
    (C-11).
  - Confirm. `POST /v1/connections/confirm { grantId }` (permission `integrations`, checked
    before the body; no `Idempotency-Key`). 409 `grant_changed` when the browser's grant has another `grantId`; it
    connects nothing and keeps the cookie. Otherwise it runs `connection.connect` through the
    dispatcher as the signed-in member, under the reserved key `connect:<connectionId>`, with
    a payload the server built from the grant, so a repeat replays. A grant that is missing,
    forged, expired, or names another member or tenant answers 404. The payload names no
    Composio account: the insert takes it from the verified attempt (C-7), so a grant whose
    attempt was cancelled or swept meanwhile is 409 `attempt_changed` and connects nothing. A
    key that already holds another payload is 409 `conflict`. The action refuses any other key
    and is never approved (C-16).
  - Cancel. The dashboard's `DELETE /api/connections/pending` sends both the grant and the
    attempt token to the API's `DELETE /v1/connections/pending`. The attempt the staged grant
    names wins over the attempt cookie (the cookie may hold a newer start). The worker locks
    the attempt and moves it to `cancelling` under its lease, so it can no longer connect,
    then reads the account, revokes once (the outcome is kept in `revoke_outcome`) and deletes
    it (revoke as C-13), and marks the attempt `cancelled`. Answers: 200
    `{ cancelled: true, revokeFailed }` (`revokeFailed`: the owner should remove the app in
    Shopify admin; it is also true when the account was left alone: a read that names no user,
    which the sweep retries, or a repeat of a cancel that ended with `account_mismatch`); 404 when nothing is waiting (no attempt, already `confirmed`, or its
    account is owned by a connection row, which is never removed); 409 `account_mismatch` when
    the account is not this tenant's (left alone, the attempt ends, the operator is told); 429
    with `Retry-After` when the budget is spent or Composio answers 429 (the attempt stays
    `cancelling` for a retry or the sweep); 409 `cancel_in_progress` while another cancel or
    the sweep holds the attempt's lease (the removal has no outcome yet; ask again); 503 when
    Composio is unavailable. The dashboard drops the two cookies after a 2xx or 404 only, so
    every other answer leaves them for a retry.
  - Cookies. The dashboard drops the grant after a confirm that names it answered 2xx, 403,
    404 or 409, and after a 404 read. A callback that arrives without a usable attempt cookie
    answers `invalid_attempt` and drops the grant too. A cancel while the dashboard's live
    settings are invalid is a 503 that keeps both cookies. Sign-out, and any API 401, drop all
    three connect cookies.
- **C-6 Catalog and curated read tools.** The catalog is code. Per toolkit: slug, display
  name, auth config variable, identity tool, provider scopes the auth config grants (recorded
  from the preview consent screen), and an allowlist of read tools. Each tool has our name
  (`<toolkit>_<verb>`, at most 40 characters), the Composio slug, a pinned toolkit version
  (every call sends it; a missing version is an error), a strict input schema in our
  contracts (unknown fields are refused, at the API and again at the worker), an output
  schema that keeps only named fields, and a disclosure line (C-11). Revision 2 catalog:
  - Shopify, identity: shop details (numeric ID, name, `myshopify` domain). The owner types the
    store name on Composio's hosted form (the auth config's `subdomain` field); our consent step
    then refuses any other store than the one named (C-5, C-14).
  - Shopify, provider scopes: `read_orders`, exactly what the auth config holds (read from
    Composio's API, 2026-11-07). Shopify's consent screen words it as "View customer data" and
    "View store data: Orders"; no `read_customers` scope is requested or granted.
  - Shopify, uninstall (C-13): `POST /graphql.json` with the mutation `appUninstall`, one fixed
    request in the catalog, through Proxy Execute.
  - `shopify_list_orders { createdAfter?, createdBefore?, status?, limit? }`: at most 50
    orders, a range of at most 92 days (also when only `createdAfter` is given). Each order is
    projected on its own: an order that does not fit the output schema is left out, and so is
    a line item; at most 250 line items per order are kept. Output per order: ID, name, created and updated
    time, financial and fulfilment status, currency, totals, line items (title, quantity,
    price) and the customer's ID, name and email.
  - `shopify_get_order { orderId }`: the same fields for one order.
  A version change is a code change with a recorded fake response. CI checks recorded
  fixtures only; the owner-run `pnpm connections:check-catalog` (vault key, preview) checks
  live slugs and versions.
- **C-7 Table `connections`** (tenant table): `tenant_id`, `id`, primary key
  `(tenant_id, id)`, `tier` (`composio`), `toolkit`, `composio_account_id`,
  `external_account_id`, `account_label` (null once `disconnected`), `status` (`active`,
  `reauthorize`, `disconnecting`, `disconnected`), `reauthorize_reason` (`provider_status`,
  `auth_error`, null), `connected_by` (member, `ON DELETE RESTRICT`), `last_checked_at`,
  `last_error_code` (our code, cleared on recovery; includes `provider_permission_denied` on an `active` row, C-8), `revoke_outcome` (`revoked`, `failed`,
  null; only on a row leaving, C-13), `claimed_until` (the worker's lease, C-9), `created_at`,
  `updated_at`; every column but the nullable five is `NOT NULL`.
  - At most one row per tenant and toolkit in `active`, `reauthorize` or `disconnecting`
    (partial unique index). `composio_account_id` is unique over all rows: a disconnected
    account is deleted at Composio, and a reconnect makes a new one.
  - Forced RLS, policies `TO authenticated` with the tenant check, two-tenant denial test.
  - Runtime role: `SELECT`; `INSERT` without `composio_account_id` (the only caller is the
    connect action); `UPDATE` granted on `status` and `updated_at` only. No `DELETE`.
  - Triggers. For every role: `disconnected` is final, `disconnecting` only becomes
    `disconnected`, and `reauthorize` with `auth_error` never becomes `active` (C-8). The
    runtime rules bind every role but the worker (a superuser, or a member of `service_role`
    that is not a member of `authenticated`), so the API's login is bound with or without
    `SET ROLE`: an insert must be `active`, and the only status move is `active` or
    `reauthorize` to `disconnecting` (`ERRCODE 42501`). An insert without a Composio account
    takes it from the worker's attempt for that connection ID, locked `FOR UPDATE`: it must be
    the tenant in context, `verified`, and have the row's toolkit, domain, external account
    and member; it is marked `confirmed` in the same transaction. Otherwise the insert fails
    with `23514` `connections_verified_attempt`. That trigger is a definer owned by
    `zs_dispatcher`, which reads those attempt columns and updates their status only.
  - `connection_attempts` (C-4) is a tenant table with forced RLS and no runtime grants: only
    the worker reads and writes it. `created_by` is the member (`tenant_members.id`,
    `FOREIGN KEY (tenant_id, created_by)`, `ON DELETE SET NULL`); one attempt per connection
    ID. It also holds `external_account_id` (set with `verified`), `session_presented_at`
    (C-5), `last_error_code`, `revoke_outcome` and `claimed_until`. Statuses `started`,
    `verified`, `confirmed` (set by the connection insert), `cancelling` (a cancel or a
    failed link cleanup the sweep finishes), `cancelled`, `swept`.
  - `connector_request_nonces` (`jti` primary key, `expires_at`) holds no tenant data. It is
    in `public` with forced RLS, no policy and no runtime grants, so only the worker's service
    role reaches it (`zs_internal` is the migrator's private ledger and holds no runtime
    table).
  - The worker uses `CONNECTIONS_DATABASE_URL`, a login that may `SET ROLE service_role`, as
    the calendar worker does (G-6). Every worker statement names the tenant and the row's ID,
    and every status change is conditional on the current status
    (`UPDATE … WHERE status IN (…)`).
- **C-8 Status map.** Composio status to our state, exhaustive; an unknown value fails
  closed.
  - In `complete`: `ACTIVE` goes on; `INITIATED` and `INITIALIZING` are `pending`;
    `INACTIVE`, `FAILED`, `EXPIRED`, `REVOKED`, a 404, a mismatched account and anything else
    are `not_connected`.
  - For a live row: `ACTIVE` keeps or restores `active`; every other value and a 404 moves
    `active` to `reauthorize` with `reauthorize_reason = provider_status`.
  - A tool run that fails with a provider auth error (the provider's 401, in a structured status
    field of Composio's answer) moves the row to `reauthorize` with
    `reauthorize_reason = auth_error`. Such a row returns to `active` only through
    Reconnect, never because a later read says `ACTIVE`: a cached status does not prove the
    credential works.
  - A tool run that fails with a provider 403 and no 401 (Shopify answers it when the app lacks
    protected customer data approval; recorded in preview run 3, 2026-11-07) is
    `provider_permission_denied`, not an auth error: the credential works and reconnecting cannot
    fix it. The row stays `active`; the worker sets `last_error_code = provider_permission_denied`
    (the list shows `readBlocked` and the card says the store's app permissions block the reads).
    A run that succeeds clears it; a health read does not. A 401 beside a 403, or a 401 later,
    still moves the row to `reauthorize`. A 429 outranks both.
  - The worker restores `active` only from `reauthorize` with `provider_status`, only while
    no other live row exists for that tenant and toolkit, and never touches a
    `disconnecting` or `disconnected` row.
- **C-9 Health, sweep, schedule.** `GET /cron/connections` in the worker project
  (`Authorization: Bearer <CRON_SECRET>`, 404 without a secret, 401 before any work), on
  `CONNECTIONS_CRON_SCHEDULE` (every 5 minutes). Each pass, at most 20 seconds (configurable,
  never above 25, inside the function's 30) and at most 200 Composio calls, takes rows oldest
  first. It leases one row at a time: a short transaction sets `claimed_until` one minute
  ahead through `FOR UPDATE SKIP LOCKED`, and no transaction is held across a Composio call.
  The lease is released only by the worker holding it (`WHERE claimed_until = <its lease>`).
  Cancel and disconnect lease the same way, so two workers never remove one account at once:
  - `disconnecting` rows: finish them (C-13);
  - attempts left `cancelling`, and attempts `started` or `verified` past `expires_at` plus
    one hour: when a connection row has the attempt's connection ID or Composio account, the
    account is owned and never removed; the attempt ends `confirmed` (or `swept` when it has no
    external account). Otherwise delete that Composio account after a fresh read shows its ID,
    `user_id`, toolkit and auth config are the attempt's (a 404 counts as done), then mark the
    attempt `cancelled` (from `cancelling`) or `swept`. A foreign account is left alone and the
    attempt ends with `account_mismatch`. A read that names no `user_id` is retried, reported
    as `sweep_failed`, for 24 hours past the sweep time, then the attempt ends with
    `account_unverified`. A failed delete keeps `delete_failed` and is retried next pass. The sweep deletes only accounts named by an
    attempt row with no connection row. It never lists or deletes other accounts;
  - live rows with `last_checked_at` older than 24 hours: read the account (C-8). A row whose
    toolkit has no auth config in this worker is checked off with `not_configured`, so it never
    blocks the rest. A read that succeeds clears a transient code (`provider_unavailable`,
    `provider_rate_limited`, `not_configured`) only on an `active` row; a row still `reauthorize` keeps its last
    code until it recovers;
  - nonces past `expires_at`: delete.
  A Reconnect button shows on a `reauthorize` row, except a `native` row (the owner reopens the
  app in the Shopify admin) and, when the API does not say the tier, a row under the native tier
  (C-18). For owners, the dashboard's Home shows one
  notice line while any connection is `reauthorize`, read from `GET /v1/connections` (not from
  `home_results`). Nothing is sent by email or text.
- **C-10 Agent access over `/mcp`.** New scope `connections:read`. Three tools, listed only
  when C-3's config is present and the token holds the scope. All three have
  `readOnlyHint: true`, and `run_connection_tool` also has `openWorldHint: true`:
  - `list_connections`: the tenant's `active` and `reauthorize` connections
    (`connectionId`, toolkit, label, status), at most 20.
  - `list_connection_tools { connectionId }`: that toolkit's catalog tools with our input
    schemas.
  - `run_connection_tool { connectionId, tool, arguments }`: one catalog read.
  - Order: H-3's token guard; then the connection (the tenant's and `active`, else
    `not_found`, also for another tenant's ID; `reauthorize` is
    `connection_needs_reconnect`); then the tool (in that toolkit's catalog, else
    `not_found`); then the strict argument schema (`invalid_arguments`); then C-12's limits;
    then the worker. A call whose own fields do not fit (a connection ID that is not a UUID,
    an unknown field, a missing one) is `invalid_arguments` too, after the token guard.
  - Time: the API aborts the worker call at 7 seconds and answers `provider_unavailable`
    inside the 10 second deadline. The worker aborts Composio at 6 seconds. Both pass the
    request's abort signal on.
  - Size: the worker reads at most 1 MiB of Composio's body (refused past that as
    `provider_unavailable`), parses it, keeps only the output schema's fields, then drops
    trailing list items until the data is at most 64 KiB of JSON.
  - Result: `{ data, truncated, notice }`, where `notice` is H-10's untrusted-data text and is
    never trimmed. It is both the text content and the structured content, as other tools
    are.
  - Errors are tool results with `isError: true` and
    `{ error: { code, retryAfterSeconds? } }`. Codes: `not_found`, `invalid_arguments`,
    `connection_needs_reconnect`, `provider_rate_limited`, `provider_unavailable`,
    `provider_permission_denied` (C-8). They are never provider text. Composio's envelope is checked: `successful: false`, a missing
    `data` or a body that fails the output schema is an error, never data.
  - H-8: every call counts as a request. Every error code counts as a refusal except
    `provider_unavailable`.
- **C-11 Disclosure.** `connections:read` lets an agent read, from every store the business
  connects now **or later**, its orders with customer names and emails, line items and
  totals. The scopes route (H-9) returns this text. The confirm screen shows it with
  `tokensWithAccess`, the provider scopes Composio's app was granted (C-6), and C-14's
  retention line.
- **C-12 Limits.** Each run, before the worker call, costs one unit in
  `conn-minute:<tenantId>` (60 per minute) and `conn-day:<tenantId>` (2,000 per day), all or
  nothing; over either is `provider_rate_limited` with `retryAfterSeconds`. Callback status
  calls (C-5) spend the same two buckets. The worker also
  charges `composio-org:<env>` for every Composio call it makes, of any operation:
  production 3,000 and preview 500 per minute, so both projects together stay under a third
  of the organization's 10,000. Over that, the worker refuses the call (`provider_rate_limited`
  for runs; health and sweep stop the pass). A Composio 429 or provider quota error is
  `provider_rate_limited` and opens a 60 second cooldown on `composio-org:<env>`. The
  Composio dashboard's spend cap stays at or under the pilot budget (C-17).
- **C-13 Disconnect.** `POST /v1/connections/:id/disconnect` with an `Idempotency-Key`,
  permission `integrations`, runs `connection.disconnect` (a direct action): `active` or
  `reauthorize` becomes `disconnecting`, and its outbox event
  `connection.disconnect_requested` commits with it; `disconnecting` and `disconnected` answer
  as they are. The API then asks the worker to `disconnect` at once (best effort); the pass
  (C-9) finishes any it missed.
  - The worker first reads the account and removes it only when its ID, `user_id`, toolkit
    and auth config are the row's. It then revokes once: it uninstalls the app on the merchant's
    side with the toolkit's fixed catalog request through Proxy Execute (for Shopify,
    `appUninstall`, C-6), as the account's own credential. Only a clean answer counts as
    `revoked`: HTTP 200 from the provider, no top-level `errors` and an empty `userErrors`.
    A stale token (401), any other answer, a Composio error or a toolkit with no uninstall
    request is `failed`. The outcome is kept in `revoke_outcome`, so a retry never revokes
    again; a Composio 404 counts as revoked. A Composio or relayed provider 429 opens the
    cooldown and records nothing, so the retry uninstalls. The uninstall is skipped, with nothing
    recorded, while another live connection of any tenant holds the same store (same typed domain or
    verified store ID): the app is installed once per store, so removing it would cut that
    connection off, and only this Composio account is deleted. Link compensation (B-7) never
    uninstalls: it only deletes an account nobody has consented to. Then `DELETE` (a 404 counts as done), then marks the
    row `disconnected` and clears the label. Composio's own `revoke` is not called.
  - Why the worker makes this one write to the provider: deleting the Composio account drops
    Composio's copy of the token but leaves the app installed on the store, with its token valid
    (observed on preview, run 3). Only the app itself can remove its install, and the token is
    held at Composio, so the worker asks through Proxy Execute. The request is a constant in the
    catalog: no caller, tenant, store name or tool argument reaches it, and it needs no access
    scope. The older REST call, `DELETE /admin/api_permissions/current.json`, sits outside the
    toolkit's versioned base URL and is legacy; GraphQL `appUninstall` is the current equivalent.
    It is irreversible, so it runs only from a leased `disconnecting` row, a cancel or a sweep,
    after the account proves to be the tenant's. An account
    that is not the tenant's, or whose read names no user, is left alone: the row ends
    `disconnected` with `account_mismatch` and the operator is told. A failed read or delete
    keeps the row `disconnecting` with `delete_failed` for the next pass. A worker that has no
    auth config for the row's toolkit cannot prove the account is the tenant's, so it calls
    nothing: the row stays `disconnecting` with `not_configured` until the config is back, and
    the operator is told.
  - A revoke that fails is recorded as `last_error_code = revoke_failed`; the delete still
    runs. The screen then tells the owner to remove the app in Shopify admin, until a newer
    connection of the same store replaces that row (connecting again installs the app under
    the new grant, so the newer row says what is true; found on preview, run 4). The
    screen says in every case that disconnect stops our access and asks Shopify to remove
    the app's access.
  - Runs stop at `disconnecting`.
  - `GET /v1/connections` (permission `integrations`) lists the live rows and the newest 20
    `disconnected` ones, never a Composio or external ID.
- **C-14 Data handling.**
  - We store the shop name (`account_label`), the store's numeric ID, the shop domain and
    Composio account IDs. The label is also in the connect action's history, which is
    append-only.
  - We store no tool arguments and no tool output.
  - Logs and error reports carry the tenant, connection ID, our tool name, our error code
    and timings. Every run is logged that way; a callback's log line names the attempt's
    tenant and connection ID; `account_mismatch`, `link_orphan` and `key_refused` are
    warnings for the operator. They never carry arguments, output, labels, link URLs or provider messages.
    Account reads are parsed with an allowlist schema that drops `state` and every
    credential field.
  - Composio is a subprocessor: it logs tool arguments and results for up to one year by
    default. Zero data retention does not cover its managed apps below Enterprise. The
    confirm screen says so, and the Mac sets the shortest log retention the plan allows.
  - Labels are normalized (NFC; control, format and bidirectional characters removed;
    whitespace collapsed; 1..120 characters) and rendered as text, next to the shop domain.
- **C-15 Tests.** An in-process fake Composio server with recorded responses; no test calls
  Composio. The cloud never holds the key. Tests prove:
  - fixation: A starts, B consents in another browser, A's browser cannot stage or confirm,
    and B's callback stages nothing;
  - a callback with `session_uri` only finishes (the real shape); a callback that carries
    another account ID, or whose redemption names another account, `user_id`, toolkit or auth
    config, is refused; a browser key mismatch is refused; a demoted member's callback is `forbidden`;
  - a lost `complete_auth` answer recovers on the retry of the same `session_uri`-only
    callback; a used or unused `session_uri` from another tenant never connects;
  - a reload after confirm answers `connected` only for the same toolkit and Composio
    account (the row's store is the verified attempt's: the insert binds `external_account_id`
    to the attempt, and no application role can update it afterwards); a confirm replays under its key; another grant is `grant_changed`; an expired
    attempt or grant is refused;
  - Cancel deletes the Composio account at once; sign-out and an API 401 drop the cookies;
  - tenant A's token never lists or runs tenant B's connection, also with B's IDs; a tool
    outside the catalog, an extra argument field or an override field (`custom_auth_params`,
    `text`) is refused at the API and again at the worker;
  - an unsigned, stale, wrong-host, wrong-env or replayed (`jti`) internal request is
    refused;
  - a revoked token mid-run is refused on its next call;
  - a worker past 7 seconds answers `provider_unavailable` inside the deadline;
    `successful: false` with HTTP 200 is an error; a 2 MiB body is refused; a long list is
    trimmed and flagged while the notice stays whole;
  - the status map, including `INACTIVE` and an unknown value; health never restores an
    `auth_error` row or touches a `disconnecting` one (both race orders);
  - the sweep deletes only attempt-named accounts past expiry plus one hour;
  - disconnect uninstalls the app through Proxy Execute (one fixed request, the row's account and
    derived user, before the delete), deletes, ends `disconnected` and clears the label; a stale
    token, GraphQL `errors` or `userErrors`, or a Composio error is `revoke_failed` and the delete
    still runs; a provider 403 on a run is `provider_permission_denied` with the row `active`
    (and a 401 still `reauthorize`);
  - the runtime role cannot set any status but `disconnecting` or any other column
    (`42501`), cannot insert a non-`active` row or one without a matching verified attempt,
    and cannot read `connection_attempts`; the same holds for its raw login without
    `SET ROLE`;
  - the catalog two-tenant suite covers the new tenant tables;
  - org and tenant limits refuse before the worker or Composio is called.
- **C-16 Migration and wiring.** One forward migration:
  - adds `connections:read` to `automation_token_scope` and raises the scopes cardinality
    check to 10;
  - replaces `automation_tokens_read_expiry` with the same check, its scope list (compared as
    text, so the new value works in the same transaction) including `connections:read`;
  - creates `connections`, `connection_attempts` and `connector_request_nonces`: `REVOKE ALL`
    from `PUBLIC`, `anon`, `authenticated` and `service_role` first, then the grants of C-7;
    forced RLS and policies;
  - adds the triggers.
  Code: `READ_SCOPES` and the scope enum gain `connections:read`; the request, command,
  output and error schemas are added to `packages/contracts`; `connect:` joins
  `SERVER_IDEMPOTENCY_PREFIXES`; both actions get `integrations` in `ACTION_PERMISSIONS`,
  join `NEVER_APPROVED_ACTIONS`, and run beside the integration actions in
  `packages/core/src/automation/admin.ts`; `packages/db/test/tenant-tables.ts` gets
  generators for the new tables; the dashboard adds `connections` to the proxy's `AREAS` for
  the plain routes and dedicated handlers for connect, callback, callback status, pending
  `DELETE` and confirm, as `calendar-connect.ts` does.
- **C-17 Production opening and measurement.** Devin directed on 2026-11-07 that production
  opens now, Zero Sum first; the preview measurement is monitoring only and gates nothing.
  What opening needed, and where each item stands:
  - deferred verification on for the Composio project, and a callback without `session_uri`
    connects nothing. **Met** on preview (runs 2 and 3) and set on the production project
    `zs_business_prod` (the OAuth user verification URL is
    `https://app.zerosumsolutions.com/api/connections/callback`);
  - the Shopify consent screen, the granted scopes and the click path are recorded. **Met:**
    `read_orders` only, shown by Shopify as "View customer data" plus "View store data:
    Orders". Preview run 4: 3 clicks. Production runs P1 and P2 (2026-11-07) on a store without
    the app: Connect Shopify, Connect Account, Shopify's account pick, Install and Connect
    store; the owner types the store name twice (Known limits);
  - revoke and delete remove the app from the store. **Met:** on preview run 4 and on both
    production runs: the row ended `disconnected` with `revoke_outcome = revoked`, Composio
    held 0 accounts, and the app was gone from the store's installed apps;
  - Devin approved C-14's retention terms for client data. **Met** 2026-11-07. Both Composio
    projects are on the Pro plan with Zero Data Retention on (a second project has no extra fee);
  - a production Composio project, a production key with the same permissions as the preview
    key (Proxy Execute included), a Shopify auth config with `read_orders` only, and the
    Shopify app's protected customer data access. **Met** (the list below);
  - latency, the grant failure rate and cost per tenant per month are measured. **Monitoring.**
    Latency: preview run 4 and production P1 (connect click to the Composio page 1.5 s,
    Composio to the Shopify install screen 7.1 s, Install to our confirm screen 5.0 s, confirm
    to connected 0.5 s, an order list 1.8 s, an order read 1.5 s, disconnect 2.7 s). The preview
    window runs from 2026-11-07 to about 2026-11-21: grant failure rate (attempts that end
    `cancelled` or `swept` against attempts that end `confirmed`, from `connection_attempts`)
    and cost per tenant per month (the Composio project's usage and plan charge, divided by the
    connected tenants). Composio has no spend cap.
  What production was seen to do (runs P1, test tenant 2c8cc360, and P2, Zero Sum tenant, both
  on store `zs-hub-test-store`): connect, confirm, `active`, `/mcp` `list_connections`,
  `list_connection_tools`, `shopify_list_orders` and `shopify_get_order`, disconnect, uninstall.
  The catalog check passed with the production key, and `/cron/connections` answered
  `ran: true`. Record: the C17-prod files in the goal-state proof folder.
  - **Customer fields.** The test order had a customer. At protected customer data Level 1,
    Shopify returns the customer with `first_name`, `last_name`, `email` and `phone` all null
    (checked against Composio's raw answer for the same account), so the tools return
    `customer: {id, name: null, email: null}`. Nothing fails and nothing is mapped wrong.
    Names, emails, phones and addresses need Level 2, which is a separate Shopify request. The
    confirm screen's sentence about "customer names and emails" is right only once Level 2 is
    granted.
  - **Other stores.** The production app `ZS Business Connections` is not distributed. Shopify
    installs it today only on stores of the development organization. For any other store,
    Shopify needs one irreversible choice that Devin makes: Public distribution (App Store
    review, protected customer data review, the data protection details, and a one-time
    registration fee) or Custom distribution (an install link per store, or per Plus
    organization, no review, protected data always available, one auth config per app). Until
    then production connects Zero Sum's own stores only.

### Revision 4: the Shopify App Store listing (2026-11-07, Track K)

Goal: clear every Shopify App Store requirement that costs no money, so the listing can go in
when Devin pays the one-time registration fee. This revision adds a **native** tier (`native`)
for Shopify beside the `composio` tier, an embedded app page, install-to-tenant binding with no
operator, and the compliance webhooks. It changes C-1, C-4, C-7, C-13 and C-14 only where
named. Nothing here submits the listing.

Sources (all read 2026-11-07; the Shopify docs change, so a build re-reads the page it relies on):
- S1 App Store requirements: https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements
  (1.1.1 session tokens, no third-party cookies; 1.2.1 Shopify billing; 2.2.1 to 2.2.4 APIs,
  embedded, latest App Bridge `app-bridge.js` first, GraphQL; 2.3.1 install from a Shopify
  surface and no typed shop domain; 2.3.2 authenticate before any UI; 3.1.1 TLS; 3.1.2 expiring
  offline tokens; 3.2 minimum scopes).
- S2 Expiring offline tokens: https://shopify.dev/docs/apps/build/authentication-authorization/migrate-to-expiring-offline-access-tokens
  and https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens
  (delisting of apps on non-expiring tokens from 2027-01-01, rejected Admin API calls from
  2027-04-01; `expiring=1`; access token 3600 s; refresh token 90 days; every refresh returns a
  new pair; the presented refresh token stays usable until the new one is used; a refresh and a
  token exchange for one store must not run together; a bad refresh token is `401 invalid_request`).
- S3 Token exchange: https://shopify.dev/docs/apps/build/authentication-authorization/get-access-tokens/token-exchange
  and ID tokens https://shopify.dev/docs/apps/build/authentication-authorization/session-tokens
  (HS256 with the client secret; claims `iss`, `dest`, `aud`, `sub`, `exp`, `nbf`, `iat`, `jti`;
  `requested_token_type` offline or online; the online token carries `associated_user`).
- S4 Managed installation: https://shopify.dev/docs/apps/build/authentication-authorization/app-installation/manage-by-shopify
  (scopes in the app configuration; `use_legacy_install_flow = false`).
- S5 App Home and App Bridge: https://shopify.dev/docs/apps/build/app-surfaces/app-home and
  https://shopify.dev/docs/api/app-bridge-library (`shopify.idToken()`, `shopify-api-key` meta).
- S6 Iframe protection: https://shopify.dev/docs/apps/build/security/set-up-iframe-protection
  (`Content-Security-Policy: frame-ancestors https://<shop>.myshopify.com https://admin.shopify.com;`
  on every HTML route, per shop; a missing or wildcard value fails review).
- S7 Privacy law compliance: https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
  (`customers/data_request`, `customers/redact`, `shop/redact`, set under `compliance_topics`).
- S8 Webhooks: https://shopify.dev/docs/apps/build/webhooks/subscribe/get-started and
  https://shopify.dev/docs/apps/build/webhooks/subscribe/https and
  https://shopify.dev/docs/apps/build/webhooks/verify-deliveries
  (`X-Shopify-Hmac-SHA256` is base64 HMAC-SHA256 of the raw body keyed with the client secret;
  `X-Shopify-Webhook-Id` for deduplication; answer 200 within 5 seconds; wrong HMAC is 401).
- S9 Composio create connected account (Shopify): https://docs.composio.dev/ (auth config and
  connected-account reference read 2026-11-07).

- **C-18 Why a native tier.** Composio's Shopify auth config has no field that asks Shopify
  for `expiring=1`, and Composio does not refresh a token it did not issue as expiring (S9,
  checked against the toolkit's auth detail). A public app whose stored tokens do not expire is
  refused by S1 3.1.2 and S2. So the listed app must hold its own expiring offline tokens:
  the worker does the token exchange and the refresh itself. Findings to prove on preview
  before the listing is called ready: connect the preview app through Composio once and read
  the account's token **field names only** (never values) to record whether `refresh_token` and
  `expires_in` are present; the result goes in the proof file and the Known limits.
  - The `composio` tier stays for toolkits other than Shopify, and for Shopify only while no
    native config exists (`SHOPIFY_CLIENT_ID` unset in the worker). With a native config the
    Shopify catalog entry is served natively; the Connections card sends the owner to the
    Shopify App Store, and no screen asks for a shop domain (S1 2.3.1). Existing `composio`
    Shopify rows keep working and are disconnected by the owner (C-13); the Zero Sum test
    store relinks through the claim flow (C-21).
  - **Connection `tier` (response field).** Each connection `GET /v1/connections` and the action
    results return carries `tier: "native" | "composio"`, read from the row. The field is optional in
    the contract (a stored result, or an older server, has none) and nothing else in the shape
    changes. The dashboard picks the Reconnect path from it. A `composio` Shopify row in
    `reauthorize` while the native tier is on shows **Reconnect**; the worker refuses a new
    Composio Shopify link then (`link` answers `not_found`), so that Reconnect is the native
    install, not a Composio re-link: it disconnects the old row (C-13), waits until it is
    `disconnected`, then makes a link code (C-22) and shows it. The owner installs the App Store
    app, enters the code and confirms the store (C-22; a claim is refused while the tenant still
    holds a live or `disconnecting` Shopify row). A `native` row in `reauthorize` shows no
    Reconnect, only the note to reopen the app in the Shopify admin. With no native tier,
    Reconnect stays the Composio disconnect-then-connect (C-13).
    While the native read is pending or failed, no Reconnect shows for any row (a Composio re-link
    would be refused after the disconnect). Deploy order: the dashboard first, then the API. The
    contract object is strict, so a dashboard built before this field rejects an API answer that
    carries it; a newer dashboard reads an older API (no `tier`) without change.
  - Why not Composio's `BEARER_TOKEN` import: Composio would hold our token and not refresh it,
    and order data would still pass through a subprocessor.
- **C-19 App configuration.** One app per environment: preview `ZS Business Conn (preview)` (Shopify caps names at 30 characters)
  (app id `444938846209`, tested on the dev store `zs-hub-test-store`) and production (`adc380d0312483cd9ab82a09d9f0e267`).
  Config files `shopify/preview/shopify.app.toml` and `shopify/production/shopify.app.toml`
  (no secrets; the client id is public): `embedded = true`; `application_url` is
  `<dashboard origin>/shopify/app`; `[access_scopes] scopes = "read_orders"` and
  `use_legacy_install_flow = false` (managed installation, S4); `[webhooks] api_version` pinned
  (checked by a live call in the build); `[[webhooks.subscriptions]]` for `app/uninstalled`
  and the three `compliance_topics`, `uri` = the worker's `/webhooks/shopify`. The
  minimum scope is `read_orders` (S1 3.2): not `read_all_orders`, and no customer scope. The
  app's protected customer data Level 1 stays as in C-17. The release is made by the Mac
  (Shopify CLI `shopify app deploy` or the Dev Dashboard) and recorded in the proof file.
- **C-20 The embedded page and session tokens.** Route `/shopify/app` in the dashboard.
  - First script is App Bridge `https://cdn.shopify.com/shopifycloud/app-bridge.js` with
    `<meta name="shopify-api-key">` (S1 2.2.3, S5). The client id is public config read at
    request time (`SHOPIFY_CLIENT_ID`, the same name the worker uses), not baked in.
  - The page sets and reads no cookie. After load it asks `shopify.idToken()`, and sends
    that token as `Authorization: Bearer` to the dashboard's `/api/shopify/*` handlers, which
    relay it to the API's public `/public/v1/shopify/embedded/*` routes (no session, no cookies, no
    CORS). A fresh token is requested per call (one-minute life). A `401` with
    `X-Shopify-Retry-Invalid-Session-Request` makes the page retry once with a new token.
  - Nothing is shown or enabled before `open` (C-21) returns: the page renders a neutral
    loading state, authenticates (token exchange happens there), then renders (S1 2.3.2).
    Outside the Shopify admin (no valid `shop` and `host`) the page shows a plain message and
    no actions.
  - It shows: the connection status (not linked; linked to `<business name>` with
    `Connected`, `Needs attention` or `Disconnected`), a link "Open ZS Hub" to the hub's sign-in
    page opened in a new top-level tab, and, when not linked, the two choices of C-21.
  - Headers (S6): every response of `/shopify/*` carries
    `Content-Security-Policy: frame-ancestors https://<shop> https://admin.shopify.com;
    base-uri 'self'; object-src 'none'` with `<shop>` the `shop` query value only when it
    matches `^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$`; otherwise `frame-ancestors 'none'`.
    The route has no `X-Frame-Options`. Every other dashboard route keeps `'none'` and `DENY`.
    The route handler sets it per request (not `proxy.ts`, which would buffer the body), and
    `next.config.ts` leaves `/shopify/app` out of the general frame ban, so the value is never
    static or wildcard. It also sends a nonce-based script and style policy.
- **C-21 Install-to-tenant binding with no operator.** The worker holds the Shopify client
  secret, the token seal key and the Supabase service key; the API and the dashboard hold
  none of them. New signed worker operations (same signing, nonce and deadlines as C-3):
  `shopify_open`, `shopify_create_hub`, `shopify_redeem_claim`, `claim_start`,
  `claim_status`, `claim_confirm`, `claim_cancel`. Public ID-token routes are `POST
  /v1/shopify/embedded/open|create-hub|claim`; owner routes are `POST /v1/shopify/claims`,
  `GET /v1/shopify/claims/current`, `POST /v1/shopify/claims/:id/confirm` and `DELETE
  /v1/shopify/claims/:id` (permission `integrations`, member role `owner`).
  - **ID token check** (worker, S3): HS256 against `SHOPIFY_CLIENT_SECRET` (and the previous
    one during a rotation), `aud` equals the client id, `exp` and `nbf` hold with 10 s skew,
    `dest` is `https://<shop>.myshopify.com` and `iss` is `dest + "/admin"`, `sub` present.
    Any other algorithm or a missing field is refused. The token only authenticates; it is not
    a one-action credential (`shopify.idToken()` may return a cached token, S3), so its `jti` is
    not consumed. A stolen token lives at most a minute plus the skew, and every state-changing
    operation is idempotent by shop (create-hub), by code (redeem) or by claim id (confirm), so
    a replay changes nothing a first call did not.
  - **`shopify_open`.** Verifies the token. If no live install exists (or the stored access
    token cannot be used and the refresh fails), runs a token exchange for an **expiring
    offline** token with `expiring=1` (C-22), reads `shop { id name myshopifyDomain }` with
    it, and upserts `shopify_installs`. Answers `{ shop: {domain, name}, link: none | linked,
    businessName?, connection?: active | reauthorize | disconnected }`. It is the single
    authentication step before any UI (S1 2.3.2, 2.3.4 on reinstall: an uninstalled row is
    revived by a new exchange).
  - **`shopify_create_hub` (new tenant).** Requires a live install with no binding, and an
    **online** token exchange whose `associated_user` has `account_owner = true` and
    `email_verified = true` (only the store owner can create a hub). The staff email is the
    owner. If that email already belongs to a hub user, the answer is `email_has_hub` and
    the page offers the claim flow instead (one tenant claim per user, `hub-access.md`). Else,
    in order: Supabase Auth admin creates the user (idempotent by email, `app_metadata.tenant_id`
    set by the existing provisioning code), the tenant, owner member and default records are
    created by the existing tenant-create code with the business name from the shop name, and
    only then one service-role transaction binds the store: `setShopifyBilling` sets
    `billing_provider = 'shopify'` for the shop GID and domain and a `connections` row is
    inserted with `tier = 'native'`, `status = 'active'`, `external_account_id` = shop GID.
    `createTenant` and `provisionOwner` commit in their own transactions and the Auth claim is a
    separate HTTP call, so this is **not** one transaction. The recovery protocol is the
    store-keyed key: the tenant key is `shopify-<numeric shop id>`, so `tenantIdForKey` gives the
    same tenant id on every retry. Both helpers are idempotent for the same key and owner
    email (a repeat finds the tenant and the member and sets the same claim), and the bind
    transaction is last and is itself idempotent (the store's own live row means "done"). A
    failure at any step leaves at most an unbound tenant keyed to this store, never a store
    bound to a half-made tenant; the next open of the app (`create-hub` again) finishes it.
    Tests inject failures between each pair of steps and re-run.
  - **Sign-in without a mailbox.** The page shows "Open ZS Hub" for the verified store
    owner. The worker asks Supabase Auth admin for a one-time sign-in link for the hub
    owner member's email (`generate_link`, type `magiclink`; the link is built from the returned `hashed_token` as `HUB_SIGN_IN_URL?token_hash=…&type=magiclink&next=/`, where `HUB_SIGN_IN_URL` is the dashboard's `/auth/confirm`, because Supabase's own `action_link` returns the session in a URL fragment that the server-side confirmation cannot read) and
    returns it; nothing is emailed. It does this only for the account owner of a shop whose
    native connection is active and whose hub owner member's email equals the verified
    store owner's email. This is the independent reviewer path of S1 4.5.4 and 4.5.5: a
    reviewer who installs on a dev store reaches the hub with no mailbox, code or SSO.
  - **Claim (existing tenant), three steps.** (1) An owner in the hub starts a claim:
    `claim_start` makes a code of 10 characters from a 32-letter alphabet (50 bits, CSPRNG),
    stores only `HMAC-SHA256(code)` in `shopify_claims` (tenant table: `tenant_id`, `id`,
    `created_by` member, `code_hash`, `status` `open | redeemed | confirmed | cancelled |
    expired`, `shop_id`, `shop_domain`, `shop_name`, `expires_at` 15 minutes, `redeemed_at`,
    `confirmed_at`), shows the code once, and allows one open claim per tenant. (2) In the
    embedded page the store owner (`account_owner`, `email_verified`, online exchange) types
    the code; `shopify_redeem_claim` finds the open claim by hash, records the shop on it
    (`redeemed`) and binds nothing. Five wrong codes for one install lock redeeming for an hour
    (`claim_failures`, `claim_locked_until`). (3) The hub owner sees "Link store `<shop name>`
    (`<domain>`) to this business?" with the shop domain, and only their Confirm binds:
    `claim_confirm` re-checks, in one transaction, that the claim is `redeemed`, unexpired and
    this tenant's, that the install is live and unbound, and that the tenant has no active
    Shopify connection; then inserts the `native` connection and calls `setShopifyBilling`.
    `setShopifyBilling` keeps its guards: an active Stripe subscription, a pending checkout or
    top-up, or a shop that another tenant's billing history names refuses the bind with
    `billing_conflict` (named in the answer: "End your Stripe plan first" and the like). The
    transaction rolls back whole (no connection row, no plan change), and the claim stays
    `redeemed` and retryable until it expires.
    A leaked code therefore cannot bind a store to a business: it only creates a pending claim
    the owner sees and can cancel.
  - **Isolation.** A shop is bound to one tenant (partial unique index on
    `connections(external_account_id)` where `tier = 'native'` and the status is not
    `disconnected`); a tenant has one live Shopify row (C-7). Claims are tenant rows with
    forced RLS and no runtime grants (only the worker reads or writes them). Denial tests run
    under the runtime role: tenant B cannot read, confirm or cancel tenant A's claim, a code
    started by A never binds to B, and two tenants confirming claims for one shop at once end
    with exactly one binding.
- **C-22 Tokens: expiring offline, sealed, refreshed.** Table `shopify_installs` (worker-only:
  no tenant column, `REVOKE ALL` from every role but the worker, forced RLS, no policy):
  `shop_id` (GID) primary key, `shop_domain` unique, `shop_name`, `scopes`, `status` (`live`,
  `needs_reauth`, `uninstalled`), `access_sealed`, `refresh_sealed`, `seal_key_id`,
  `access_expires_at`, `refresh_expires_at`, `claim_failures`, `claim_locked_until`,
  `generation` (bumped by every exchange and by uninstall), `installed_at`, `uninstalled_at`, `created_at`, `updated_at`.
  - **Sealing.** AES-256-GCM, a random 96-bit nonce per write, key from `SHOPIFY_TOKEN_SEAL_KEY`
    (32 bytes, base64; `SHOPIFY_TOKEN_SEAL_KEY_PREVIOUS` opens old rows during a rotation), the
    authenticated data is `shop_id|column|seal_key_id`, so a sealed value copied to another
    row or column fails to open. Tokens are never logged, never returned, never in an error.
  - **One at a time per store.** Every exchange and refresh for a store runs under a
    session advisory lock keyed by the verified shop domain (taken before any row exists, so two
    first opens cannot both exchange; S2 forbids a refresh and an exchange together). Token
    writes are conditional on the `generation` read under the lock, so a write that was in
    flight when an uninstall wiped the row (which bumps `generation`) changes nothing.
  - **Use.** A run reads the install, and if the access token expires within 5 minutes it
    refreshes first, under that lock. It sends `X-Shopify-Access-Token` to the Admin
    GraphQL endpoint of the pinned API version.
  - **Refresh.** `grant_type=refresh_token` at `https://<shop>/admin/oauth/access_token` with
    the client id and secret. The new pair is written in one statement before the old
    refresh token is dropped (Shopify keeps the presented token usable until the new one is
    used, so a lost response is retried with the same one). `401 invalid_request`, or an
    expired refresh token, sets `needs_reauth` and the connection `reauthorize` with reason
    `auth_error`; the next `shopify_open` (the merchant opening the app) re-runs the exchange
    and restores the install to `live`. The connection recovers too: `connections_guard`
    (C-7, C-8) is amended so a **worker** may move a **native** row from `reauthorize` with
    reason `auth_error` back to `active`, only with the exchange that just succeeded; no role
    may move a `disconnecting` or `disconnected` row, and the runtime role may not move
    any row to `active`. The same migration replaces only that one clause of the function.
  - **Pass.** The cron pass (C-9) also refreshes every live install whose refresh token has
    less than 30 days left or whose access token expired more than a day ago (a dormant store
    stays under the 90 day limit), at most the pass call cap per run.
  - **Proof.** The preview test reads the stored row's expiry fields and shows
    `refresh_expires_at` about 90 days out and `access_expires_at` about an hour out, then forces a
    refresh and shows both rotated (S1 3.1.2 evidence). Test `fetch` is injected.
- **C-23 Reading orders natively.** `run` on a `native` connection uses the Admin GraphQL API
  (S1 2.2.4), never REST. The catalog tools keep their names and outputs: `shopify_list_orders`
  and `shopify_get_order` map the GraphQL order into the REST-shaped record the existing
  projection already trims (C-6), asking only for the fields the projection keeps. The query
  never names the `customer` object: the preview store answered `ACCESS_DENIED` to
  `customer { id }` without protected customer data access (Dev Dashboard log, 2026-11-08), so
  native orders carry `customer: null` and the app requests no protected data. A `401` from Shopify (an invalid or revoked token that a refresh cannot repair) marks the
  install `needs_reauth` (C-8 `auth_error` path). A `403`, or a GraphQL `ACCESS_DENIED`, is
  `provider_permission_denied` (C-8 unchanged): reauthenticating cannot add a permission. `429` or a `THROTTLED` error is `provider_rate_limited`. Output size, schema and
  disclosure rules are C-6 and C-11 unchanged. Shopify refuses, before it runs, a query whose requested cost is over
  1,000 points (shopify.dev, GraphQL Admin API rate limits: an object costs 1, a connection 2 plus `first` times one
  node), so 50 orders with 50 line items each (about 7,950 points) never ran. `shopify_list_orders` asks for as many line
  items per order as fit (`listLineItemsPage`: 50 up to 6 orders, 30 at 10, 3 at 50); `shopify_get_order` reads one
  order with up to 50. `packages/core/test/shopify/query-cost.ts` computes the cost independently and the fake
  Shopify answers `MAX_COST_EXCEEDED` over 1,000, as Shopify does.
- **C-24 Webhooks and compliance.** One public route in the workers project:
  `POST /webhooks/shopify`.
  - Reads the raw body (capped at 256 KiB) **before** any parse, computes the base64
    HMAC-SHA256 with `SHOPIFY_CLIENT_SECRET` (the previous secret also accepted during a
    rotation), compares in constant time on equal-length buffers, and answers `401` with no
    body on any mismatch or missing header (S8). Then it requires `X-Shopify-Topic`,
    `X-Shopify-Shop-Domain` (shop regex above) and `X-Shopify-Webhook-Id`. Those headers are
    not covered by the HMAC (only the body is), so none of them is trusted alone: the parsed
    body must carry the same shop (`domain` / `myshopify_domain` for `app/uninstalled`,
    `shop_domain` and `shop_id` for the compliance topics) and a mismatch is 401. The body's
    shop is the one acted on. The dedupe id is the header; a changed id only lets an
    authenticated body run again, which is safe because every handler below is idempotent.
  - Deduplication: `shopify_webhook_events` (`webhook_id` primary key, `topic`, `shop_domain`,
    `received_at`) takes the id first; a repeat answers 200 and does nothing. Rows older than 30
    days are removed by the pass. Each handler is one short transaction, so the 200 is sent
    well inside 5 seconds. An unknown topic is 200 and ignored (never retried forever).
  - **Ordering (Shopify guarantees neither order nor delivery).** Before acting on
    `app/uninstalled` the handler checks with Shopify: it tries the stored access token (a
    refresh if needed). If the call succeeds the shop was reinstalled after the event, so the
    delayed uninstall is dropped (logged). A token that fails, or a missing token, confirms the
    uninstall. `generation` (C-22) fences the wipe against a concurrent exchange. A missed
    uninstall is healed the same way: a `shop/redact` for a shop still marked `live` runs the
    same check, and redacts when the token fails.
  - `app/uninstalled`: the install becomes `uninstalled`, both sealed tokens are nulled, the
    shop's `native` connection becomes `disconnected` with `revoke_outcome = 'revoked'`
    (Shopify already revoked the token), and `account_label` is cleared (C-7). The tenant and its
    CRM data stay: they belong to the business, not to the Shopify store. Billing follows the
    subscription state the Shopify billing runner already reads (PL-17), not this event.
  - `customers/data_request` and `customers/redact`: the hub keeps no Shopify customer data
    (C-14: no tool arguments, no output, and `customer` only as an id in a live read). The
    handler records the event, answers 200, and the privacy policy page says so. If this ever
    changes, this rule changes first.
  - `shop/redact` (48 hours after uninstall): deletes the shop's `shopify_installs` row, its
    claims and its webhook events (but not the current one), and replaces the shop's identity
    in `connections` with the terminal values `account_domain = 'redacted.invalid'`,
    `external_account_id = 'redacted'` (the columns are NOT NULL with length checks; the
    migration grants the worker `UPDATE` on those two columns and `connections_native_guard`
    allows exactly this change, on a `disconnected` native row, by the worker, and nothing else).
    The same transaction anonymises the action history of that shop's native connections: for each
    connection (matched by tenant id and connection id, never by a text search across tenants) the
    `connection.connect` and `connection.disconnect` rows in `actions` and the linked `outbox` events keep
    their row but have the shop domain, shop id and store name replaced in `payload` and `result` with the
    same placeholders (`redacted.invalid`, `redacted`; name keys become null; a client-chosen idempotency key that
    carries the domain becomes `redacted:<action id>`). The store name is matched in name fields only, never in
    machine fields or free text. The shop's lease row in `shopify_locks` is deleted too. The worker's `service_role`
    already holds UPDATE on both tables, so no migration is needed. Tenant B's actions for another shop stay
    untouched (tests). The business name (`tenants.name`, first taken from the shop name) and the owner's
    email belong to the business and stay.
    A shop that proves to be live (the check above) is not redacted.
  - **Where shop identity is retained (listed, so redaction is not a guess).** Cleared:
    `shopify_installs`, `shopify_claims`, `shopify_webhook_events`, the `connections`
    identity columns and the shop identity inside that shop's `actions` and `outbox` rows. Kept on purpose: `tenant_plans.shopify_shop_id` and `shopify_shop_domain`
    and the shop GID inside Shopify subscription records, because they are billing records the
    business must keep for tax and dispute purposes and they hold no customer data (the shop is
    a business). The listing's privacy text says this. The connection history keeps no store
    identity (status and codes only).
  - Logs carry topic, shop domain, our code and timing. Never a body, a header or a token.
- **C-25 Compliance matrix (the proof file).** `SHOPIFY-LISTING-READY.md` lists every
  S1 item that applies as Met or Open with evidence: 1.1.1 (page works with cookies blocked:
  headless run with third-party cookies off), 1.2.1 (Track J), 2.2.1 to 2.2.4 (Admin GraphQL
  use, embedded page, App Bridge first script), 2.3.1 (no typed shop in the install flow; the
  hub card), 2.3.2 and 2.3.4 (authenticate before UI; reinstall revives), 3.1.1 (TLS on
  every host), 3.1.2 (C-22 proof), 3.2 (scope `read_orders` only), S6 (CSP header per shop),
  S7 and S8 (HMAC 401 on bad signature, 200 on good, dedupe, all three compliance topics and the
  uninstall hook). Reviewer access (4.5.4, 4.5.5): the reviewer installs on their own store and reaches the hub
  by "Open ZS Hub" with no mailbox, code or SSO (C-21); the listing draft carries these
  instructions. The onboarding screencast (4.5.3) is recorded from the dev store run and kept
  with the proof, or marked Open with the reason if the recording cannot be made. Items that
  need money or a human at Shopify (the registration fee, the listing text review) stay Open
  and named.
- **C-26 Migration and wiring (revision 4, built).** One forward migration: creates
  `shopify_installs`, `shopify_claims` and `shopify_webhook_events` (grants as C-22, C-21 and
  C-24; claims are a tenant table with the standard test generator); relaxes
  `connections_tier` to `composio` or `native` and the `composio_account_id` requirement to
  `composio` rows only; limits the take-attempt trigger to `composio` rows (a native row is
  inserted only by the worker, and the new `connections_native_guard` refuses it to every
  other role); replaces `connections_guard` for the native recovery clause of C-22; adds the partial unique index of C-21. Contract schemas, the seven
  operations, the worker env (`SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`,
  `SHOPIFY_CLIENT_SECRET_PREVIOUS`, `SHOPIFY_TOKEN_SEAL_KEY`, `SHOPIFY_TOKEN_SEAL_KEY_PREVIOUS`,
  `SHOPIFY_API_VERSION`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `HUB_SIGN_IN_URL`), the
  dashboard env (`SHOPIFY_CLIENT_ID`, read at request time) and the `shopify/*/shopify.app.toml` files are part of the
  change. Config parsing is strict: a partial Shopify config disables the native tier
  and fails the worker's start-up check with a named variable, never half-starts it.
- **C-27 Tests (revision 4).** An in-process fake Shopify (token endpoint with exchange,
  refresh and failure modes; GraphQL; signed ID tokens and webhooks). Cases: ID token
  forgery (wrong alg, `none`, wrong `aud`, `exp`, `nbf`, host mismatch); exchange sends
  `expiring=1`; sealed columns do not open on another row; refresh rotation, lost response,
  concurrent refresh and exchange (lease), `invalid_request`; create-hub for owner and for a
  non-owner, `email_has_hub`; claim lifecycle, wrong-code lockout, leaked-code cannot bind
  without owner confirm, expiry, one open claim; the two-tenant denial and concurrent-binding
  cases above; billing provider is `shopify` after each bind; webhook HMAC good and bad
  (401), repeats, all topics, uninstall wipes tokens, redact removes the shop rows, a live
  shop is not redacted; CSP value per shop and `'none'` for a bad shop; the page sets no cookie.

- **C-28 IP allowlist for the Admin API (added 2026-11-07).** Shopify requires an IP allowlist
  on every public app: bulk operations are blocked from 2026-11-12, and apps without one are
  delisted and blocked from new installs from 2026-11-20
  (https://shopify.dev/docs/apps/build/dev-dashboard/ip-allowlist). The workers project is the
  only caller of the Admin API with app tokens, and Vercel functions have no fixed address, so
  the allowlist names the hosting provider's ASN with the countries the functions run in. It is
  set per app in the Dev Dashboard (no CLI or toml field), tested against recent traffic, then
  enforced. A 403 from the shop probe still counts as "live" (a missing scope also gives 403),
  so a misconfigured allowlist never uninstalls anything; the E2E run proves a call from
  outside the allowlist fails with 403.

- **C-29 Plan state and plan selection on the embedded page (added 2026-11-07; Shopify
  requirement 1.2.2, Managed Pricing).** A merchant without an active subscription must reach
  Shopify's plan selection page.
  - `open` (C-21) adds `plan`, read by the worker from `tenant_plans` by `shopify_shop_id`
    (what the billing runner stored, plans.md PL-18; no Shopify call, no `customer` object):
    `{state:"active", name}` for status `active` or `past_due`, `{state:"trial", name}` for
    `trialing`, else `{state:"none"}`. It is read in the same SQL statement as the link (one
    snapshot, so a disconnect cannot land between the two reads) and is
    `none` unless the shop has a live native connection (`active` or `reauthorize`): the hub
    tracks a shop's plan only from the link on (plans.md PL-17, PL-18), so a plan chosen before
    the hub exists is not seen, and a disconnected or uninstalled shop shows none. `plan` may be
    missing (an older worker during a deploy); that reads as no plan. `name` is the PL-1
    catalog name (Solo, Studio, Pro). The API route adds `planUrl`:
    `https://admin.shopify.com/store/<store>/charges/<SHOPIFY_BILLING_APP_HANDLE>/pricing_plans`
    (plans.md PL-15, PL-19), or null when the handle is unset. The handle is config, never code.
  - A plan is chosen after the hub exists. A shop with no hub (link `none`) sees no plan block
    at all: no plan, no **Choose a plan**, no confirming state, even after the welcome
    redirect. Once the page has seen the shop without a hub, the welcome link is void for the
    rest of that page (an `already_linked` answer to **Create my ZS Hub** included). The screen
    shown right after **Create my ZS Hub** reads `open` again and then shows **Choose a plan**
    next to the hub link; **Open ZS Hub** clicked meanwhile does not drop it. If that read fails
    the block says so with **Try again** (or **Reload** for an expired session), and if it
    finds the shop unlinked again the page shows the unlinked screen.
  - For a linked shop the page shows the plan name (with "free trial" for a trial). With no plan it shows
    **Choose a plan**, a link to `planUrl` with `target="_top"` so it leaves the admin iframe.
    With a plan it shows a secondary **Change plan** link to the same URL. With `planUrl` null
    (or not a `https://admin.shopify.com/store/` address) it shows no plan link.
  - Welcome link: the relative path `/?plan=welcome` on all five Managed Pricing plans, so
    Shopify opens the app at `/shopify/app?plan=welcome` and appends `plan_handle`, `shop`,
    `host` and `embedded`. The page reads `plan=welcome` from the query string whatever else is
    there. For a linked shop with no plan yet it shows "Confirming your plan..." and reads
    `open` every 30 seconds until an absolute deadline ten minutes after load (the billing
    runner runs every 5 minutes), then shows **Choose a plan**. The deadline is taken when the
    script starts and a timer of its own ends the confirming state, so a slow or hung read, or
    a first read that failed, does not stretch it. One read at a time. A failed read (busy,
    429, 5xx, network) keeps the last good answer and tries again, no sooner than `Retry-After`
    after a 429. An `invalid_token` read stops polling and shows the **Reload** prompt. The
    poll skips its read while the tab is hidden or an action (**Open ZS Hub**) runs, and goes
    on when it ends. With a plan already active (a **Change plan** return) the page shows that
    plan and does not poll. A poll answer changes only the plan block, and only when the state
    changed: it never redraws the screen or moves focus. A read that comes back after the
    merchant has moved to another screen is dropped. At most 21 reads per page in ten minutes,
    so the 240 per 10 minutes per-address budget (C-21) holds about eleven welcome pages
    behind one address.
  - Footer, outside the script's reach: Privacy `https://zerosumsolutions.com/privacy#shopify`,
    Terms `https://zerosumsolutions.com/terms#shopify` and Support `mailto:devin@zerosumsolutions.com`.
  - Unchanged: per-shop frame-ancestors (C-20), no cookie, bearer token per call, no token or
    customer data in logs.
  - Deploy order for this change: the API first, then the workers. The API on `main` before
    C-29 parsed the worker's `open` answer with a strict object and answered 503 to a `plan`
    field it did not know, so a workers-first deploy would break `open` until the API caught up.
    The new API accepts an answer without `plan` (old worker) and drops a top-level field it
    does not know (newer worker), so from this change on either order is safe; the fields it
    reads stay strict.
  - Tests: `apps/dashboard/test/shopify-embedded.test.ts` (no plan, plan, trial, handle unset,
    confirming, deadline, polling, footer), `packages/core/test/shopify/native-worker.test.ts` (plan states),
    `apps/api/test/shopify-native-api.test.ts` (`planUrl`).

- **C-30 Recent orders on the embedded page (added 2026-11-07; Shopify app review must see the
  app read orders).** A linked store's embedded page shows its 10 most recent orders from the
  last 60 days, newest first, and a one-line summary: "N orders in the last 60 days, total
  <money>", computed over the orders returned (up to 50 fetched). The view is read-only and has
  no customer fields.
  - Worker operation `orders` (`POST /internal/shopify/orders`, body `{idToken}`) verifies the ID
    token (`invalid_token`), then reads the store's install and link from the database. It answers
    only for a store with a live install whose connection is `active` or `reauthorize`; any other
    store (never opened, no hub, disconnected, uninstalled) gets `not_linked` and no Shopify call
    is made. Only then does it get the access token, once (refresh under the `shopify_locks`
    lease; `busy`, `unavailable` as in `open`). It never exchanges a token: the page calls `open`
    first, which does. The install and its link are read in one statement; an install that is
    gone by the time the token is read is `not_linked` too. The route passes the caller's abort
    signal (B-6) to the Shopify calls. It reads with `recentOrdersQuery` and `listOrdersSearch`
    (window = injected clock now minus 60 days, status any, first 50): name, created time, the
    two statuses, currency and total, and nothing else (no line items, whose custom titles can
    carry a buyer's text, no IDs, no `customer` object; 152 requested points). After Shopify
    answers it reads the link again: a disconnect or uninstall that committed meanwhile gets
    `not_linked`, not the orders. A Shopify failure answers `unavailable`; a 401 marks the
    current install as needing reauth, as in C-22. Each order is checked before anything is
    repaired: the created time must be ISO 8601 with an offset (a loose date such as `March 5`
    or `2026-02-30` is skipped, not normalised) and inside the window; statuses are only
    lowercased; then `shopifyRecentOrderSchema` decides. An order that does not fit (name,
    time, a status over 60 characters or not a string, total or currency) is skipped, never
    cut to fit.
  - Response (`shopifyOrdersResponseSchema`): `{outcome:"ok", orders:[{name, createdAt,
    displayFinancialStatus, displayFulfillmentStatus, total:{amount,currency}}] (at most 10),
    summary:{count, total:{amount,currency}|null}}`. `total` is the exact decimal sum and is null
    when no order was returned or the currencies differ. An order amount has at most 15 integer
    digits; the summary total allows 17 (50 such amounts). Strict objects: a customer field cannot
    pass the contract.
  - API route `POST /public/v1/shopify/embedded/orders` beside `open`: same bearer token, same
    `shopify-embedded` guard (240 per 10 minutes per address), same mapping (`invalid_token` is a
    401, a dead worker is `unavailable`). The dashboard proxy allows the `orders` operation and
    passes the browser's abort signal on with its 12 s deadline.
  - The address every embedded limit counts. The page calls the dashboard, and the dashboard
    calls the API server to server, so on Vercel the API's `x-vercel-forwarded-for` is the
    dashboard's own address and every merchant would share one bucket. With
    `CONNECTIONS_EMBEDDED_ADDRESS_SECRET` (32+ characters, the same value on the dashboard and
    the API project) and `DASHBOARD_TRUST_PROXY=1`, the dashboard sends the browser's address
    (the right-most `X-Forwarded-For` entry, as for sign-in) in `X-ZS-Embedded-Address` with
    `X-ZS-Embedded-Address-Signature`, a base64url HMAC-SHA256 over
    `zs-shopify-embedded-address.v1`, the address and the bearer token, so a note fits one
    short-lived token only. The API counts the note only when the signature verifies (constant
    time) and the address parses; otherwise, and whenever the secret is unset, it counts the
    address the host gives, as before. This covers `open`, `orders`, `create-hub`, `sign-in`
    and `redeem-claim`.
  - Page: after `open`, for a linked store only, it reads `orders` and shows a **Recent orders**
    table (Order, Date, Payment, Fulfillment, Total) and the summary line. The screen shown after
    the hub is made or relinked reads them too, once its `open` read confirms the link. Amounts
    are formatted from the decimal string, never through a float. Empty: "No orders in
    the last 60 days". Any failure: "Orders are not available right now". The read has a 15 s
    deadline (token and request together): at it the request is aborted and the slot shows the
    failure line. A new screen aborts the read of the old one. Amounts keep every decimal sent
    (up to 6), never fewer than the currency's own. Dates are the UTC calendar day. All values are set
    with `textContent`; the CSP and the no-cookie model are unchanged. An answer that lands
    after the page moved to another screen is dropped (the C-29 generation guard; only a new
    screen moves it, so Open ZS Hub during the read still settles the orders).
  - Tests: `packages/core/test/shopify/native-worker.test.ts` (linked, not linked with zero
    Shopify calls, 60-day window, at most 50, no customer fields, fields and cost asked for,
    skipped orders including loose dates and long statuses, out-of-window answers, largest
    total, refresh, busy, abort signal through the real Shopify call, disconnect while Shopify
    answers, two stores each seeing only their own orders), `packages/core/test/shopify/orders.test.ts`
    (query costs), `apps/api/test/shopify-native-api.test.ts` (auth, rate limit key and rule,
    signed address, mapping), `apps/dashboard/test/shopify-embedded.test.ts` (table, empty,
    error, safe rendering, exact amounts and decimals, deadline, abort on a new screen, Open ZS
    Hub mid-read, stale answer, orders after hub creation, proxy abort and signed address).


## Acceptance

- On preview and on production, an owner connects Zero Sum's test store end to end through the
  real link with deferred verification. The owner sees the shop name and `tokensWithAccess` before
  confirming. The row is `active`, and a reload of the callback answers `connected`.
- An MCP SDK client with a `connections:read` token lists the connection and its tools and
  runs `shopify_list_orders`. A token without the scope sees none of the three tools.
- Cancel and disconnect remove the Composio account at once. Disconnect ends `disconnected`,
  and runs are refused from `disconnecting` on.
- Every C-15 case passes locally and in CI against the fake.
- The API project's environment holds no `COMPOSIO_API_KEY`; the worker project's does.
- Revision 4: on the preview app and the dev store `zs-hub-test-store`, an App Store style
  install opens the embedded page, which authenticates by session token, creates or claims a
  hub, shows its status and a hub link; the stored token row shows a 90 day refresh token and
  an hour access token, a forced refresh rotates both; uninstall wipes the tokens and flips the
  connection; the three compliance webhooks and a bad HMAC behave as C-24; every C-27 case passes.

## Known limits (revision 2)

- The worker, like every worker, runs as a login that may `SET ROLE service_role`. Its
  safety rests on statements that name the tenant and the row, and on tests. A dedicated
  role for all workers is separate hardening.
- A compromised API function can still make links and run catalog reads for any tenant it
  names (C-3). The pilot accepts that; the API is the tenant authority for every other
  table too.
- Connection runs are counted in H-8 usage and logs only; there is no per-connection usage
  table or screen yet.
- Managed-auth provider quotas are partly shared with other Composio customers. A provider
  429 we did not cause still answers `provider_rate_limited`.
- `/mcp` is mounted only when the API has the Activepieces config (`deps.activepieces`), so
  for the pilot the connection tools exist only on an API that also serves Activepieces.
- Observed on preview, 2026-11-07: after consent, Composio sends the browser to our callback
  with `session_uri` only. The first design expected an account ID too and so refused every
  real connect as `attempt_changed`; C-5 now treats the account ID as optional and takes the
  account from the redemption answer.
- Composio's hosted form does not prefill the store. The link accepts `connection_data`
  (documented as "pre-fill connection fields", top level of the request, with `subdomain` and
  `shop` among the listed keys), but the form stayed empty with `shop` (run 2) and with the
  auth config's own field name `subdomain` (run 3, 2026-11-07), so the field was removed rather
  than kept dead. The owner types the store name twice; the consent step still refuses a store
  other than the one named. Two other routes exist and are not built: initiate the account
  directly with the store name (skipping the hosted form; a bigger flow change that would need
  its own callback check), or shared credentials on the auth config (one store for every user,
  which does not fit a multi-tenant app). Revisit if Composio fixes the form.
- Unconfirmed attempts are swept one hour after they expire (ten minutes after the start), so
  a Composio account that Composio itself marks `EXPIRED` earlier stays until that pass.
- C-17 stays open as monitoring only (revision 3): production is open for Zero Sum. The provider
  scopes are recorded (`read_orders`). The Shopify app has protected customer data access
  (Level 1), so `shopify_list_orders` and `shopify_get_order` return orders, and an order's
  customer comes back as an id with null name and email (production run P1, 2026-11-07;
  Level 2 would add them). The uninstall on disconnect was seen to remove the app from the
  test store on preview and on production.
- The uninstall's success check reads Composio's relayed provider answer
  (`data.data.appUninstall.userErrors`). Its exact relayed shape is taken from Composio's
  reference and matched the live call in run 4 (2026-11-07); a different shape fails closed as
  `revoke_failed`, never as a false success.
- `pnpm connections:check-catalog` (owner-run, `zsvault run --env COMPOSIO_API_KEY=<id>`)
  reads `GET /tools/<slug>` for each pinned slug and checks the toolkit, the deprecation flag
  and the version. That route lists only the most recent versions, so a pin missing from the
  list is asked for with `?toolkit_versions=<pin>`. The route and its answer shape were
  confirmed against the live registry on 2026-11-07, and the catalog was pinned to live,
  read-only tools then (C-17).

## What the Mac sets

- Composio dashboard, preview project: a Shopify auth config with read-only scopes and the
  exact `CONNECTIONS_CALLBACK_URL`; deferred verification on; the shortest log retention; a
  spend cap; a scoped key (C-2, with Proxy Execute enabled for the uninstall in C-13), into ZS Vault as `zs_business_preview_composio_key`. The
  existing vault entry `composio` is not this key.
- Composio dashboard, production project `zs_business_prod` (`pr_4B7pP8iJofwR`): the same, with
  auth config `ac_CFEhsZ6nbqs0` (the app `ZS Business Connections`, client id
  `adc380d0312483cd9ab82a09d9f0e267`, `read_orders` only), the OAuth user verification URL
  `https://app.zerosumsolutions.com/api/connections/callback`, Zero Data Retention on, and the
  key `zs-business-prod-worker` in ZS Vault as `zs_business_prod_composio_key`. Other vault
  entries: `zs_business_prod_composio_project_id`,
  `zs_business_prod_composio_shopify_auth_config_id`, `shopify_zsbusiness_prod_client_id`,
  `shopify_zsbusiness_prod_client_secret`, `zs_business_prod_connections_internal_secret` and
  `zs_business_prod_connections_state_secret`.
- Production env, target production, type encrypted, names as in the lists below. Worker:
  `CONNECTIONS_ENV=production`, `CONNECTIONS_CALLBACK_URL=https://app.zerosumsolutions.com/api/connections/callback`,
  `CONNECTIONS_DATABASE_URL` (the `postgres` login of project `ubzyxrflvxymikpijnto` on the
  session pooler, port 5432, no query string), `CONNECTIONS_CRON_SCHEDULE=*/5 * * * *`. API:
  `CONNECTIONS_WORKER_URL=https://zs-business-workers.vercel.app`,
  `CONNECTIONS_RETURN_URL=https://app.zerosumsolutions.com/account/connections`. Then deploy the
  workers first, then the API and the dashboard, with `--prod` (the C-29 change is the
  exception: API first, then the workers; see C-29). Check with
  `zsvault run --env COMPOSIO_API_KEY=zs_business_prod_composio_key -- pnpm connections:check-catalog`
  and `GET /cron/connections` with the production `CRON_SECRET` (`ran: true`).
- Worker project (preview and production): `COMPOSIO_API_KEY`, `CONNECTIONS_ENV`, `CONNECTIONS_INTERNAL_SECRET`,
  `CONNECTIONS_INTERNAL_PREVIOUS_SECRET` (optional), `CONNECTIONS_DATABASE_URL`,
  `CONNECTIONS_SHOPIFY_AUTH_CONFIG_ID`, `CONNECTIONS_CALLBACK_URL`,
  `CONNECTIONS_CRON_SCHEDULE`.
- API project: `CONNECTIONS_WORKER_URL`, `CONNECTIONS_ENV`, `CONNECTIONS_INTERNAL_SECRET`,
  `CONNECTIONS_INTERNAL_PREVIOUS_SECRET` (optional), `CONNECTIONS_STATE_SECRET`,
  `CONNECTIONS_STATE_PREVIOUS_SECRET` (optional), `CONNECTIONS_RETURN_URL`. The four secrets,
  previous ones included, must all differ; the API refuses to start otherwise.
- Dashboard project: nothing new beyond its existing API address.
