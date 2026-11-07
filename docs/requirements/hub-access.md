# Hub access: one agent surface for every client

Status: draft contract, revision 3 (2026-11-06; revision 3 answers the four-model audit of the
build: check order, refusals charge nothing, guarded `whoami` and proposals, one accounting
path, bounded lists, usage-table integrity, retention wiring, scopes route, notices. Revision 2
answered the Sol contract review: proposal retries, read adapter, migration, transport
statuses, quota unit, usage table, deadline, SDK acceptance, expiry, tool table,
disclosures). Code follows this file; a change
to a numbered rule needs a new revision of this file first. Extends `activepieces.md`
(W-9..W-15); where the two disagree, this file wins for tokens that hold a read scope.
Tokens that hold only propose scopes behave exactly as W-9..W-13 say.

Scope: let any agent the owner trusts (Mish, Hermes, an agent fleet, Claude, Codex, an
Activepieces flow) work with one business through one remote MCP endpoint and one kind of
token. The agent reads what its scopes allow and proposes actions; an owner decides every
proposal. Nothing here lets an agent approve, act directly, or reach another tenant.

Out of scope for this revision: external connections (Shopify, Gmail and the rest; the next
contract, `connections.md`), drafting replies, executing approved writes in other services,
dashboard screens beyond the token list, per-call billing, reduced output schemas.

## Evidence and decisions

- Direction (Devin, 2026-11-06): the business service becomes the hub every agent plugs into;
  Mish is one client among several. Brief and the Sol and Argon reviews:
  `/Users/zero-suminc./Inbox/plans/_unassigned/2026-11/2026-11-06-hub-architecture-decision.md`.
- Both reviews: agents must never hold an owner session; they need their own revocable,
  scoped credential checked on every call. The stdio MCP server (`packages/mcp`) needs a
  database URL and a member's access token, so it cannot serve remote agents.
- Automation tokens (`zsap1_`, W-9) give a tenant-bound, server-key-tagged, revocable
  credential with a proposal path (W-11, W-12). The tag binds tenant and token IDs; what a
  token may do comes from its checked row. Reusing them keeps one credential, one key and
  one proposal path (Sol contract review, 2026-11-06).
- Member reads (`createSession`) require a membership on every read and must keep doing so.
  Token reads therefore use the lower-level read functions (`packages/core/src/reads/`)
  through their own adapter, not the member session.
- MCP over Streamable HTTP, stateless: each request builds its server and transport, answers
  in JSON, keeps no session, and disposes both when the response ends.

## Numbered rules

- **H-1 One credential.** Agents use automation tokens (W-9). Expiry stays optional for
  propose-only tokens (W-9 unchanged). A token created with any read scope must have an
  expiry of 1 to 365 days; the request default is 90. Existing tokens are unchanged.
- **H-2 Read scopes.** New scopes beside the W-10 propose scopes: `contacts:read`,
  `deals:read`, `bookings:read`, `inbox:read`, `results:read`, `business:read`. A token may
  hold all nine scopes. The scopes are operation scopes, not field filters; the disclosures
  each one makes are listed under "What each read scope discloses".
- **H-3 Token guard.** Every token request that touches the database after authentication
  runs the same guard: `whoami`, `get_proposal`, every read and every proposal, on `/mcp` and
  on the W-13 routes (`/me`, `/proposals`, `/proposals/:id`). The guard runs in one tenant
  transaction under the runtime role. It takes a lock on the token row, reads the clock after
  the lock, re-checks revoked and expired, and checks the scope. A missing, revoked or expired
  token is the W-9 401; a missing scope is `TenantDenied` before any business row is read.
  Reads, `whoami` and `get_proposal` take a shared lock (they need no read scope: any live
  token passes). A proposal takes the exclusive lock (`FOR UPDATE`, so two proposals never
  deadlock by upgrading a shared lock), and takes it inside the dispatch transaction before the
  replay lookup, so a replayed proposal is refused for a revoked token exactly as a fresh one
  is. A revoke takes the exclusive lock, so it commits only after in-flight requests holding a
  lock end; every request that starts after the revoke commits is refused. `authenticate`
  reads the clock after the token row is loaded, never before. Member sessions and their
  checks do not change.
- **H-4 Writes stay proposals.** The MCP edge offers the four W-12 proposals and the W-13
  proposal read, and no other write. Every proposal tool takes a required `idempotencyKey`
  argument with the W-12 derivation: the same key and body return the same proposal; the
  same key with a different body is a conflict, on either transport. The default summary is
  one canonical text that does not depend on the transport: the same key and input sent by
  REST then by MCP gives the same proposal, not a conflict. Approving stays an owner action.
