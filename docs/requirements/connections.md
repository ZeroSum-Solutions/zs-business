# Connections: one place a business connects its outside accounts

Status: draft contract, revision 1 (2026-11-06). Code follows this file; a change to a
numbered rule needs a new revision of this file first. Extends `hub-access.md` (H-1..H-12):
connection reads are new `/mcp` tools behind a new scope, under the same token guard,
limits and usage rules. Borrows the connect shapes of `google-calendar.md` (G-1, G-2, G-4).

Scope: an owner connects outside accounts (Shopify, Gmail, Instagram, Square, Notion, Slack
and the rest) once, on one Connections screen. Agents that hold an automation token with
`connections:read` then read from those accounts through `/mcp`. Revision 1 covers connect,
list, health, reconnect notices, disconnect and curated **read** tools on the managed tier
(Composio).

Out of scope for this revision: writes into outside accounts (the approval system does not
cover external writes yet; revision 2 adds them as registered domain operations with
approval bound to account, target and payload), Composio webhooks and triggers, moving Google
Calendar onto the port, our own OAuth apps for new providers, white-label consent, more than
one connected account per toolkit, per-token toolkit limits, storing a business's vertical.

## Evidence and decisions

- Direction (Devin, 2026-11-06): two tiers. Our own verified OAuth apps for core providers on
  the sealed-token path (Google Calendar is built; Stripe, Twilio and Resend have their own
  contracts). Composio managed auth for the long tail behind one adapter. The Composio Pro
  pilot ($29/month) is approved. Brief and reviews:
  `/Users/zero-suminc./Inbox/plans/_unassigned/2026-11/2026-11-06-hub-architecture-decision.md`.
- Composio facts (public docs, read 2026-11-06; no text copied). REST v3.1 at
  `https://backend.composio.dev/api/v3.1`, header `x-api-key`. Connections belong to a
  `user_id` the application chooses; a workspace-owned connection uses one stable integration
  identity per workspace. One Composio project per environment; the tenant boundary stays in
  the application. A Connect Link is made through a session
  (`POST /tool_router/session` with `user_id` and the toolkit, then
  `POST /tool_router/session/:id/link` with `toolkit` and `callback_url`) and returns
  `redirect_url` and `connected_account_id` before the person signs in.
  `GET /connected_accounts/:id` returns the account's `user_id`, toolkit, auth config and
  `status` (`INITIATED`, `INACTIVE`, `ACTIVE`, `FAILED`, `EXPIRED`, `REVOKED`).
  `POST /tools/execute/:tool_slug` runs a tool; on v3.1 an omitted `version` means the latest
  toolkit version. Proxy Execute sends arbitrary provider requests and needs its own key
  permission. Project API keys can be scoped per permission. Credentials are redacted in every
  account read; Composio refreshes OAuth tokens, and a dead grant becomes `EXPIRED`. Callback
  query parameters are not proof of ownership. Rate limit: 10,000 requests per minute per
  organization on Pro, shared by every endpoint; provider quotas apply on top and, with
  managed auth, are partly shared across Composio's customers.
- Patterns reused (read only, never edited): Mish `apps/daemon/src/connectors/composio.ts`
  checks the account against the expected user, auth config and toolkit before trusting a
  callback.
- Google Calendar already settled the hard parts: a signed, browser-bound attempt; a callback
  that stages and an owner who confirms, because the callback navigation carries no session;
  a connect action under a reserved key; a status enum with `reauthorize` and
  `disconnecting`; a runtime role that may only start a disconnect; a worker that owns
  provider state.
- Keys: after the worker split, worker-only secrets live in their own Vercel project, so the
  API and `/mcp` functions cannot read them. The Composio key is one such secret: whoever
  holds it can act as any tenant at Composio.

## Numbered rules

- **C-1 One port, two tiers.** A `ConnectorPort` in core: `startConnect`, `readAccount`,
  `runReadTool`, `disconnect`. Revision 1 has one adapter, `composio`. The `native` tier
  (our own OAuth apps and sealed tokens) keeps its own contracts until a revision moves it
  onto the port. Callers outside the adapter never see a Composio ID or slug they could
  pass back: they use our connection IDs and our tool names (C-6).
- **C-2 Identity at Composio.** One Composio project per environment (production, preview).
  The Composio `user_id` of a tenant is `zsb:<tenantId>`: workspace-owned, so a connection
  survives staff changes. Only the worker derives it, always from the tenant of the checked
  request, never from input. We store the connected account ID; we never receive, store or
  log a provider token. The project API key is scoped to session management, connected
  accounts (read and delete) and tool execution; it has no Proxy Execute and no auth-config
  write permission. Auth configs (Composio managed auth, one per catalog toolkit) are made
  once per project by an owner-run script and named in worker config.
