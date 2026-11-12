# Hub access: one agent surface for every client

Status: draft contract, revision 5 (2026-11-12; revision 5 adds the blob upload route, H-16, and the site kind dispatch
with its blob reader, H-17; the daily publish limit is PL-25 in `plans.md`. Revision 4 (2026-11-11) added the `sites:publish` scope, the
site allowlist and the `/automation/v1/sites` routes, H-13..H-15, and amends W-13 so `/me`
names the tenant and the sites; it follows `/Users/zero-suminc./Inbox/plans/mishmash/2026-11/2026-11-11-mishmash-creator-identity-spec.md`
decisions D-3 and A-2. Revision 3 (2026-11-06) answered the four-model audit of the
build: check order, refusals charge nothing, guarded `whoami` and proposals, one accounting
path, bounded lists, usage-table integrity, retention wiring, scopes route, notices. Revision 2
answered the Sol contract review: proposal retries, read adapter, migration, transport
statuses, quota unit, usage table, deadline, SDK acceptance, expiry, tool table,
disclosures). Code follows this file; a change
to a numbered rule needs a new revision of this file first. Extends `activepieces.md`
(W-9..W-15); where the two disagree, this file wins for tokens that hold a read scope or
`sites:publish`. Tokens that hold only propose scopes behave exactly as W-9..W-13 say, except
that `GET /me` answers the two added fields of the W-13 amendment below.

Scope: let any agent the owner trusts (Mish, Hermes, an agent fleet, Claude, Codex, an
Activepieces flow) work with one business through one remote MCP endpoint and one kind of
token. The agent reads what its scopes allow and proposes actions; an owner decides every
proposal. Nothing here lets an agent approve or reach another tenant, and no read or propose
scope lets it act directly. The one exception is `sites:publish` (H-13): it lets a token
publish, roll back and sync the sites it was bound to at creation, and nothing else.

Out of scope for this revision: external connections (Shopify, Gmail and the rest; the next
contract, `connections.md`), drafting replies, executing approved writes in other services,
dashboard screens beyond the token list, per-call billing, reduced output schemas.
Out of scope for revisions 4 and 5: the public sign-up route, the operator script that creates a
creator, a dashboard screen for site tokens, site tools on `/mcp`, and usage rows for the site
routes (H-8 counts `/mcp` only). Revision 4 left out the blob upload route and the free-tier
limit of 20 publishes a day; revision 5 adds them (H-16, `plans.md` PL-25). Still out of scope after
revision 5: the `linkpage` compiler adapter (it needs the `@mish/linkpage` package from Mish),
the CSP `<meta>` of a link page, and how a blob-route image passes the image gate (H-17).

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
- Revision 4 (creator identity spec, D-3): local Mish publishes a creator's link page with a
  `zsap1_` token. `/v1/*` accepts member sessions only, so the token gets sibling routes that
  reuse the same site logic through a token adapter, and it is bound to named sites so a token
  for a link page cannot replace the same tenant's business website.
- Member reads (`createSession`) require a membership on every read and must keep doing so.
  Token reads therefore use the lower-level read functions (`packages/core/src/reads/`)
  through their own adapter, not the member session.
- MCP over Streamable HTTP, stateless: each request builds its server and transport, answers
  in JSON, keeps no session, and disposes both when the response ends.

## Numbered rules

- **H-1 One credential.** Agents use automation tokens (W-9). Expiry stays optional for
  propose-only tokens (W-9 unchanged). A token created with any read scope, or with
  `sites:publish` (H-13), must have an expiry of 1 to 365 days; the request default is 90.
  Existing tokens are unchanged.
