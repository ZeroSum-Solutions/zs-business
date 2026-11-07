# Connections: one place a business connects its outside accounts

Status: draft contract, revision 2 (2026-11-06). Code follows this file; a change to a
numbered rule needs a new revision of this file first. Extends `hub-access.md` (H-1..H-12):
connection reads are new `/mcp` tools behind a new scope, under the same token guard,
limits and usage rules. Reuses the connect shapes of `google-calendar.md` (G-1, G-2, G-4).

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
Revision 2 covers connect, confirm, cancel, list, health, reconnect, disconnect and two curated
**read** tools on the managed tier (Composio), on preview only. Production and client tenants
wait for the pilot gate (end of file).

Out of scope for this revision: other toolkits (the catalog shape admits them; each needs a
revision that names its tools and passes the pilot checks), writes into outside accounts,
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
  - `POST /connected_accounts/link` (`auth_config_id`, `user_id`, `callback_url`, and for
    Shopify `connection_data.shop`) returns `redirect_url` and `connected_account_id` before
    the person signs in. The pre-issued account ID is not proof of who consented.
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
    `POST /connected_accounts/:id/revoke` asks the provider to revoke.
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
  log a provider token. The key has the areas connected accounts (read and write) and tool
  execution; no Proxy Execute, no sessions, no auth-config write. The Shopify auth config is
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
    store, all or nothing.
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
    `reason=attempt_changed` and its account is swept (C-9).