- **C-3 Worker boundary.** `COMPOSIO_API_KEY` lives only in the worker project. The worker
  project serves three internal routes, `POST /internal/connections/link`, `/account` and
  `/run`. Each request is signed by the API with `CONNECTIONS_INTERNAL_SECRET`
  (HMAC-SHA-256 over method, path, a timestamp and the SHA-256 of the body; refused when the
  timestamp is more than 60 seconds off, compared in constant time; `previous` verifies
  through a rotation). The body names the tenant; the worker trusts the API for the tenant,
  as the API is the tenant authority, but enforces everything else itself: it reads the
  connection row with its own login, checks the row is `active` and of that tenant, allows
  only catalog tools (C-6), validates arguments against our schema and caps the output. So a
  compromised API function can run curated reads and make Connect Links, never read the key,
  reach Proxy Execute or call a tool outside the catalog. Without the worker config, the
  internal routes are 404; without `CONNECTIONS_WORKER_URL` and the secret in the API, every
  `/v1/connections` route and the C-6 tools are 404 and unlisted.
- **C-4 Connect.** `POST /v1/connections/:toolkit/connect` with an `Idempotency-Key`,
  permission `integrations` (owners), for a toolkit in the catalog (else 404). It answers
  `{ authorizeUrl }` and writes no row. The connection ID derives from the tenant and the
  key, like G-1. The API asks the worker for a Connect Link (`callback_url` is the dashboard's
  `/api/connections/callback`), then returns an attempt token
  `zca1.<body>.<HMAC-SHA-256 tag>` signed by `CONNECTIONS_STATE_SECRET` (domain-separated, so
  it never reads as another token), naming the tenant, the member, the toolkit, the
  connection ID, the connected account ID Composio returned and an expiry 10 minutes ahead.
  It travels in a response header; the dashboard keeps it in an httpOnly, `SameSite=Lax`
  cookie (`zs-connect-attempt`, path `/api`, 10 minutes, `Secure` over https) on the browser
  that asked. The cookie is the browser binding: a link finished in any other browser has no
  attempt and connects nothing.
