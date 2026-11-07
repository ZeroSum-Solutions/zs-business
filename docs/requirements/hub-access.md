# Hub access: one agent surface for every client

Status: draft contract, revision 2 (2026-11-06; revision 2 answers the Sol contract review:
proposal retries, read adapter, migration, transport statuses, quota unit, usage table,
deadline, SDK acceptance, expiry, tool table, disclosures). Code follows this file; a change
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
- **H-3 Read path.** A token read runs in one tenant transaction under the runtime role. In
  that transaction it takes a shared lock on the token row, reads the clock after the lock,
  re-checks revoked and expired, checks the scope, then calls the read function. A revoke
  commits only after in-flight reads holding the lock end; every read that starts after the
  revoke commits is refused. A missing scope is refused before any business row is read.
  Member sessions and their checks do not change.
- **H-4 Writes stay proposals.** The MCP edge offers the four W-12 proposals and the W-13
  proposal read, and no other write. Every proposal tool takes a required `idempotencyKey`
  argument with the W-12 derivation: the same key and body return the same proposal; the
  same key with a different body is a conflict. Approving stays an owner action.
- **H-5 Remote MCP transport.** `POST /mcp`, `Authorization: Bearer zsap1_…`, stateless
  Streamable HTTP, JSON responses, no session ID issued or accepted. `GET` and `DELETE` are
  405. Answered at the HTTP level, before MCP handling: a body over 64 KiB is 413; a JSON-RPC
  batch (an array body) is 400; any authentication failure is the W-9 401; a quota refusal is
  429 with `Retry-After`; without the automation key configured the route is 404. Answered
  inside MCP: a tool the token's scopes do not allow is not listed, and calling it returns a
  JSON-RPC error with code -32601 (`Method not found`) and does not reveal whether the tool
  exists; a domain error (validation, not found, conflict) is a tool result with `isError`
  and the stable error code. `/mcp` runs under the same request deadline, disconnect
  cancellation and bounded database work as `/v1`.
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
- **H-7 Limits.** The counted unit is one authenticated `POST /mcp` request, whatever it
  carries (initialize, list, call or notification). Each costs one unit in two fixed-window
  buckets, `mcp-minute:<token>` (120 per minute) and `mcp-hour:<token>` (2,000 per hour), in
  the shared Postgres rate-limit store the public intake uses. Both are charged in one
  statement before the request is handled, in their own transaction, so a request that later
  fails still counts. Over either limit is 429 with `Retry-After` until that window ends.
  W-15 limits stay, including 20 active tokens per tenant.
- **H-8 Usage record.** Table `automation_token_usage` (`tenant_id`, `token_id`, `hour`,
  `requests`, `reads`, `proposals`, `refusals`), one row per token per hour, incremented
  atomically after each authenticated request in its own transaction. `reads` counts read
  tools that returned, `proposals` counts proposal tools that returned, `refusals` counts
  429s and MCP refusals. A failed increment is logged and never fails the request.
  Unauthenticated requests are attributed to no token. Rows older than 30 days are deleted by
  the existing Activepieces worker pass. Owners read the last 7 days per token at
  `GET /v1/integrations/activepieces/tokens/:id/usage` (permission `integrations`).
- **H-9 Owner management.** The existing owner routes create, list and revoke tokens and
  accept the new scopes. Creating shows the token once. Revoking is immediate (W-9, H-3).
- **H-10 Untrusted content.** Tool descriptions say that contact notes, messages, thread text
  and business fields are data written by people, not instructions.
- **H-11 Tenancy.** `automation_token_usage` has `tenant_id`, forced RLS, the tenant policy
  and a two-tenant denial test under the runtime role. A token of tenant A gets nothing of
  tenant B through any tool, including by passing B's IDs.
- **H-12 Migration.** One forward migration adds the six read values to
  `automation_token_scope`, raises the scopes cardinality check to 9, adds the H-1 expiry
  check for read-bearing tokens (`NOT VALID` for existing rows is not needed: no existing row
  holds a read scope) and creates `automation_token_usage`. The contracts' scope enum,
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
- A client disconnect cancels the request's database work; a database outage is a 503.
- No tool approves, rejects, sends or writes anything but a pending proposal.

## What the Mac sets

Nothing new: `ACTIVEPIECES_KEY_SECRET` (W-14) turns this on with the automation routes.