- **H-5 Remote MCP transport.** `POST /mcp`, `Authorization: Bearer zsap1_…`, stateless
  Streamable HTTP, JSON responses, no session ID issued or accepted. Without the automation
  key configured the route is 404. The checks run in this fixed order, and the first that
  fails answers:
  1. `GET` and `DELETE` are 405.
  2. The token tag check: a missing, malformed or tampered token is the W-9 401. This is pure
     CPU, with no database access, so an anonymous caller never makes us read a body.
  3. A body over 64 KiB is 413. The limit counts the bytes actually read from the stream; a
     missing or false `Content-Length` does not bypass it.
  4. The quota (H-7): over either limit is 429 with `Retry-After`. It is charged on the
     tag's tenant and token IDs before the token row is read, so a revoked or unknown token
     with a valid tag cannot cause unbounded database reads.
  5. The token row: an inactive or missing row is the W-9 401.
  6. A request that carries an `Mcp-Session-Id` header is 404 (no session exists).
  7. A body that is not JSON, a JSON-RPC batch (an array body), or JSON that is not a
     JSON-RPC request or notification is 400.

  Answered inside MCP: a tool the token's scopes do not allow is not listed, and calling it
  returns a JSON-RPC error with code -32601 (`Method not found`) and does not reveal whether
  the tool exists; a domain error (validation, not found, conflict) is a tool result with
  `isError` and the stable error code. `/mcp` runs under the same request deadline,
  disconnect cancellation and bounded database work as `/v1`. A request whose signal is
  already aborted when it arrives is cancelled at once. A lock timeout or other transient
  database error on a token path is 503 with `Retry-After`, like any database outage. CORS
  allows the `Mcp-Protocol-Version` header.

  Bounded work: every list a token can reach has a hard SQL cap, so no tool reads an
  unbounded number of rows. `list_pipelines` returns at most 200 pipelines and 2,000 stage
  rows in all; `list_resources` at most 500; `get_thread` at most its existing 50 entries
  (the output flag `olderEntries` says more exist); the owner token list at most the newest
  1,000 tokens. The page-based reads keep their page limits. For the three lists with no
  page (pipelines, resources, owner tokens) the cap is the documented behaviour: rows beyond
  it are not returned and no flag is added, because a tenant past these sizes is outside the
  product's range.
- **H-6 Tools.**

  | Tool | Needs | Input | Output |
  |---|---|---|---|
  | `whoami` | any token | none | W-13 token summary |
  | `get_proposal` | any token | `proposalId` | W-13, own proposals only |
  | `list_contacts`, `get_contact` | `contacts:read` | stdio schemas | member read outputs |
  | `list_pipelines`, `list_deals` | `deals:read` | stdio schemas | member read outputs |
  | `list_resources`, `list_bookings` | `bookings:read` | stdio schemas | member read outputs |
  | `list_threads`, `get_thread` | `inbox:read` | stdio schemas | member read outputs |
  | `home_results` | `results:read` | stdio schema | member read output |
  | `get_business` | `business:read` | none | `GET /v1/business` output |
  | `propose_contact_upsert` | `contacts:propose` | W-12 input + `idempotencyKey` | W-13 |
  | `propose_deal_create`, `propose_deal_move_stage` | `deals:propose` | W-12 input + `idempotencyKey` | W-13 |
  | `propose_booking_create` | `bookings:propose` | W-12 input + `idempotencyKey` | W-13 |

  `tools/list` shows only the rows the token's scopes allow, plus `whoami` and
  `get_proposal`. Another token of the same tenant cannot read a proposal it did not make.
- **H-7 Limits.** The counted unit is one authenticated `POST /mcp` request whose tag is
  valid, whatever it carries (initialize, list, call or notification). Each costs one unit in
  two fixed-window buckets, `mcp-minute:<tenantId>:<tokenId>` (120 per minute) and
  `mcp-hour:<tenantId>:<tokenId>` (2,000 per hour), in the shared Postgres rate-limit store
  the public intake uses. Both are charged in one all-or-nothing statement before the token
  row is read (H-5), in their own transaction, so a request that later fails still counts. A
  request the quota refuses charges nothing: the shared limiter takes both units or neither,
  and public intake depends on that. Over either limit is 429 with `Retry-After` until that
  window ends; the 429 still counts in the usage `refusals` (H-8). W-15 limits stay,
  including 20 active tokens per tenant.