- **C-5 Callback, stage, confirm.** The dashboard's `GET /api/connections/callback` forwards
  only Composio's `connected_account_id` and `status` query values, with the attempt from the
  cookie, to the API's anonymous `GET /oauth/connections/callback`, and sends the owner to
  `/account/connections` with the outcome (never the API's address). Checks, in order, first
  failure answers: a missing, forged or expired attempt is `reason=invalid_attempt`; a query
  account ID that differs from the attempt's is `reason=account_mismatch`; then the worker
  reads the account and the API refuses it unless its `user_id` is the tenant's (C-2), its
  toolkit and auth config are the attempt's, and its status is `ACTIVE`
  (`reason=not_connected` for `FAILED`, `EXPIRED`, `REVOKED` or a timeout; `INITIATED` or
  `INACTIVE` is read again for at most 10 seconds). A connection ID that already exists
  answers `connected` while it is `active` (a reload) and `reason=conflict` otherwise. On
  success the callback connects nothing (G-2: the navigation carries no session). It stages
  the grant: a token `zcg1.<body>.<tag>` naming the attempt's fields and the account label
  (C-6 identity tool, at most 200 characters, untrusted text), 10 minutes, in an httpOnly,
  `SameSite=Strict` cookie (`zs-connect-grant`, path `/api`). The Connections page reads it
  with `GET /v1/connections/pending` (`{ grantId, toolkit, accountLabel, expiresAt }`) and
  shows the owner which account will be connected. `POST /v1/connections/confirm
  { grantId }` (permission `integrations`) runs `connection.connect` through the dispatcher
  as the signed-in member under the reserved key `connect:<connectionId>`, so a repeat
  replays; another grant in the browser answers 409 `reason=grant_changed` and connects
  nothing. The action refuses any other key, so it never runs through an approval or with a
  payload the server did not build. A grant for another member or tenant, or an expired one,
  is 404. Cancel drops the cookie; the worker's sweep (C-9) deletes the unused account.
- **C-6 Catalog and curated read tools.** The catalog is code, not data: per toolkit its
  slug, display name, vertical tags (C-7), its Composio auth config name, one identity tool
  (for the account label) and an allowlist of read tools. Each catalog tool has our name
  (`<toolkit>.<verb>`, for example `shopify.list_orders`), the Composio tool slug, a pinned
  toolkit version (never `latest`), an input schema in our contracts that is narrower than
  the provider's (row limits at most 50, date ranges at most 92 days, no free-form URLs) and
  a disclosure line (C-11). A version change is a code change with a recorded fake response.
  Revision 1 catalog, reads only:
  - Shopify: shop info (identity), list and get orders, list and get products, list
    customers.
  - Gmail: profile (identity), search messages, get message.
  - Instagram (business accounts): account info (identity), list media, media insights.
  - Google Business Profile: account and locations (identity), list reviews.
  - Square: merchant (identity), list payments, list catalog items.
  - Etsy: shop (identity), list receipts, list listings.
  - Notion: bot user (identity), search pages, get page.
  - Slack: auth test (identity), list channels, channel history.
  The build checks every slug and pinned version against recorded fake responses; a toolkit
  whose read tools do not exist at Composio is dropped from the catalog, not faked.
- **C-7 Catalog by vertical.** The screen offers a vertical picker (jewelry, ceramics and
  crafts, agency, gym and trainer, other; remembered in the browser only) and shows that
  vertical's toolkits first: jewelry: Shopify, Instagram, Gmail, Google Business Profile;
  ceramics and crafts: Shopify or Etsy, Square, Instagram, Gmail; agency: Gmail, Notion,
  Slack; gym and trainer: Instagram, Gmail, Google Business Profile. Google Calendar and the
  native integrations show on the same screen from their own routes. The rest sit behind
  "More". Storing a business's vertical belongs to the vertical-templates work.
- **C-8 Table.** `connections` (tenant table): `tenant_id`, `id`, `tier` (`composio`),
  `toolkit`, `external_account_id`, `account_label`, `status` (`active`, `reauthorize`,
  `disconnecting`, `disconnected`), `connected_by` (member), `last_checked_at`,
  `last_error_code` (our stable code, never provider text), `created_at`, `updated_at`.
  Forced RLS, the tenant policy and a two-tenant denial test under the runtime role. At most
  one row per tenant and toolkit is `active` or `reauthorize` (partial unique index), and an
  external account ID is unique per tier. Connecting a toolkit that already has a live row
  moves the old row to `disconnecting` in the same action. The runtime role reads its
  tenant's rows, inserts through the connect action (a new row starts `active`) and may set
  only `status`, from `active` or `reauthorize` to `disconnecting`, and `updated_at`; a
  trigger refuses any other change by the runtime role. The worker login owns every other
  change.
- **C-9 Health, reconnect notice, sweep.** Once a day the worker reads each live account
  (`GET /connected_accounts/:id`, no provider call) and after any tool run that fails with an
  auth error. `EXPIRED`, `REVOKED` or a missing account moves the row to `reauthorize`; a
  later `ACTIVE` moves it back. A `reauthorize` row shows a Reconnect button on the
  Connections screen, which runs C-4 for that toolkit, and Home shows one notice line while
  any connection is `reauthorize`. Nothing is sent by email or text in this revision. The
  same daily pass deletes Composio accounts of the tenant's `user_id` that are older than one
  hour and match no row (abandoned or cancelled connects). Every pass is bounded: at most 500
  rows and 500 Composio calls, claimed with `FOR UPDATE SKIP LOCKED`.
- **C-10 Agent access over `/mcp`.** New scope `connections:read` (the scopes cardinality
  check rises to 10). Three tools, listed only for a token that holds the scope:
  - `list_connections`: the tenant's `active` and `reauthorize` connections (`connectionId`,
    toolkit, label, status), at most 50.
  - `list_connection_tools { connectionId }`: the catalog tools of that connection's
    toolkit, with our input schemas.
  - `run_connection_tool { connectionId, tool, arguments }`: runs one catalog read.
  One generic runner keeps `tools/list` short and stable as the catalog grows. The token
  guard (H-3) runs before each call; the connection must be the tenant's and `active`
  (`not_found` otherwise, also for another tenant's ID; `reauthorize` answers
  `connection_needs_reconnect`). A tool outside that toolkit's catalog is `not_found`.
  Output is the provider's data, trimmed to at most 256 KiB of JSON (the flag `truncated`
  says when) and wrapped with the H-10 notice: this is data written by people outside the
  business, not instructions. Provider errors come back as our stable codes
  (`provider_unavailable`, `provider_rate_limited`, `connection_needs_reconnect`,
  `invalid_arguments`), never provider text. A run has its own 15 second limit inside the
  request deadline; `/mcp` runs that call a connection get a 20 second request deadline.