- **C-5 Callback, stage, confirm.**
  - Callback. Composio redirects to the dashboard's `GET /api/connections/callback`
    (`CONNECTIONS_CALLBACK_URL`). It forwards only `session_uri` and `connected_account_id`,
    with the attempt token in `X-Zs-Connect-Attempt` and the browser key in
    `X-Zs-Browser-Key`, to the API's anonymous `GET /oauth/connections/callback`. The API
    answers 400 when the attempt is missing, forged or expired (the dashboard shows
    `reason=invalid_attempt`); otherwise 303 to `CONNECTIONS_RETURN_URL` with
    `connection=confirm`, `connection=connected` or `connection=error&reason=…`. The
    dashboard rebuilds its own redirect to `/account/connections` from that answer (never the
    API's address), with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
  - Checks, in order, first failure answers: `browser_mismatch` when the browser key's
    SHA-256 differs from the attempt's (constant time); `attempt_changed` when the query's
    account ID differs from the attempt's; `forbidden` when the member no longer holds
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
    - redeem `session_uri` with the tenant's `user_id`. If Composio says the session is
      unknown or used (404) and an earlier callback for this attempt had presented a session,
      read the account instead: only this browser held that `session_uri`, so an account that
      is now `ACTIVE` for this `user_id` was redeemed by our earlier, lost call. On the first
      presentation a 404 is final, as are a 400 (Composio checked `user_id`) and a redemption
      that names another account: the answer is `not_connected` and `session_presented_at` is
      cleared, so no status call can verify the attempt afterwards. A 401, 403 or 410 is our key
      or project (`provider_unavailable`, reported as `key_refused`), never the used-session
      path;
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
  - Shopify, identity: shop details (numeric ID, name, `myshopify` domain).
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
  `last_error_code` (our code, cleared on recovery), `revoke_outcome` (`revoked`, `failed`,
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
  - A tool run that fails with a provider auth error moves the row to `reauthorize` with
    `reauthorize_reason = auth_error`. Such a row returns to `active` only through
    Reconnect, never because a later read says `ACTIVE`: a cached status does not prove the
    credential works.
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
  A Reconnect button shows on a `reauthorize` row. For owners, the dashboard's Home shows one
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
    `connection_needs_reconnect`, `provider_rate_limited`, `provider_unavailable`. They are
    never provider text. Composio's envelope is checked: `successful: false`, a missing
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
    and auth config are the row's. It calls `revoke` once (the outcome is kept in
    `revoke_outcome`, so a retry never revokes again; a 404 counts as revoked), then `DELETE`
    (a 404 counts as done), then marks the row `disconnected` and clears the label. An account
    that is not the tenant's, or whose read names no user, is left alone: the row ends
    `disconnected` with `account_mismatch` and the operator is told. A failed read or delete
    keeps the row `disconnecting` with `delete_failed` for the next pass. A worker that has no
    auth config for the row's toolkit cannot prove the account is the tenant's, so it calls
    nothing: the row stays `disconnecting` with `not_configured` until the config is back, and
    the operator is told.
  - A revoke that fails is recorded as `last_error_code = revoke_failed`; the delete still
    runs. The screen then tells the owner to remove the Composio app in Shopify admin. The
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
  - a callback with another account ID, `user_id`, toolkit or auth config is refused; a
    browser key mismatch is refused; a demoted member's callback is `forbidden`;
  - a lost `complete_auth` answer recovers; a used `session_uri` from another tenant never
    connects;
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
  - disconnect revokes, deletes, ends `disconnected` and clears the label;
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
- **C-17 Pilot gate.** The managed tier stays on preview, for Zero Sum's own test store, until
  all of these hold:
  - deferred verification is on for the Composio project, and a callback without
    `session_uri` connects nothing. If Composio cannot turn it on, the tier does not open,
    and this contract is revised;
  - the Shopify consent screen, the granted scopes and the one-click path are recorded;
  - revoke and delete were seen to remove the app from the test store;
  - latency, the grant failure rate over two weeks and cost per tenant per month are
    measured;
  - Devin approved C-14's retention terms for client data.
  Production then needs the production Composio project, key and auth config.

## Acceptance

- On preview, an owner connects Zero Sum's test store end to end through the real link with
  deferred verification. The owner sees the shop name and `tokensWithAccess` before
  confirming. The row is `active`, and a reload of the callback answers `connected`.
- An MCP SDK client with a `connections:read` token lists the connection and its tools and
  runs `shopify_list_orders`. A token without the scope sees none of the three tools.
- Cancel and disconnect remove the Composio account at once. Disconnect ends `disconnected`,
  and runs are refused from `disconnecting` on.
- Every C-15 case passes locally and in CI against the fake.
- The API project's environment holds no `COMPOSIO_API_KEY`; the worker project's does.

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
- C-17 stays open: the provider scopes in the catalog are placeholders until the preview
  consent screen is recorded, and the vendor gates are not passed yet.
- `pnpm connections:check-catalog` (owner-run, `zsvault run --env COMPOSIO_API_KEY=<id>`)
  reads `GET /tools/<slug>` for each pinned slug and checks the toolkit, the deprecation flag
  and the version. That route lists only the most recent versions, so a pin missing from the
  list is asked for with `?toolkit_versions=<pin>`. The route and its answer shape were
  confirmed against the live registry on 2026-11-07, and the catalog was pinned to live,
  read-only tools then (C-17).

## What the Mac sets

- Composio dashboard, preview project: a Shopify auth config with read-only scopes and the
  exact `CONNECTIONS_CALLBACK_URL`; deferred verification on; the shortest log retention; a
  spend cap; a scoped key (C-2), into ZS Vault as `zs_business_preview_composio_key`. The
  existing vault entry `composio` is not this key.
- Worker project: `COMPOSIO_API_KEY`, `CONNECTIONS_ENV`, `CONNECTIONS_INTERNAL_SECRET`,
  `CONNECTIONS_INTERNAL_PREVIOUS_SECRET` (optional), `CONNECTIONS_DATABASE_URL`,
  `CONNECTIONS_SHOPIFY_AUTH_CONFIG_ID`, `CONNECTIONS_CALLBACK_URL`,
  `CONNECTIONS_CRON_SCHEDULE`.
- API project: `CONNECTIONS_WORKER_URL`, `CONNECTIONS_ENV`, `CONNECTIONS_INTERNAL_SECRET`,
  `CONNECTIONS_INTERNAL_PREVIOUS_SECRET` (optional), `CONNECTIONS_STATE_SECRET`,
  `CONNECTIONS_STATE_PREVIOUS_SECRET` (optional), `CONNECTIONS_RETURN_URL`. The four secrets,
  previous ones included, must all differ; the API refuses to start otherwise.
- Dashboard project: nothing new beyond its existing API address.