- **H-2 Read scopes.** New scopes beside the W-10 propose scopes: `contacts:read`,
  `deals:read`, `bookings:read`, `inbox:read`, `results:read`, `business:read`. A token may
  hold all nine scopes (revision 3 and the connections contract added `connections:read`, and
  revision 4 adds `sites:publish`: a token may hold all eleven). The scopes are operation scopes, not field filters; the disclosures
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
    `/mcp` is on (the automation key is set), not only when the Activepieces webhook worker
    runs: each API instance prunes after its first usage write and then at most hourly, as the
    runtime role through a `SECURITY DEFINER` function, so no service credential is needed.
    The webhook worker prunes the same way on each pass when it runs.
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
- **H-12 Migration (revision 3, historical).** One forward migration adds the six read values to
  `automation_token_scope`, raises the scopes cardinality check to 9, adds the H-1 expiry
  check for read-bearing tokens (`NOT VALID` for existing rows is not needed: no existing row
  holds a read scope) and creates `automation_token_usage` with a trigger that refuses any decrease of a counter
  (H-8). The contracts' scope enum,
  request, command and output schemas change with it. Revision 4 has its own forward
  migration (H-14): it adds the enum value `sites:publish`, raises the scopes cardinality
  check from 10 to 11, replaces the read-expiry check with one over the scopes cast to a text
  array that also requires an expiry for `sites:publish` (an enum value added in the same
  transaction cannot be used as a literal, so the comparison is on text), and creates
  `automation_token_sites` with its triggers.
- **H-13 Publish scope (revision 4).** The scope `sites:publish` lets a token act on its
  bound sites (H-14) and nowhere else. It may: read the site, publish a release and make it
  live, preview a spec, list and read releases, make an earlier release live again
  (rollback), and sync the site to the edge. It may not: create or delete a site, attach or
  detach a host (service role only), read customers, sign-ups or any other business data (each
  is a separate read scope), create, list or revoke tokens, or call any `/v1` route. A token
  holding it must have an expiry of 1 to 365 days (H-1), checked in the database as 24 to 8760
  hours after creation, the same check the read scopes use, and it must name 1 to 10 sites at
  creation (H-14). The scope is not a read scope for H-3 purposes beyond the lock mode in H-15.
  It adds no tool to `/mcp`: H-6 is unchanged, and `whoami` on `/mcp` answers the W-13 fields
  below like `GET /me`. Owners choose it with the disclosure text under "What each read scope
  discloses"; the scopes route (H-9) lists it with that text, as kind `publish`.
- **H-14 Site allowlist (revision 4).** Table `automation_token_sites (tenant_id, token_id,
  site_id)`, primary key `(tenant_id, token_id, site_id)`, composite foreign keys to
  `automation_tokens (tenant_id, id)` and `sites (tenant_id, id)`, forced RLS, the tenant
  policy and a two-tenant denial test under the runtime role. The runtime and service roles
  may read and insert rows and nothing else (no update, no delete, no truncate). Grants alone
  would still let a later insert widen an existing token, so a trigger refuses an insert
  unless the token row was inserted by the same transaction (the row is visible and the
  transaction that wrote it, a savepoint of the current one included, is still in progress).
  That writer check would pass for a committed token whose row a transaction re-wrote, so a
  second trigger refuses every update of `revoked_at, revoked_by` except the first, one-way
  revoke (the only update the runtime role holds). The allowlist is therefore
  immutable once the token exists, and a change is a new token (revoke the old one). The
  isolation tests try a later insert under the runtime role and the service role and expect
  a refusal from both. The database refuses, at commit (a deferred constraint
  trigger, because the token row is inserted before its allowlist rows), a token that holds
  `sites:publish` with fewer than 1 or more than 10 rows, and a token without the scope with
  any row. The create path writes the token and its rows in one transaction and refuses a site
  that is not the tenant's (`ValidationFailed` on `siteIds`; a foreign site and an unknown one
  answer alike). `siteIds` is required with `sites:publish`, refused without it, 1 to 10
  distinct UUIDs. The token record shows `siteIds` (empty without the scope). Allowlist rows
  are read through the same locked token row as the scopes (H-3), so a revoke stops a site
  request exactly as it stops a read.