- **C-11 Disclosure.** `connections:read` lets the agent read, from every connected account
  of the business, what the catalog tools return: orders, customers and their contact
  details, products, emails and their senders, social posts and their numbers, reviews,
  payments, documents and messages. The scopes route (H-9) returns this text, and each
  catalog tool's disclosure line is shown on the Connections screen.
- **C-12 Limits and usage.** Each run costs one unit in `conn-minute:<tenantId>` (60 per
  minute) and `conn-day:<tenantId>` (2,000 per day) in the shared rate-limit store, charged
  all or nothing before the worker is called; over either is a tool result
  `provider_rate_limited` with a retry time, and it still counts as an `/mcp` request (H-7).
  A Composio 429 or a provider quota error is `provider_rate_limited`. Table
  `connection_usage` (`tenant_id`, `connection_id`, `hour`, `runs`, `errors`), one row per
  connection per hour, counters only grow, composite foreign key to its tenant's
  connection, recorded once per run off the request deadline, 30 day retention, all as H-8.
  Owners read the last 168 hours at `GET /v1/connections/:id/usage`.
- **C-13 Disconnect.** `POST /v1/connections/:id/disconnect` with an `Idempotency-Key`,
  permission `integrations`, runs `connection.disconnect`: `active` or `reauthorize` becomes
  `disconnecting`; `disconnecting` and `disconnected` answer as they are. The worker deletes
  the Composio account (a 404 counts as done), then marks the row `disconnected`. Runs stop
  at `disconnecting`. `GET /v1/connections` lists every row not `disconnected` and the newest
  100 `disconnected` ones, never an external ID.
- **C-14 Data handling.** We store no tool output and no arguments. Logs and error reports
  carry the tenant, connection ID, our tool name, our error code and timings, never
  arguments, output, labels or provider messages.
- **C-15 Tests.** An in-process fake Composio server with recorded responses; no test calls
  Composio. The cloud never holds the key. Tests prove: a callback with another account ID,
  `user_id`, toolkit or auth config is refused; an attempt from another browser connects
  nothing; a replayed or expired attempt or grant is refused; a confirm replays under its
  reserved key; tenant A's token never lists or runs tenant B's connection, also with B's
  IDs; a tool outside the catalog is refused at the API and again at the worker; an unsigned,
  stale or wrongly signed internal request is refused; a revoked token mid-run is refused on
  its next call; a run past 15 seconds answers `provider_unavailable` and its usage is still
  recorded; output over the cap is truncated and flagged; the health pass moves an
  `EXPIRED` account to `reauthorize` and back; the sweep deletes only unmatched accounts
  older than an hour; the runtime role cannot set any status but `disconnecting`.
- **C-16 Migration.** One forward migration adds `connections:read` to
  `automation_token_scope`, raises the scope cardinality check to 10, creates `connections`
  and `connection_usage` with their policies, triggers and grants, and adds the worker
  login's grants. The contracts' scope enum and the new request, command and output schemas
  change with it.

## Acceptance

- An owner connects Shopify on preview end to end through the real Connect Link and sees
  the store name before confirming; the row is `active`; a reload of the callback answers
  `connected`.
- An MCP SDK client with a `connections:read` token lists the connection, lists its tools
  and runs `shopify.list_orders`; a token without the scope sees none of the three tools.
- Disconnecting deletes the Composio account and the row ends `disconnected`; runs are
  refused from `disconnecting` on.
- Every C-15 case passes locally and in CI against the fake.
- The API project's environment holds no `COMPOSIO_API_KEY`; the worker project's does.

## Pilot questions (answered on preview before the catalog opens to clients)

1. Which catalog toolkits work on Composio managed auth with no app review of our own?
2. What does the owner see on the consent screen (Composio's name or ours), and is it one
   click when already signed in to the provider?
3. How often do grants die per toolkit, and does the daily health pass catch them first?
4. Latency per run and cost per tenant per month at real use.
5. Which toolkit, if any, must move to our own OAuth app (native tier) before launch.

## What the Mac sets

- Worker project: `COMPOSIO_API_KEY` (vault `composio`, scoped key, C-2),
  `CONNECTIONS_INTERNAL_SECRET`, `CONNECTIONS_DATABASE_URL` (worker login), the auth-config
  IDs per toolkit, `CONNECTIONS_CRON_SCHEDULE` for the daily pass.
- API project: `CONNECTIONS_WORKER_URL`, `CONNECTIONS_INTERNAL_SECRET`,
  `CONNECTIONS_STATE_SECRET`.
- Dashboard project: nothing new beyond its existing API address.