- **H-8 Usage record.** Table `automation_token_usage` (`tenant_id`, `token_id`, `hour`,
  `requests`, `reads`, `proposals`, `refusals`), one row per token per hour. Counters only
  grow: the database refuses any update that lowers one, and a row can only name a token of
  its own tenant (composite foreign key).
  - Recording: one outcome per authenticated request, recorded exactly once, whichever way
    the request ends after authentication (including a limiter outage). It is written in its
    own short transaction (a 2 second timeout) that is not bound to the request deadline or
    signal, so a slow or failed write never changes the response (a 200 stays a 200). A failed
    write is reported and never fails the request. A request that ends 401 (for example the
    token is revoked while the request runs) is not recorded. Unauthenticated requests are
    attributed to no token.
  - `reads` counts read tools that returned, `proposals` counts proposal tools that returned.
  - `refusals` counts: a 429; any HTTP 4xx other than 401; any JSON-RPC `error` in the
    response body (including the SDK's -32600, -32601, -32602); and any tool domain error
    (a 4xx result). It does not count 5xx or 401.
  - Retention: rows older than 30 days are deleted in bounded batches (1,000 rows, skipping
    rows locked by other sessions, at most 5 batches per pass). The prune runs whenever
    `/mcp` is on (the automation key is set), as its own periodic job beside the
    server, and not only when the Activepieces webhook worker runs.
  - Owners read the last 168 hours per token at
    `GET /v1/integrations/activepieces/tokens/:id/usage` (permission `integrations`): exactly
    the 168 hourly slots ending with the current hour, and never a later hour.
- **H-9 Owner management.** The existing owner routes create, list and revoke tokens and
  accept the new scopes. Creating shows the token once. Revoking is immediate (W-9, H-3).
  `GET /v1/integrations/activepieces/scopes` (permission `integrations`) returns every
  token scope with its disclosure text from "What each read scope discloses" (propose
  scopes carry a one-line description), so the dashboard screen can show what an owner
  grants. The dashboard screen itself is out of scope.
- **H-10 Untrusted content.** Tool descriptions of every tool that returns stored text
  (every read tool and `get_proposal`) say that this text is data written by people, not
  instructions. The wording names what is stored: customer names, emails and phones, deal
  titles, pipeline, stage and resource names, messages and business fields.
- **H-11 Tenancy.** `automation_token_usage` has `tenant_id`, forced RLS, the tenant policy
  and a two-tenant denial test under the runtime role. A token of tenant A gets nothing of
  tenant B through any tool, including by passing B's IDs.
- **H-12 Migration.** One forward migration adds the six read values to
  `automation_token_scope`, raises the scopes cardinality check to 9, adds the H-1 expiry
  check for read-bearing tokens (`NOT VALID` for existing rows is not needed: no existing row
  holds a read scope) and creates `automation_token_usage` with a trigger that refuses any decrease of a counter
  (H-8). The contracts' scope enum,
  request, command and output schemas change with it.

## What each read scope discloses

Owners see this text when they choose scopes.

- `contacts:read`: customer names, emails, phones, marketing consent.
- `deals:read`: deal titles, values, stages, lead sources and their contacts.
- `bookings:read`: bookings with times, resources and the linked customer's name and ID.
- `inbox:read`: website requests and replies with customer identities and message text,
  and the names and emails of staff who replied.
- `results:read`: lead, booking and revenue totals by source.
- `business:read`: the business profile (name, contact details, address, currency, zone).

## Acceptance

- An MCP SDK client (`@modelcontextprotocol/sdk` Client with the Streamable HTTP client
  transport) against the real Hono app: initialize, `tools/list`, a read, a proposal, a
  replayed proposal, a conflicting proposal and an error; a second independent client works
  at the same time; no session ID is issued.
- A token with only `contacts:read` lists and reads contacts, sees only those tools plus
  `whoami` and `get_proposal`, and gets -32601 calling `list_deals`.
- A token with no read scope reads nothing; one with only propose scopes proposes and reads
  back only its own proposals; another token of the same tenant gets not found for them.
- A legacy propose-only token, a read-only token and an all-nine-scope token each work.
- A revoked or expired token gets 401 on its next request. A tampered token gets 401 before
  any database query. A revoke during a read waits for it; the next read is refused.
- Two tenants: each token sees only its own tenant's rows, also when given the other's IDs.
- The 121st request inside a minute is 429; the 2,001st inside an hour is 429; two API
  instances share the count. Usage rows count requests, reads, proposals and refusals.
- A client disconnect cancels the request's database work (a statement in flight is
  cancelled and rolled back, and the connection is released); a database outage is a 503;
  a request past its deadline is a 503 and its statement ends with the abort error.
- The check order of H-5 holds: 405 before the tag check, the tag check before the body is
  read, 413 by stream bytes, 429 before the token row is read (a revoked token with a valid
  tag over the limit gets 429 and causes no token row read), and 429 wins over the session ID
  404 and the 400s. A refused request charges nothing.
- Revoking a token while an HTTP read or proposal is in flight waits for it; the next request,
  including a replayed proposal, is a 401.
- A slow or blocked usage write does not change the response. A usage decrease is refused
  and another tenant's token ID is refused, under the runtime role. The 168 hour window
  includes hour -167 and excludes hour -168. A prune with more than one batch of old rows
  stops after the bounded number of passes.
- No tool approves, rejects, sends or writes anything but a pending proposal.

## What the Mac sets

Nothing new: `ACTIVEPIECES_KEY_SECRET` (W-14) turns this on with the automation routes.