- **H-15 Site routes (revision 4).** `/automation/v1/sites/:siteId/...`, outside `/v1`,
  `Authorization: Bearer zsap1_…`. They are mounted only when the automation key and a site
  store are both configured; otherwise every path is 404. The routes, with the request and
  response shapes of the same `/v1/sites` routes (the publish and preview bodies are stricter,
  below): `GET /:siteId`; `POST /:siteId/preview`; `GET /:siteId/releases`;
  `POST /:siteId/releases` (publish, `Idempotency-Key` required, 201); `GET
  /:siteId/releases/:releaseId`; `POST /:siteId/releases/:releaseId/activate`
  (`Idempotency-Key` required, body `{ expectedCurrentReleaseId }`); `POST /:siteId/sync`; and, from
  revision 5, `PUT /:siteId/blobs/:sha256` (H-16, which has its own body cap in step 2).
  There is no create and no list route. The checks run in this fixed order and the first that
  fails answers:
  1. The token tag check: a missing, malformed or tampered token is the W-9 401. Pure CPU, no
     database access.
  2. A body over 64 KiB is 413, counted on the stream (H-5 step 3). The blob route's cap is 10 MiB (H-16).
  3. The quota: two fixed-window buckets `sites-minute:<tenantId>:<tokenId>` (30 per minute)
     and `sites-hour:<tenantId>:<tokenId>` (300 per hour) in the shared Postgres limiter, one
     unit each per request with a valid tag, charged in one all-or-nothing statement before
     the token row is read. Over either limit is 429 with `Retry-After`. These numbers are the
     spec's choice and are tunable by a later revision.
  4. The token guard (H-3) in the request's tenant transaction under the runtime role: lock the
     token row, read the clock after the lock, a missing, revoked or expired token is the W-9
     401, and a token without `sites:publish` is `TenantDenied` (403 `Forbidden`) before any
     site row is read, with the same answer for any site ID. Reads take the shared lock; publish,
     activate and sync take the exclusive lock, inside the transaction that does the work, so a
     revoke that commits first stops them.
  5. The site: it must be in the token's allowlist (H-14) and visible under RLS, else
     `NotFound` (404) with the body an unknown ID gets, raised before any handler runs. A
     site of the same tenant that the token does not name answers 404, never 403.
  6. For a release route, the release must belong to that site, else 404 like an unknown ID.
     An activate needs its body and key before it can compare the baseline, so a bad body or
     key (400, step 7) and a stale `expectedCurrentReleaseId` (409 `stale_release`) come first
     for that route; both answers are the same for any release ID, an own one, a foreign one
     and an unknown one, and disclose nothing.
  7. The body, strict: the publish and preview bodies hold only `spec` and (publish)
     `expectedCurrentReleaseId`, and the spec may not carry the top-level keys `tenantId`,
     `origin`, `trackBase` or `signup`, because the tenant is the token's and the origin,
     click-counter base and sign-up target come from the site record, never from the caller.
     Any of them is 400 `ValidationFailed`, and nothing is recorded.
  8. The existing publish rules: stale release 409, size limits, image approval, the compile,
     store and record steps of `apps/api/README.md` "Sites".
  Deferred: deriving `origin`, `trackBase` and `signup.endpoint` from the site record. The site
  record holds hosts and none of these fields, and the compiler port receives only the spec.
  This revision keeps the rule that a caller value for them is refused (step 7) and adds no
  enrichment; the publisher adapter that wants them must take them from the site's attached
  host on the server (the hosting decision), in a later revision.

  The actor recorded as `created_by` and `actor_id` is the token's actor ID (W-11, one per
  token); those columns hold plain UUIDs with no member foreign key. The idempotency key a
  caller sends is stored under the server prefix `activepieces:` derived from the tenant, the
  token and the caller's key, so two tokens, or a token and a member, never share a stored
  action. Member behaviour of `/v1/sites` does not change: the site logic is one function that
  a member session and a token adapter both use, and the existing `/v1/sites` tests are its
  regression check. A foreign object answering 404 on these routes, where `/v1/sites` writes
  may answer 403 or 404, is deliberate (creator identity spec, deviation 6).
