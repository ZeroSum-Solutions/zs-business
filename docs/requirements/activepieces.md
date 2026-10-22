# M5: Activepieces automations

Status: draft contract for M5, provider 5 of 5 (2026-10-20), revision 3 (hub review r1: W-2, W-4, W-7, W-8; audit 2026-10-22: W-7, W-8). Code follows this file;
a change to a numbered rule needs a new revision of this file first.

Scope: let an owner connect Activepieces flows to their business in two directions. Outbound,
signed webhooks tell a flow when something happens (a new lead, a booking, a won deal, a
message). Inbound, a flow holding a scoped token may propose an action, which waits as an M3b
approval until an owner decides (`approvals.md`). A flow never acts on its own. Code and tests
only: the cloud holds no key and never calls Activepieces. Tests talk to an in-process fake
catch-webhook server on 127.0.0.1. The Mac sets the variables in W-14 when this ships.

## Evidence and decisions

- Plan (approved 2026-10-18): M5 providers one at a time; Activepieces last.
- Activepieces behaviour, from its public docs and in our own words: a flow can start from a
  "catch webhook" trigger at a per-flow URL (`…/api/v1/webhooks/<flow id>`) that accepts any
  JSON POST and answers 2xx once the event is queued. A flow can call any HTTP API with a
  header it holds as a connection secret. No Activepieces code is used or copied.
- Signing follows Standard Webhooks, the scheme Resend already uses here (`resend.md`), so one
  verifier checks both and a flow can verify with any off-the-shelf library: headers
  `webhook-id`, `webhook-timestamp`, `webhook-signature`; the signature is
  `v1,<base64 HMAC-SHA-256 over "<id>.<timestamp>.<raw body>">` keyed with the base64 part of
  the endpoint's `whsec_` secret; several entries are separated by spaces.
- Secrets are derived, not stored. Each endpoint secret and each token is an HMAC of the server
  key with the tenant and row IDs, so a database dump holds nothing a caller could use, and the
  server key is the one thing the Mac keeps secret.
- Business events come from committed outbox rows, read by a worker under the service role
  (`delivery.md` D-10). Producers do not change: the dispatcher's existing events carry what
  we need.
- Delivery is at least once. A receiver sees the same `webhook-id` and body on every attempt
  and dedupes on it. A lost reply counts as a failed attempt; there is no "uncertain" state.
- Proposals reuse M3b. The token's principal writes one pending `approvals` row for one exact
  member action. Approving it runs that action as the approving owner through the shared path
  (`approvals.md` A-7). Integration actions themselves can never be proposed or approved.

## Numbered rules

- **W-1 Who manages it.** A new `integrations` permission, held by owners only, guards every
  endpoint, delivery and token operation. Staff, other tenants and token principals get 403 or
  404. Each change is one action through the shared path, with an idempotency key.
- **W-2 Receiver URLs.** An endpoint URL is `https`, carries no user or password, and names no
  private host: no `localhost`, single-label, `.local`, `.internal`, `.localhost` or `.home.arpa` names, and
  no private, loopback, link-local, CGNAT, multicast or reserved IPv4 or IPv6 address. IPv4
  inside IPv6 is judged as IPv4 in every spelling, including the hex form `new URL` rewrites
  `[::127.0.0.1]` to (`::/96`, `::ffff:0:0/96`, `::ffff:0:0:0/96`, and 6to4 `2002::/16`). A name
  with a trailing dot (`localhost.`) is judged as the same name. The API checks on save; the worker checks again before every
  attempt, and its DNS lookup refuses any private answer, so a name that later resolves inside
  the network is never contacted. Redirects are never followed. Loopback over http is allowed
  only when `ACTIVEPIECES_ALLOW_LOOPBACK=on`, which needs a loopback database.
- **W-3 Events.** The catalog is `lead.created`, `booking.created`, `deal.won` and
  `message.received`. An endpoint subscribes to one or more. The body is
  `{ id, type, tenantId, occurredAt, data }`, fixed when the event is ingested, and `id`
  equals the `webhook-id` header. `id` derives from the tenant, the outbox row and the type,
  so it never changes for one event.
- **W-4 Where events come from.** A website booking request gives `lead.created` (name, email,
  phone, channel, page, possible-match flag), `booking.created` with `source: "website"`, and
  `message.received` when the visitor wrote a note. An owner's booking gives `booking.created`
  with `source: "owner"`. A deal create or stage move gives `deal.won` when the new stage's
  outcome is `won` and the stage the deal's previous write left was not. Both, and the value the
  event carries (the last one set before that write), are read from the outbox history, so a
  later reopen or price change does not alter or repeat an event.
- **W-5 Signing secrets.** Each endpoint has one `whsec_` secret per version, shown on create
  and on rotate only. Rotating moves to the next version; with a grace period (default 24 h,
  0 to 7 days) the old version keeps signing beside the new one until the grace ends.
- **W-6 Server key rotation.** With `ACTIVEPIECES_KEY_PREVIOUS_SECRET` set, every attempt
  carries signatures under both keys and tokens under either key verify. New secrets shown to
  owners use the current key, so an owner rotates each endpoint once before the old key goes.