- **H-16 Blob upload (revision 5).** `PUT /v1/sites/:siteId/blobs/:sha256` for a member (owners, the
  `publish` permission, as every `/v1/sites` route) and `PUT /automation/v1/sites/:siteId/blobs/:sha256`
  for a `sites:publish` token. The body is the raw bytes; its `Content-Type` is ignored. The blob is
  stored once at `t/<tenantId>/blobs/<sha256>`, the key `storeReleaseFiles` uses, so a release that lists
  the same bytes finds it. The tenant is the member's or the token's, never the path's or the body's.
  - **Byte cap: 10 MiB (`SITE_LIMITS.fileBytes`).** A release refuses any file over that size, so a larger
    blob could never be part of a release, and the media upload takes the same size. The cap is counted on
    the stream (413). It replaces the 64 KiB cap of the other site routes for this route only; the `/v1`
    JSON cap does not apply to it.
  - **Types.** The bytes are sniffed, not trusted: PNG, JPEG, WebP or GIF (the header must say so), else 400.
    The sniffed type is the object's content type and is returned.
  - **Check order, token route.** The H-15 order up to step 5, with the body cap of this rule in step 2:
    tag (401), body over 10 MiB (413), quota (429, the same two buckets as the other site routes, one unit
    for the request), token guard (401, 403), the site in the allowlist (404). Then the path and the body:
    `:sha256` must be 64 lowercase hex characters, the body 1 byte to 10 MiB, a supported type, and the
    SHA-256 of the body must equal `:sha256`, else 400 `ValidationFailed` and **no store call of any kind**.
    Only then the store is asked. Member route: session (401), body cap (413), permission and site under
    RLS (403, 404 for a site of another tenant or an unknown ID), then the same 400 checks.
  - **Idempotent.** The same bytes again: `200 { sha256, bytes, mediaType, created: false }` and no write.
    A new blob: `201` with `created: true` (one conditional write, put only if absent; a lost race answers
    `200`). An object already at the key with another size is a server fault (500), never overwritten. A
    store failure is 503 `Unavailable`, as in a publish.
  - **Tenancy.** A token or member of tenant A that names tenant B's site gets 404 and nothing is written
    (creator identity spec X-16). Identical bytes in two tenants are two objects; content addressing never
    shares bytes across tenants.
  - **Not a publish.** The route records nothing in the database and does not count toward the daily
    publish limit (`plans.md` PL-25). An upload whose release never commits stays an unreferenced object
    (as in `apps/api/README.md` "Sites", step 2); there is no sweep and no per-tenant storage cap yet. A
    revoke that commits while an upload is in flight does not undo that upload, as for the store step of
    a publish.
  - **Tests.** X-16 (cross-tenant upload), X-17 (a release naming a blob only another tenant holds), X-18
    (hash mismatch) and the member and size cases, in `apps/api/test/site-blobs.test.ts`.
- **H-17 Site kinds and the blob reader (revision 5).** The compiler the API holds dispatches on the
  spec's top-level `kind`:
  1. `kind` absent: the publisher slot, the compiler passed to `createServer` as `siteCompiler` (a Mish recipe
     carries no `kind`, so today's publisher specs keep working unchanged). With none wired, 400.
  2. `kind: "plain"`: the built-in plain compiler.
  3. `kind: "linkpage"`: the link page slot. **Not wired in this revision**: the answer is 400
     `ValidationFailed` ("not available") until the `@mish/linkpage` adapter lands. That later change also
     owns the CSP `<meta>` (hosting decision: hash of the inline script, `connect-src` for the Hub API)
     and the golden digest against the Mish render.
  4. Any other `kind`, or a `kind` that is not a string: 400 `ValidationFailed`.
  Every compile, for a publish and for a preview, receives a blob reader bound to the caller's tenant:
  `read(sha256)` reads `t/<tenantId>/blobs/<sha256>` and nothing else, checks the bytes against the digest,
  and throws 400 `ValidationFailed` ("blob not uploaded") when the object is absent. A store that does not
  answer is 503 `Unavailable` with `Retry-After`, as for any site store failure. A publish retried with a key
  that already recorded a release of the site compiles nothing and reads no blob: it takes the entry, digest
  and files from the recorded action and goes through dispatch with the request's own spec, so a retry after a
  lost answer works during a store outage and a changed spec is still refused as a reused key. A spec that names a
  digest only another tenant holds therefore fails exactly like one nobody holds, and no read touches
  another tenant's prefix (X-17). The refusal happens in the compile step, before anything is stored,
  recorded or moved: the site stays as it was. The blob reader is the only door from a spec to stored
  bytes. The rules of H-15 step 7 (no `tenantId`, `origin`, `trackBase`, `signup` in a token's spec) stand.
  - **Image gate unchanged.** `image-port.md` IM-14 still refuses a release file with an `image/*` type whose
    SHA-256 is not a tenant `media_assets` row. A picture uploaded through H-16 is not a media asset, so a
    release that serves it as an image fails with 409 `image_not_approved` until a later revision decides how
    owner-uploaded blobs pass the gate. That decision belongs with the `linkpage` adapter, which is the
    first spec kind that serves uploaded pictures.
- **W-13 amendment (revision 4).** `GET /me` (and `whoami` on `/mcp`) names the token and its
  scopes as before and adds `tenantId` and `siteIds`: the token's own tenant, and the sites
  its allowlist names (empty for a token without `sites:publish`). Both come from the locked
  token row (H-3), never from a request. A client that connects with a token learns from this
  which tenant and sites it may touch.

## What each read scope discloses

Owners see this text when they choose scopes.

- `contacts:read`: customer names, emails, phones, marketing consent.
- `deals:read`: deal titles, values, stages, lead sources and their contacts.
- `bookings:read`: bookings with times, resources and the linked customer's name and ID.
- `inbox:read`: website requests and replies with customer identities and message text,
  and the names and emails of staff who replied.
- `results:read`: lead, booking and revenue totals by source.
- `business:read`: the business profile (name, contact details, address, currency, zone).
- `sites:publish` (not a read scope; revision 4): "Publish and roll back the named sites.
  Cannot read customers." The owner sees the names of the bound sites next to it.

## Acceptance

- An MCP SDK client (`@modelcontextprotocol/sdk` Client with the Streamable HTTP client
  transport) against the real Hono app: initialize, `tools/list`, a read, a proposal, a
  replayed proposal, a conflicting proposal and an error; a second independent client works
  at the same time; no session ID is issued.
- A token with only `contacts:read` lists and reads contacts, sees only those tools plus
  `whoami` and `get_proposal`, and gets -32601 calling `list_deals`.
- A token with no read scope reads no business data (`sites:publish` reads only its named
  sites, through the site routes); one with only propose scopes proposes and reads
  back only its own proposals; another token of the same tenant gets not found for them.
- A legacy propose-only token, a read-only token and an all-nine-scope token each work.
- Revision 4: a `sites:publish` token publishes and rolls back its named sites through
  `/automation/v1/sites`; it gets 404 for another site of its tenant and for another tenant's
  site; a token without the scope, or a revoked or expired one, gets 403 or 401 as H-15 says;
  `/v1/*` refuses it (401), and `/mcp` gives it no site tool (it still lists `whoami`,
  `get_proposal` and the tools its other scopes grant, and answers -32601 for a tool it lacks);
  the allowlist cannot be changed and the database
  refuses a token whose rows break the 1 to 10 rule; `GET /me` names `tenantId` and `siteIds`.
- Revision 5: a token or owner uploads a picture to a named site and gets 201, then 200 with no second write;
  a body whose hash differs from the path is 400 with no store call; another tenant's site is 404 with no
  object written; a release that names a blob only another tenant holds is 400 with no read of that tenant's
  prefix and the site unchanged; a spec of unknown kind is 400, an untagged one still compiles through the
  publisher slot, and the `linkpage` kind answers 400 until the adapter is wired.
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