- **W-7 Ingest.** For each enabled endpoint the worker reads outbox rows of the source types
  created since the endpoint's scan point, skipping rows it already marked for that endpoint,
  and writes one delivery per wanted event. When it has read everything, the scan point moves
  to one hour (configurable) before now, so a transaction that committed late is still found.
  A new or re-enabled endpoint starts at the time of that change and never receives older
  events: a delivery queued before it was switched off is dead-lettered (`endpoint_disabled`)
  unless an owner replays it after that change. A replay holds only for the activation it was
  made under: switched off and on again later, the endpoint drops the replay too. Each pass reads the least recently read endpoints first, so a new
  endpoint is never starved by older ones.
- **W-8 Delivery.** Workers lease due deliveries (`FOR UPDATE SKIP LOCKED`) and check the
  lease on every write, so two workers never send one attempt and a crashed holder's attempt
  is retried after its lease. Each attempt has a timeout well inside the lease. 2xx is
  delivered. 410 stops at once (`endpoint_gone`). Anything else, a timeout, a network error or
  a redirect retries with exponential backoff (from 30 s, at most 6 h) until the attempt
  cap (8), then dead-letters (`max_attempts`). A disabled endpoint or a refused URL
  dead-letters at once (`url_refused`), including a name whose DNS answer is a refused address. As for email (`approvals.md` A-8, A-10), an event whose action ran under
  a stored approval is queued and sent only while that approval stands; once it is revoked or
  expired, the next attempt dead-letters it (`approval_withdrawn`). Every attempt is recorded with its status or error code; the reply
  body is never stored.
- **W-9 Tokens.** An owner creates a named token with scopes and an optional expiry
  (1 to 365 days). The secret `zsap1_…` is shown once. It carries the tenant and token IDs and
  a tag under the server key, which the API checks before any database work; then the row
  must exist under that tenant and be neither revoked nor expired. Every failure is the same
  401. Revoking is immediate and also withdraws the token's pending proposals.
- **W-10 Scopes.** `contacts:propose`, `deals:propose`, `bookings:propose`. A scope only lets
  a token propose; nothing a token holds reads customers, approves or acts.
- **W-11 Proposal only.** A token's principal is built by the server, one actor ID per token,
  and may run exactly one action: writing a pending approval. Any other action is refused
  before it is stored.
- **W-12 What a flow may propose.** `contact.upsert` (name, email or phone; never consent
  evidence, since a flow cannot attest that a person agreed), `deal.create`,
  `deal.move_stage` and `booking.create`, each with the member request body of that action,
  an optional summary for the owner, and an expiry (default 7 days). The stored command is
  validated as the member action would validate it. A proposal is never a booking: only an
  approved booking that commits under the overlap constraint is.
- **W-13 What a flow learns.** `GET /me` names the token and its scopes. A flow reads back only
  its own proposals: standing (pending, approved, rejected, revoked, expired), whether the
  action ran, and when. Nothing about who decided or why.
- **W-14 Operating it.** Owners list each endpoint's deliveries (newest first) and replay a
  dead letter, which re-queues it with a fresh attempt budget under the same event ID. The
  worker runs only with `ACTIVEPIECES_WEBHOOK_WORKER=on`, from Vercel Cron
  (`GET /cron/activepieces`, `Bearer CRON_SECRET`, its own function) or `pnpm
  activepieces:worker`. Without `ACTIVEPIECES_KEY_SECRET` the API's routes are 404.
- **W-15 Limits.** At most 10 endpoints per tenant, 20 active tokens per tenant, 50 pending
  proposals per token, bodies of 64 KiB, and one stored event body of 64 KiB.
- **W-16 Tenancy.** Every new table has `tenant_id`, forced RLS and the tenant policy, with a
  two-tenant denial test under the runtime role. The runtime role may change only the columns
  its actions own; ingest and delivery run as the service role.

## What the Mac sets

| Where | Variable | Value |
|---|---|---|
| API | `ACTIVEPIECES_KEY_SECRET` | 32+ random characters. Unset keeps everything off. |
| API and worker | `ACTIVEPIECES_KEY_PREVIOUS_SECRET` | Only during a key rotation. |
| Worker | `ACTIVEPIECES_WEBHOOK_WORKER` | `on` to send. |
| Worker | `ACTIVEPIECES_DATABASE_URL` | The service login (may `SET ROLE service_role`), with `DATABASE_CA_CERT`. |
| Worker | `ACTIVEPIECES_KEY_SECRET` | The same key as the API. |
| Worker | `CRON_SECRET` | Shared with `/cron/delivery`. |
| Build | `ACTIVEPIECES_CRON_SCHEDULE` | For example `*/5 * * * *`. Unset, no cron. |

Optional tuning is in `apps/api/README.md`. The migration is `20261020640000_activepieces.sql`.

## Known limits

- No `booking.cancelled` event: there is no cancel action yet. It joins the catalog when one
  ships.
- `message.received` comes only from website booking notes; there is no inbound email or SMS.
- After a server key rotation, each endpoint needs one rotate so its shown secret uses the new
  key; until then both signatures go out.
- No dashboard screens yet; the routes are API only.
- `lead.created` and `message.received` send what the visitor typed to the URL the owner chose.
  That is the point of the integration, and only owners can add endpoints.
