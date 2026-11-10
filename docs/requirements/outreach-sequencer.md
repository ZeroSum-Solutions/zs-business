# Outreach sequencer: cold email from our own Gmail mailboxes

Status: built (2026-11-08), first slice; revision 2026-11-10 adds `{{opener}}` (OS-5, OS-7), not deployed and not scheduled; owner decisions of that day applied. Code follows this file; a change to a numbered
rule needs a new revision of this file first. Nothing in this work sends a real email: every
test uses the fake Gmail port (OS-25), and real sending needs two switches the repo owner sets
by hand (OS-10).

Scope (Customers area): an owner of an allowed tenant runs a cold-outreach campaign. A
campaign is a short sequence of plain-text emails. The worker sends each step from one of the
tenant's connected Google Workspace mailboxes through the Gmail API, inside a send window in
the tenant's time zone, under a daily cap per mailbox. Follow-ups go in the same Gmail thread.
A prospect's sequence stops when the prospect replies, the email bounces, the address is
unsubscribed or suppressed, or the owner stops it. Every email carries the hub's unsubscribe
link, the `List-Unsubscribe` headers and a footer with the tenant's real postal address.
First user: Zero Sum's own hub tenant, sending from `devin@zerosum-solutions.com` and
`devin.wiggins@zerosum-solutions.com`, which are two separate licensed Workspace mailboxes
(repo owner, 2026-11-08). It replaces Smartlead after month 1.

Out of scope: dashboard screens (owners use the API, the MCP adapter and the existing
approvals screen); HTML email, attachments, images, open and click tracking; A/B tests;
reading or classifying reply text; creating CRM contacts, deals or Inbox
threads from replies; holiday calendars; custom variables beyond `first_name`, `company`,
`industry`, `opener`; mailboxes outside Google Workspace; service-account sending; any tenant not on the
allowlist (OS-1); a Node loop worker (cron only); importing from Smartlead's API.

## Evidence and decisions

- Brief from Devin (2026-11-08, through the planner): build a hub sequencer on the Gmail API
  from two Workspace mailboxes on `zerosum-solutions.com`; the Workspace is being created now.
  This brief is the repo owner's approval of a business Gmail connection that
  `docs/integrations.md` ("No ... business Gmail connection until the owner ... approves it")
  asks for, limited to sending from the allowed tenant's own outreach mailboxes. The slice
  updates that line and records the approval in the decisions table of `docs/integrations.md`.
- Warm-up, decided here (repo owner, 2026-11-08): a mailbox's daily cap starts at 5 on its
  first send day and rises by 5 every 7 days up to the configured cap (OS-12). The ramp is a
  pure function of (first send date, today, cap); the worker passes the injected clock's local
  date.
- Smartlead is proprietary SaaS: behaviour notes only, in our own words (`docs/licenses.md`,
  HighLevel rule). Behaviour worth rebuilding: steps with business-day delays, a send window,
  a per-mailbox daily cap, one mailbox per prospect, follow-ups in the original thread, stop on
  reply, stop on bounce, global unsubscribe.
- Reference sequence (read only, never copied into this repo):
  `~/.claude/goal-state/zs-hub-four-verticals/proof/outbound/sequence-v1.md`. It has three
  steps, a window of 08:00 to 10:30 Pacific, step 2 three business days after step 1, step 3
  eight business days after step 1, 20 sends a day per mailbox and a footer with the postal
  address. In this contract's terms: delays 0, 3, 5 (each delay counts from the step before,
  OS-11). The launch guard next to it,
  `~/.claude/goal-state/zs-hub-four-verticals/proof/outbound/launch-guard.sh`, refuses a launch
  while the file holds the postal-address placeholder. OS-6 mirrors it inside the hub; neither
  file is edited by this work. Test fixtures use invented copy and `example.com` addresses.
- Existing code reused: the OAuth client, PKCE helpers and sealed-token format of the calendar
  connection (`packages/core/src/calendar/google.ts`, `oauth-state.ts`, `seal.ts`), the
  unsubscribe token and endpoint (`packages/core/src/delivery/unsubscribe.ts`,
  `packages/core/src/edge/delivery-session.ts`, `apps/api/src/public/unsubscribe.ts`), the
  suppression action (`packages/core/src/delivery/suppression.ts`), consent
  (`crm_contact_consent`), hard suppression (`packages/core/src/outreach/hard-suppression.ts`),
  the business profile (`business_profiles`, migration `20261023100000_business_profiles.sql`),
  time-zone arithmetic (`packages/core/src/booking/time-zone.ts`), approvals (`approvals.md`
  A-5..A-10) and the workers-project cron layout (`apps/api/scripts/build-vercel.mjs`).
- Gmail and Google OAuth behaviour (public docs, in our own words; recheck when the slice
  starts; only the fake and a stubbed `fetch` prove it until the first real send):
  - `messages.send` takes `{ raw, threadId? }` (`raw` = the RFC 5322 message, base64url) and
    answers `{ id, threadId, labelIds }`. It has no idempotency key: a repeat sends again.
  - A sent message joins a thread only when the request names `threadId`, the message carries
    `In-Reply-To` and `References`, and the subject matches the thread's (a `Re: ` prefix is
    accepted).
  - `gmail.send` allows sending only. `gmail.metadata` allows reading message and thread
    headers and labels, `history.list` and `getProfile`, never bodies, and refuses the `q`
    search parameter. `gmail.metadata` is a restricted scope; an app whose user type is
    Internal needs no Google verification and its refresh tokens do not expire after 7 days.
  - `history.list(startHistoryId, historyTypes=messageAdded)` lists messages added since a
    point; a start point that is too old (about a week, sometimes less) answers 404.
  - Google revokes refresh tokens that carry Gmail scopes when the user changes the password.
  - A Desktop-type OAuth client may redirect to a loopback address (`http://127.0.0.1:<port>`).
  - A Workspace user may send about 2,000 messages a day; our caps stay far below that.
- Auth model, decided here: one **Internal OAuth app** (Desktop client) in a Google Cloud
  project owned by the `zerosum-solutions.com` Workspace, with exactly the scopes `gmail.send`
  and `gmail.metadata`. Each mailbox consents once through an operator command on the Mac
  (OS-2); its refresh token is sealed with a new X25519 key pair in the calendar's `zsg1`
  format, and only the outreach worker holds the private key (OS-21). Why not a service
  account with domain-wide delegation: it needs a long-lived service-account key (new Google
  Cloud organisations block key creation by default), a leaked key could send as every user in
  the domain, and it needs a new JWT signing path. Per-mailbox OAuth is revocable per mailbox,
  reuses tested code, and its worst leak is one mailbox. Why not the calendar's browser flow
  (G-1, G-2): it needs dashboard callback routes and cookies; two operator-owned mailboxes do
  not justify them, and the API then never holds a Gmail client secret.
- Why `gmail.metadata` and not `gmail.readonly`: reply and bounce detection needs only the
  `From`, `Auto-Submitted`, `X-Failed-Recipients`, `Content-Type`, `Message-ID` and our own
  `X-Zs-Ref` headers, labels and thread membership. No body is ever read.
- Delivery model, decided here: outreach does not go through `message_deliveries`. Gmail is
  free to us (no wallet reservation), has no idempotency key (D-8's dedupe window does not
  exist), and a sequence needs thread state per prospect. Outreach keeps its own send record
  (OS-15) and reuses only the unsubscribe token, endpoint and suppression list.
- Exactly-once is impossible without a provider key, so the rule is **at most once per
  prospect and step** (OS-15, OS-16): the attempt is committed before the call, and an attempt
  whose outcome is unknown is never repeated; a probe decides it or the prospect stops.
- Follow-up subjects, decided here: steps 2 and later have no subject of their own; they use
  `Re: ` plus step 1's rendered subject, because Gmail threads only on a matching subject. The
  reference's step 3 subject is therefore not used.
- One sequence per address per tenant, decided here: a prospect's address is unique in the
  tenant across all campaigns, so a person who replied "stop" (any reply stops, OS-19) is never
  put in a new sequence. Addresses Smartlead already contacted are imported as `excluded`
  (OS-7) so the hub never emails them during the overlap.
- Worker writes, as in `enrichment.md` (built note 1): owner intent (create, import, activate,
  pause, stop, mailbox connect) goes through the dispatcher with an outbox event; the worker's
  lease, send, settle and stop writes are service-role SQL keyed by unique rows. The bounce
  suppression is a dispatcher action under a server-built principal (OS-19).

## Numbered rules

**OS-1. Allowlist and permission.** Outreach exists only for tenants in `OUTREACH_TENANTS`
(comma-separated tenant UUIDs, injected config, read by the API and the worker). For any other
tenant every outreach route answers 404, every MCP tool `not_found`, and the worker selects
none of its rows (every worker query filters `tenant_id = ANY($allowlist)`). A new permission
`outreach` joins `permissionSchema` (`packages/contracts/src/members.ts`); owners hold it,
staff do not. Every outreach route, action and tool needs it.
Test: a non-allowlisted tenant's owner gets 404 on `GET /v1/outreach/campaigns`; an allowlisted
tenant's staff member gets 403; the worker run with rows seeded for a non-allowlisted tenant
makes no fake Gmail call.

**OS-2. Connecting a mailbox (operator command).** `pnpm --filter @zs/api
outreach:connect-mailbox --tenant <uuid> --mailbox <address> --name "<From name>"
[--daily-limit 20] [--dry-run]` runs on the Mac with `OUTREACH_GOOGLE_CLIENT_ID`,
`OUTREACH_GOOGLE_CLIENT_SECRET`, `OUTREACH_TOKEN_PUBLIC_KEY` and the hosted database login the
other `db:hosted-*` scripts use. It:
1. refuses unless the tenant is in `OUTREACH_TENANTS` and the address's domain is in
   `OUTREACH_MAILBOX_DOMAINS` (default `zerosum-solutions.com`);
2. listens on `127.0.0.1` on a free port, prints the consent URL (scopes exactly
   `https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata`,
   `access_type=offline`, `prompt=consent`, `login_hint=<address>`, `hd=<domain>`, a random
   32-byte `state` kept in memory, a random PKCE verifier) and waits at most 5 minutes;
3. on the callback compares `state` in constant time, exchanges the code with the verifier,
   requires a refresh token and both scopes in the granted scope, calls `getProfile` and
   requires its `emailAddress` to equal `--mailbox` (case-insensitive); any failure stores
   nothing and revokes the fresh grant;
4. seals the refresh token (`sealRefreshToken`, context `{ tenantId, connectionId: mailboxId }`
   with `mailboxId = derivedId(tenantId, "outreach-mailbox", address)`) and runs
   `outreach.mailbox.connect` through `directDispatch` with the principal
   `derivedId(tenantId, "outreach", "operator")`, which may run only `outreach.mailbox.connect`
   and `outreach.mailbox.disconnect` (`only(...)`), under the reserved key
   `outreach:mailbox:<mailboxId>:<sha256 of the sealed token, first 16 hex>`.
`--dry-run` checks the configuration, the tenant and the database and writes nothing. The
command prints the mailbox id and status, never a token. `googleClientConfigSchema` gains an
optional `scopes` (default `GOOGLE_SCOPES`, so the calendar is unchanged) and `authorizeUrl`
optional `loginHint` and `hostedDomain`; `GmailPort.getProfile` (OS-21) reads the address.
Test (`apps/api/test/outreach-connect.test.ts`, fake Google server, a scripted request to the
loopback): a matching account connects and the stored token opens with the private key only
for its own row; a forged `state`, a missing refresh token, a missing `gmail.metadata` scope,
`other@zerosum-solutions.com` for `--mailbox devin@…` and a domain outside the list each
store nothing (and the first four revoke); the consent URL holds exactly the two scopes.

**OS-3. Mailbox rows.** `outreach.mailbox.connect` upserts `outreach_mailboxes` by
(`tenant_id`, `email`): a new row starts `active`; a reconnect of a `reauthorize` or
`disconnected` row replaces the sealed token and sets `active`. `outreach.mailbox.disconnect`
(`--disconnect` flag of the same command) sets `disconnected` and clears the sealed token; the
worker revokes the grant first when it can open it (an already invalid token counts as
revoked). The worker sets `reauthorize` when a refresh answers `invalid_grant` or Gmail answers
401 after a fresh token or 403 `insufficientPermissions`, and reports
`outreach_mailbox_reauthorize` to the operator hook (as `calendar/worker.ts` does). Prospects of
a mailbox that is not `active` wait; they are not reassigned and not stopped.
Test: connect, refresh `invalid_grant` -> `reauthorize` and no send; reconnect -> `active` and
the waiting prospect sends; disconnect clears the token and revokes once.

**OS-4. Campaign create: `outreach.campaign.create`.** Payload `{ campaignId, name, steps,
window: { start: "HH:MM", end: "HH:MM" }, dailyCapPerMailbox?, mailboxIds }`; the edge mints
`campaignId` from the idempotency key; target `{ type: "outreach_campaign", id: campaignId }`.
Rules: `name` 1..120; 1..5 steps; step 1 has `subject` (1..150, no CR or LF) and
`delayBusinessDays` 0; steps 2..5 have no `subject` and `delayBusinessDays` 1..30; `body`
1..5000; window start before end on the same day, at least 30 minutes apart;
`dailyCapPerMailbox` 1..50, default 20; `mailboxIds` 1..5 distinct ids of the tenant's
mailboxes (any status; activation checks status, OS-8). Templates follow OS-5. The campaign
starts `draft` and stores `content_digest` = SHA-256 (hex) of the canonical JSON of steps,
window, cap and sorted mailbox ids. Steps live in `outreach_campaign_steps`, which the runtime
role may insert but never update or delete: a campaign's content never changes after create;
a new version is a new campaign. Event `outreach.campaign.created`.
Test: valid create returns `draft` with its digest; a replay returns the same result; each
broken rule above is `ValidationFailed` with the field's path; a direct SQL `UPDATE` of a step
as the runtime role is refused.

**OS-5. Templates.** A template may use exactly `{{first_name}}`, `{{company}}`, `{{industry}}`
and `{{opener}}` (no spaces inside the braces). `{{opener}}` is the prospect's researched first
line (revision 2026-11-10, OS-7): one line of plain text, up to 300 characters, written per
prospect. Any other `{{` or `}}` sequence is
`ValidationFailed` `unknown_variable` at create. Rendering replaces each variable with the
prospect's value as plain text; values are never re-scanned, so a value holding `{{` renders
as text. A rendered subject with CR or LF is refused at send (OS-14). Follow-up subjects are
`Re: ` + step 1's rendered subject (decided above). The body is sent as written, then the
footer (OS-6). `renderStep` is a pure function in `templates.ts`.
Test: render with all four variables; an unknown variable at create; a `first_name` of
`{{company}}` and an `opener` of `{{company}}` render literally; step 2's subject is `Re: <step 1 subject>`.

**OS-6. Footer and the postal-address guard.** Every email ends with:
```
--
<legal_name, else display_name>
<formatted postal_address>
To stop these emails: <unsubscribe URL>  (or reply "stop")
```
from the tenant's `business_profiles` row read at send time. `formatPostalAddress` joins
`line1`, `line2`, then `city, region postalCode`, then the country code unless it is `US`.
`addressProblem(profile)` answers `postal_address_missing` when `postal_address` is null and
`postal_address_placeholder` when any name or address field contains `placeholder` (any case);
`templateProblem(steps)` answers `template_placeholder` for the same word in a subject or body.
Activation (OS-8) refuses on any of them. At send (OS-14) the worker re-checks the address:
a problem auto-pauses the campaign with that reason and sends nothing. This mirrors
`launch-guard.sh` inside the hub; that file stays untouched.
Test: activation with no address, with `line1: "PLACEHOLDER: postal address"`, and with a
body containing `placeholder` each refuse with their reason; an address cleared after
activation pauses the campaign at the next tick with no fake send; a sent body ends with the
footer, its address and exactly one unsubscribe URL.

**OS-7. Prospect import: `outreach.prospects.import`.** Payload `{ campaignId, prospects }`,
1..500 rows a call, at most 5,000 prospects a campaign; the campaign must be `draft` or
`paused` (`Conflict` `campaign_active`). Row fields: `email` (required, the contracts'
`contactEmailInputSchema`), `firstName` (1..100), `lastName?`, `company` (1..200), `industry?`
(1..100), `opener?` (revision 2026-11-10: a researched first line, at most 300 characters once trimmed, no CR
or LF; the hub trims it and stores nothing when it is empty after trimming), `website?`, `mailboxId?`, `excluded?` (true = contacted elsewhere, for example by Smartlead; decided above).
An `opener` over 300 characters once trimmed or holding CR or LF (on a row that is not `excluded`; an excluded row keeps no opener and is not checked) is not a row reason: the call is
`ValidationFailed` with the row's path (`prospects.<index>.opener`) and stores nothing, so a
broken first line never reaches a recipient. A row is rejected, with its index and one reason, when: the email is invalid
(`invalid_email`); its local part is `postmaster`, `abuse`, `mailer-daemon`, `noreply` or
`no-reply` (`role_address`); a variable used by the campaign's steps is empty for it
(`missing_field`; `{{opener}}` is empty when the row has none); some step would render a subject over 300 characters or a body over 18,000
(`render_too_long`); `hardSuppressionHit` matches its email, website, company or full name
(`hard_suppressed`); the address has a `suppressions` row of any reason (`suppressed`); a CRM
contact with that address has email consent `denied` (`consent_denied`); the address is already
a prospect in the tenant, any campaign, or twice in the payload (`duplicate`); `mailboxId` is
not one of the campaign's mailboxes (`mailbox_not_in_campaign`). An `excluded` row is checked
only for `invalid_email` and `duplicate`, so an address already suppressed can still be
reserved. Kept rows become
`outreach_prospects` with id `derivedId(tenantId, "outreach-prospect", email)`, status
`pending` (or `excluded`, which is never sent and only reserves the address), and a mailbox:
the given one, else the campaign mailbox with the fewest prospects (ties by id). The result
lists `{ imported, excluded, rejected: [{ index, reason }] }`; rejected rows store nothing.
Event `outreach.prospects.imported` (counts only, no addresses).
Test: one import with a hard-suppressed company, a suppressed address, a consent-denied
contact, a duplicate, a role address and a missing `industry` returns each reason and stores
only the good rows, split evenly across two mailboxes; an import into an `active` campaign is
`campaign_active`; a campaign that uses `{{opener}}` rejects a row without one as `missing_field`
and keeps a row with one; an `opener` over 300 characters once trimmed, or with CR or LF, is
`ValidationFailed` at `prospects.<index>.opener` and nothing is stored.

**OS-8. Activation with approval: `outreach.campaign.activate`.** Payload `{ campaignId,
contentDigest, prospectsDigest, prospectCount }`. `APPROVAL_POLICIES` gets
`"outreach.campaign.activate": { request: "outreach", required: true }`, so it runs only
through A-7 after an owner approves; a direct member dispatch is `TenantDenied`.
`POST /v1/outreach/campaigns/:id/activation` (Idempotency-Key) computes the payload and runs
`approval.request` as the caller with a summary naming the campaign, the prospect count, the
mailboxes, the window, the cap and step 1's subject, and answers `{ approvalId }`. The handler
locks the campaign row and refuses with `Conflict` and `details.reason`:
`campaign_not_activatable` (status not `draft` or `paused`), `campaign_changed` (either digest
or the count differs from now: `prospectsDigest` = SHA-256 of the sorted `id:status` of the
campaign's `pending` and `active` prospects), `no_prospects`, `mailbox_unavailable` (a
campaign mailbox not `active`), `time_zone_missing` (`business_profiles.time_zone` null), or an
OS-6 reason. Otherwise it sets the campaign `active`, `activation_approval_id`, `activated_at`;
every `pending` prospect becomes `active` with `next_step` 1 and `next_due_on` = today in the
tenant zone. Resume is the same action from `paused`: `active` prospects keep their schedule.
Event `outreach.campaign.activated`. Activation does not need `OUTREACH_SEND_ENABLED` (OS-10).
Test: direct dispatch is `TenantDenied`; request, approve and run -> `active`; an import
between request and approval makes the run `campaign_changed`; each refusal reason above.

**OS-9. Pause and stop.** `outreach.campaign.pause` (`{ campaignId }`, direct, no approval)
sets an `active` campaign `paused` with `paused_reason` `owner`; pausing a paused campaign
answers it as it is. `outreach.prospect.stop` (`{ prospectId }`) sets a `pending` or
`active` prospect `stopped`. Neither touches `outreach_sends`: the pre-send check (OS-14)
finds the new state. Revoking the activation approval (A-8) stops sending as well (OS-14).
Events `outreach.campaign.paused`, `outreach.prospect.stopped`.
Test: pause between two ticks -> the second tick sends nothing; resume needs a new approval;
stop one prospect -> it gets no further step while others continue.

**OS-10. Sending is off by default.** The worker sends only when its injected config has
`sendEnabled: true`, which `apps/api/src/outreach/config.ts` sets only when
`OUTREACH_SEND_ENABLED` is exactly the string `true`. With it off the worker still polls
replies and bounces (read-only) and never calls `messages.send`. Real sending therefore needs
the flag, `OUTREACH_WORKER=on`, a cron schedule (OS-13), an allowlisted tenant, a connected
mailbox and an approved, active campaign.
Test: with values unset, `TRUE`, `1`, `yes`, ` true` and `true ` the fake records zero sends
for a due prospect; with `true` it records one.

**OS-11. Schedule.** All dates are local dates in the tenant's `business_profiles.time_zone`,
computed from the injected clock with `booking/time-zone.ts`. Business days are Monday to
Friday. After step k is `sent` on local date D, the prospect's `next_step` becomes k+1 and
`next_due_on` = D plus step k+1's `delayBusinessDays` business days; after the last step the
prospect is `completed`. A prospect is due when the campaign is `active`, the prospect is
`active`, `next_due_on` <= today, today is a business day, and now is in
`[window.start, window.end)` local time. A step delayed by caps or a pause sends at the next
open window; later delays count from the real send date. Due prospects of one mailbox are
taken in order: follow-ups before step 1, then `next_due_on`, then prospect id.
Test (`business-days.test.ts`): Friday + 1 = Monday; +3 from Wednesday = Monday; a window
across the US daylight-saving change uses local time; 10:30 exactly is outside; Saturday sends
nothing.

**OS-12. Caps, warm-up and pacing.** The mailbox cap is `min(mailbox.daily_limit,
OUTREACH_MAILBOX_DAILY_LIMIT)` (default 20, 1..50), lowered by the warm-up ramp: with
`first` = the earliest `local_send_date` of a counted send of that mailbox (today when it has
none), `warmupCap(first, today, cap)` (`schedule.ts`) is `min(cap, 5 + 5 * floor(days / 7))`
where `days` = whole local days from `first` to `today`. A mailbox sends at most that many
emails across all campaigns, and at most `min(campaign.dailyCapPerMailbox, that)` for one
campaign, per local day. The start, the step and the period (5, 5, 7) are worker config, so
tests can change them; the defaults are the contract. Sends
count when their status is `sending`, `sent`, `uncertain` or `lost` and their `local_send_date`
is today. A mailbox sends at most `OUTREACH_SENDS_PER_TICK` (default 1, 1..5) emails per run
and never sooner than `OUTREACH_MIN_GAP_MS` (default 240,000) after its last attempt, which
spreads 20 sends over a 150-minute window when the cron runs every 5 minutes. Counting happens
under the mailbox lease (OS-13), so two runs cannot both take the last slot.
Test (`schedule.test.ts`): `warmupCap` is 5 on day 0 to 6, 10 on day 7, 15 on day 14, 20 on
day 21 and never above the cap, and it rejects a `today` before `first`. Test (worker): a
mailbox with a first send 28 days ago, 25 due prospects, cap 20, ticks every 5 minutes through
the window -> 20 sends, none closer than the gap; a mailbox on its first day sends 5; two
concurrent ticks at cap minus one -> exactly one send.

**OS-13. The worker run.** `GET /cron/outreach` in the workers Vercel project
(`apps/api/src/vercel-outreach.ts`, entry in `build-vercel.mjs` with `OUTREACH_CRON_SCHEDULE`,
which joins `CRON_SCHEDULE_VARIABLES`), guarded like the other crons (`guardCronEntry`,
`CRON_SECRET`, kill switch `OUTREACH_WORKER=on`, alerts). No schedule is set by default. A run
(service role, `OUTREACH_DATABASE_URL`) leases mailboxes: one `UPDATE … WHERE (tenant_id, id)
IN (SELECT … FOR UPDATE SKIP LOCKED)` sets `lease_token` and `lease_expires_at` = now + 60 s on
`active` mailboxes of allowlisted tenants whose lease is free or expired. Every later write for
that mailbox checks the token; a run that lost it writes nothing. Per leased mailbox, in this
order: mint an access token (OS-21); settle open attempts (OS-16); poll inbound (OS-19); send
(OS-14, OS-15) when `sendEnabled`; release the lease. The run stops starting Gmail calls when
`OUTREACH_RUN_BUDGET_MS` (default 20,000, at most 20,000; Vercel stops the function at 30 s)
has passed, and each call's timeout is bounded by the time left. The worker marks a campaign
`completed` when it has no `pending` or `active` prospect left.
Test: two runs started together lease disjoint mailboxes; a run whose lease expired mid-way
writes nothing after; a budget of 1 ms makes no Gmail call; the entry refuses a budget over
20 s.

**OS-14. Pre-send check.** For each candidate the worker runs one transaction that locks the
prospect and re-reads every fact; any failure sends nothing:
1. config `sendEnabled`, tenant allowlisted, mailbox lease still held, mailbox `active` and
   `paused_until` passed;
2. campaign `active`; its `activation_approval_id` approval not `revoked` (A-8). Expiry of
   that approval is ignored: it was consumed when the activation committed;
3. prospect `active`, `next_step` = k, due (OS-11), caps (OS-12);
4. OS-6 address check, else the campaign pauses with that reason;
5. a `suppressions` row of any reason for the address: the prospect stops `unsubscribed`
   (reason `unsubscribe` or `marketing_unsubscribe`), `bounced` (`bounce`) or `suppressed`
   (any other);
6. `hardSuppressionHit` on the prospect: stops `hard_suppressed`;
7. a CRM contact with the address and email consent `denied`: stops `consent_denied`;
8. the rendered subject has no CR or LF and the body no unreplaced variable.
Then, outside the transaction, for k >= 2: `threads.get(thread_id, format=metadata)`; any
message that OS-19 classifies as a reply, owner reply or bounce stops the prospect instead of
sending, and a thread Gmail no longer has (404) stops it `thread_unavailable`. A follow-up
also needs the previous step's `rfc_message_id`; when it is missing the worker reads it
(`messages.get` metadata) and, if it still cannot, skips the prospect this run; after 24 hours
without it the prospect stops `thread_unavailable`.
Test: one case per numbered check, each with zero fake sends and the stated prospect status;
a reply placed in the fake thread just before step 2 stops the prospect with no send.

**OS-15. The send record and at-most-once.** In the transaction of OS-14 the worker inserts
`outreach_sends` with status `sending`, `attempt_started_at`, `local_send_date`,
`recipient_address`, the rendered subject and body (footer and unsubscribe URL included),
`history_id_before` (the mailbox's current history cursor) and a fresh id, and commits. A
partial unique index allows one row per (`tenant_id`, `prospect_id`, `step_number`) with
status `sending`, `sent`, `uncertain` or `lost`, so no second attempt of a step can start.
Then one `messages.send` (with `threadId` for k >= 2). Then one settling transaction (lease
checked):
- accepted: `sent`, `gmail_message_id`, `gmail_thread_id`, then a best-effort
  `messages.get` for `Message-ID` into `rfc_message_id`; step 1 stores the thread id on the
  prospect; the schedule advances (OS-11); `last_send_at` on the mailbox;
- 400: `rejected`, the prospect stops `invalid_address`;
- 429, or 403 `rateLimitExceeded` / `userRateLimitExceeded`: `not_sent`, mailbox
  `paused_until` now + 15 minutes; 403 `dailyLimitExceeded`: `not_sent`, `paused_until` the
  next local midnight, report `outreach_gmail_daily_limit`;
- 401 after a fresh token, 403 `insufficientPermissions`: `not_sent`, mailbox `reauthorize`;
- network error, timeout, 5xx, or any thrown error: `uncertain` (OS-16).
`not_sent` and `rejected` rows are outside the unique index, so a `not_sent` step can be tried
again later as a new row. Error codes are stored cut to 100 characters; no response body is
stored or logged.
Test: two concurrent runs and a crash after commit and before the call each end with at most
one fake send per step; a 429 leaves the step retryable and it sends once on a later run; a
400 stops the prospect.

**OS-16. Unknown outcome.** A `sending` row whose mailbox lease has expired (the run crashed)
counts as `uncertain`. At the next run, once `attempt_started_at` is at least
`OUTREACH_PROBE_DELAY_MS` (default 120,000) old, the worker pages `history.list` from the
row's `history_id_before` and reads (`messages.get` metadata, header `X-Zs-Ref`) each added
message labelled `SENT`. A message whose `X-Zs-Ref` equals the send id settles the row `sent`
as OS-15 does. When the history is read to its end without a match, or answers 404, or
`history_id_before` is null, the row becomes `lost` and the prospect stops
`send_outcome_unknown`, reported to the operator. A `lost` step is never sent again.
Test: the fake accepts the message and then times out -> the probe finds it, `sent`, schedule
advances, one fake send; the fake times out before accepting -> `lost`, prospect stopped, no
second send; an expired history start -> `lost`.

**OS-17. The message.** `buildRawMessage` (`mime.ts`) writes CRLF lines: `From: "<display
name>" <mailbox>`, `To: <prospect address>`, `Subject` (RFC 2047 encoded-word when not
ASCII), `Date` from the injected clock, `MIME-Version: 1.0`, `Content-Type: text/plain;
charset="UTF-8"`, `Content-Transfer-Encoding: quoted-printable`, `List-Unsubscribe:
<URL>`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, `X-Zs-Ref: <send id>`, and for
k >= 2 `In-Reply-To: <previous rfc_message_id>` and `References:` all earlier steps'
`rfc_message_id` in order. Every header value is refused when it holds CR, LF or NUL; the
display name also refuses `"`, `<` and `>`. The output is base64url without padding.
Test: snapshot of a step 1 and a step 3 message; a header injection attempt in each field
throws; a non-ASCII subject round-trips through a decoder.

**OS-18. Unsubscribe through the hub.** The unsubscribe URL is
`<DELIVERY_UNSUBSCRIBE_BASE_URL>/<token>` with `signUnsubscribeToken(UNSUBSCRIBE_TOKEN_SECRET,
{ tenantId, deliveryId: sendId })`, unchanged token format. `createUnsubscribeSession`'s
`resolve` (`edge/delivery-session.ts`) looks up `message_deliveries` first and, when no row
matches, `outreach_sends` (`recipient_address` of that id in the token's tenant). The POST
records the existing `suppression.record` with reason `unsubscribe` and source
`outreach:<sendId>` under the existing key `unsubscribe:<id>`; the GET, the rate limits and
the pages are unchanged. Delivery's own behaviour is unchanged.
Test (`packages/core/test/outreach/unsubscribe.test.ts`): the token from a sent outreach body
suppresses that address; the next run stops the prospect `unsubscribed` with no send; a token
for tenant A's send used against tenant B's data is `NotFound`; an existing delivery token
still works.

**OS-19. Replies and bounces.** Each run, per mailbox, the worker pages `history.list`
(`messageAdded`) from `history_id` and stores the new cursor after the batch; with no cursor or
on 404 it stores `getProfile().historyId` and reports `outreach_history_reset` (in-thread
replies are still caught by OS-14). For each added message not sent by this system (its id is
not a `gmail_message_id` of ours) it reads headers with `messages.get` metadata and classifies:
- **bounce**: `From` local part `mailer-daemon` or `postmaster`, or an `X-Failed-Recipients`
  header, or `Content-Type: multipart/report; report-type=delivery-status`. The prospect is the
  one whose thread it joined, else the prospect of this mailbox whose address
  `X-Failed-Recipients` names;
- **auto reply**: `Auto-Submitted` present and not `no`. Recorded, never stops (out-of-office);
- **owner reply**: labelled `SENT` in a prospect's thread: the owner took over; stops
  `owner_replied`;
- **reply**: any other message in a prospect's thread, or from a prospect's address of this
  mailbox in any thread (a reply in a new thread), whoever wrote it.
A bounce stops the prospect `bounced` and records `suppression.record` with reason `bounce`,
source `outreach-bounce:<gmail message id>`, through `directDispatch` with the principal
`derivedId(tenantId, "outreach", "actor")` limited to that action, under the reserved key
`outreach:bounce:<mailboxId>:<gmail message id>`. A reply stops it `replied`. Each matched
message writes one `outreach_inbound_events` row (unique per mailbox and Gmail message id), so
a repeat changes nothing; an unmatched message leaves no row and its headers are never logged.
Only the matched prospect's own status changes; other prospects at the same company continue.
Test (`classify.test.ts` and the worker test): a reply in the thread, a reply in a new thread,
a bounce in the thread, a bounce outside it with `X-Failed-Recipients`, an out-of-office and an
owner reply each give the stated outcome; the bounce writes one `bounce` suppression; running
the same history twice writes nothing new.

**OS-20. Bounce-rate pause.** After each recorded bounce, and after each send, the worker
compares the campaign's `bounced` prospects with its `sent` rows. With at least 40 `sent` rows
and bounces at 5 % or more, it pauses the campaign with `paused_reason` `bounce_rate` and
reports `outreach_bounce_rate` to the operator. Only a new approval resumes it (OS-8).
Test: 39 sent with 2 bounces -> active; the 40th send with 2 bounces -> paused and the next
run sends nothing; 40 sent with 1 bounce -> active.

**OS-21. Tokens and secrets.** `OUTREACH_TOKEN_PRIVATE_KEY` (X25519, PKCS#8 base64, its own
pair, not the calendar's) is worker-only: it joins `WORKER_ONLY_ENV` with
`OUTREACH_WORKER`, `OUTREACH_DATABASE_URL`, `OUTREACH_GOOGLE_CLIENT_SECRET`,
`OUTREACH_SEND_ENABLED`, the tuning variables and `OUTREACH_CRON_SCHEDULE`, and
`apps/api/test/worker-split.test.ts` fails if the API bundle names any of them. The API reads
only `OUTREACH_TENANTS`. The worker opens a sealed token per run, mints an access token with
`createGoogleClient({ clientId, clientSecret, scopes })` and keeps both in memory for that run
only; no table, log line, error, report or response ever holds a refresh or access token.
`GmailPort` (`gmail-port.ts`): `send`, `getMessageHeaders`, `getThreadHeaders`,
`listHistory`, `getProfile`, each taking an access token and an `AbortSignal`;
`GmailRequestFailed { code, status, retry }` as `GoogleRequestFailed`. `createGmailClient`
(`gmail.ts`) implements it over an injected `fetch` with base URL
`OUTREACH_GMAIL_BASE_URL` (default `https://gmail.googleapis.com`), reading at most 1 MiB per
answer.
Test: a captured-log grep for the fake refresh and access tokens finds nothing; the
worker-split test covers the new names; the adapter test (stubbed `fetch`) checks each call's
method, path, query and the error mapping of OS-15.

**OS-22. Routes and MCP.** Owner routes (`apps/api/src/routes/outreach.ts`, session
`packages/core/src/edge/outreach-session.ts`, writes need `Idempotency-Key`):
`POST /v1/outreach/campaigns`, `POST /v1/outreach/campaigns/:id/prospects`,
`POST /v1/outreach/campaigns/:id/activation` (answers `{ approvalId }`),
`POST /v1/outreach/campaigns/:id/pause`, `POST /v1/outreach/prospects/:id/stop`,
`GET /v1/outreach/campaigns`, `GET /v1/outreach/campaigns/:id` (settings, steps, counts by
prospect status, today's sends per mailbox), `GET /v1/outreach/campaigns/:id/prospects`
(keyset cursor, optional `status`, at most 200), `GET /v1/outreach/mailboxes` (address, name,
status, `paused_until`, today's count; never a token or the history cursor). The owner approves
through the existing `POST /v1/approvals/:id/approve`. MCP tools (thin, same session):
`create_outreach_campaign`, `import_outreach_prospects`, `request_outreach_activation`,
`pause_outreach_campaign`, `stop_outreach_prospect`, `list_outreach_campaigns`,
`get_outreach_campaign`. No tool approves.
Test (`apps/api/test/outreach-api.test.ts`, `packages/mcp/test/server.test.ts`): each route
and tool round-trips; a missing key is 400; staff 403; another tenant's id 404.

**OS-23. Errors.** Tenants see only the codes in `OUTREACH_ERROR_CODES`
(`packages/contracts/src/outreach.ts`): the OS-7 row reasons, the OS-8 refusal reasons,
`campaign_active`, `unknown_variable`. Worker-side Gmail codes reach the owner only as a
prospect status, a campaign `paused_reason` or a mailbox status; detail goes to the operator
report, cut to 200 characters.
Test: every code a test provokes is in the list; a Gmail error body never appears in a
response.

**OS-24. Tenancy and grants.** `outreach_mailboxes`, `outreach_campaigns`,
`outreach_campaign_steps`, `outreach_campaign_mailboxes`, `outreach_prospects`,
`outreach_sends` and `outreach_inbound_events` have `tenant_id`, a tenant FK, every
relationship keyed with `tenant_id`, forced RLS with the `tenant_scope` policy, and appear in
the catalog isolation suite (`packages/db/test/isolation.test.ts`; `seedTenantTables` must be
able to seed them). Runtime role grants: `SELECT` on all of them except the column
`outreach_mailboxes.sealed_refresh_token`; `INSERT` on mailboxes, campaigns, steps, campaign
mailboxes and prospects; `UPDATE` only of `outreach_mailboxes (status, sealed_refresh_token,
display_name, daily_limit, updated_at)`, `outreach_campaigns (status, paused_reason,
activation_approval_id, activated_at, updated_at)` and `outreach_prospects (status, next_step,
next_due_on, stopped_at, updated_at)`; nothing on sends and inbound events. A trigger refuses a
runtime-role mailbox status change other than to `active` or `disconnected`. The worker names
`tenant_id` in every statement.
Test (`packages/db/test/outreach.test.ts`, runtime role): tenant A cannot read or write any of
tenant B's rows in the seven tables; the runtime role cannot read `sealed_refresh_token`,
cannot update steps, sends or inbound events, and cannot set a mailbox `reauthorize`.

**OS-25. No real Gmail in tests.** `FakeGmail` (`fake-gmail.ts`) keeps mailboxes, threads,
history ids and messages in memory, records every `send` with its decoded headers and body,
and plays scripted outcomes per call: accept, 400, 401, 403 with a reason, 429, 500, timeout
before accepting, timeout after accepting, history 404; tests add inbound messages (reply,
bounce, out-of-office) to a thread or a new thread. A vitest setup file in `packages/core` and
`apps/api` replaces the global `fetch` for hosts ending `googleapis.com` or `google.com` with
one that throws `real_google_call_in_test`; adapter tests pass their own stubbed `fetch`. CI
and tests hold no Google client, key or token.
Test: a test that calls the real `createGmailClient` without an injected `fetch` throws
`real_google_call_in_test`.

## Tables (migration `supabase/migrations/20261109100000_outreach_sequencer.sql`)

Every table: `tenant_id uuid NOT NULL REFERENCES tenants`, primary key starting with
`tenant_id`, forced RLS, policy `tenant_scope` for `authenticated`, grants as OS-24, times as
`timestamptz` written from the injected clock. Text columns pass the repo's Postgres text
check.

| Table | Columns (beyond `tenant_id`) | Keys and checks |
|---|---|---|
| `outreach_mailboxes` | `id`, `email`, `display_name`, `status`, `sealed_refresh_token`, `granted_scopes`, `daily_limit`, `history_id`, `history_checked_at`, `paused_until`, `pause_reason`, `lease_token`, `lease_expires_at`, `last_send_at`, `connected_by`, `created_at`, `updated_at` | PK (`tenant_id`, `id`); unique (`tenant_id`, `email`); `email` lower case <= 254; `status` in `active`, `reauthorize`, `disconnected`; token matches the `zsg1` pattern or is null, null when `disconnected`; `daily_limit` 1..50 |
| `outreach_campaigns` | `id`, `name`, `status`, `paused_reason`, `window_start_min`, `window_end_min`, `daily_cap_per_mailbox`, `content_digest`, `activation_approval_id`, `activated_at`, `created_by`, `created_at`, `updated_at` | PK; `status` in `draft`, `active`, `paused`, `completed`; window minutes 0..1439, end - start >= 30; cap 1..50; digest 64 hex |
| `outreach_campaign_steps` | `campaign_id`, `step_number`, `delay_business_days`, `subject`, `body` | PK (`tenant_id`, `campaign_id`, `step_number`); FK campaign; step 1: subject not null, delay 0; others: subject null, delay 1..30; step 1..5 |
| `outreach_campaign_mailboxes` | `campaign_id`, `mailbox_id` | PK of all three; FKs to campaign and mailbox |
| `outreach_prospects` | `id`, `campaign_id`, `mailbox_id`, `email`, `first_name`, `last_name`, `company`, `industry`, `opener`, `website`, `status`, `next_step`, `next_due_on` (date), `thread_id`, `stopped_at`, `created_at`, `updated_at` | PK; unique (`tenant_id`, `email`); `opener` null or 1..300 characters with no CR or LF and not blank; FK (`tenant_id`, `campaign_id`, `mailbox_id`) to `outreach_campaign_mailboxes`; `status` in `pending`, `excluded`, `active`, `completed`, `replied`, `owner_replied`, `bounced`, `unsubscribed`, `suppressed`, `hard_suppressed`, `consent_denied`, `invalid_address`, `send_outcome_unknown`, `thread_unavailable`, `stopped`; index (`tenant_id`, `mailbox_id`, `status`, `next_due_on`) |
| `outreach_sends` | `id`, `campaign_id`, `prospect_id`, `mailbox_id`, `step_number`, `status`, `recipient_address`, `subject`, `body`, `local_send_date`, `attempt_started_at`, `settled_at`, `history_id_before`, `gmail_message_id`, `gmail_thread_id`, `rfc_message_id`, `error_code`, `created_at`, `updated_at` | PK; FKs to prospect and mailbox; `status` in `sending`, `sent`, `uncertain`, `lost`, `not_sent`, `rejected`; partial unique (`tenant_id`, `prospect_id`, `step_number`) where status in `sending`, `sent`, `uncertain`, `lost`; index (`tenant_id`, `mailbox_id`, `local_send_date`); unique (`tenant_id`, `mailbox_id`, `gmail_message_id`) where not null |
| `outreach_inbound_events` | `id`, `mailbox_id`, `gmail_message_id`, `gmail_thread_id`, `prospect_id`, `kind`, `received_at`, `recorded_at` | PK; unique (`tenant_id`, `mailbox_id`, `gmail_message_id`); `kind` in `reply`, `owner_reply`, `bounce`, `auto_reply` |

No change to `suppressions`, `message_deliveries` or the wallet. No Drizzle model unless the
drift test asks for one (enrichment's tables have none).

## Module layout

- `packages/contracts/src/outreach.ts`: command, payload, result and read schemas, action type
  constants, `OUTREACH_ERROR_CODES`; `members.ts` gains `outreach`; `http.ts`
  `SERVER_IDEMPOTENCY_PREFIXES` gains `outreach:`.
- `packages/core/src/outreach/`: `hard-suppression.ts` (exists), `templates.ts` (OS-5, OS-6
  footer, placeholder checks, digests), `schedule.ts` (OS-11 business days and window),
  `mime.ts` (OS-17), `classify.ts` (OS-19), `gmail-port.ts`, `gmail.ts`, `fake-gmail.ts`
  (OS-21, OS-25), `handlers.ts` (OS-3, OS-4, OS-7, OS-8, OS-9 actions), `reads.ts` (OS-22),
  `worker.ts` (OS-12..OS-16, OS-19, OS-20), `index.ts` exports.
- `packages/core/src/edge/outreach-session.ts` (owner session, activation request),
  `edge/session.ts` (`ACTION_PERMISSIONS` entries for the five owner actions),
  `approvals/policy.ts` (OS-8 entry), `edge/delivery-session.ts` (OS-18),
  `calendar/google.ts` (optional `scopes`, `loginHint`, `hostedDomain`).
- `apps/api/src/routes/outreach.ts`, `apps/api/src/outreach/{config,runner,start}.ts`,
  `apps/api/src/outreach/connect-mailbox.ts` and `src/scripts/outreach-connect-mailbox.ts`
  (OS-2), `apps/api/src/vercel-outreach.ts`, `scripts/build-vercel.mjs` and
  `scripts/worker-env.mjs` entries, README env table rows, `package.json` script
  `outreach:connect-mailbox`.
- `packages/mcp/src/server.ts`: the OS-22 tools.
- Tests: `packages/core/test/outreach/{templates,schedule,mime,classify,gmail-adapter,actions,worker,unsubscribe,acceptance}.test.ts`,
  `packages/db/test/outreach.test.ts`, `apps/api/test/{outreach-api,outreach-runner,outreach-connect,worker-split}.test.ts`,
  `packages/mcp/test/server.test.ts`.
- Docs: `docs/integrations.md` (decision row; the Gmail line now names this contract),
  `apps/api/README.md` (variables, Mac setup below).

## Configuration and setup the repo owner runs

Workers project: `OUTREACH_WORKER=on`, `OUTREACH_DATABASE_URL` (a login that may `SET ROLE
service_role`), `OUTREACH_TENANTS`, `OUTREACH_GOOGLE_CLIENT_ID`, `OUTREACH_GOOGLE_CLIENT_SECRET`,
`OUTREACH_TOKEN_PRIVATE_KEY`, `OUTREACH_SEND_ENABLED` (leave unset until launch),
`UNSUBSCRIBE_TOKEN_SECRET` and `DELIVERY_UNSUBSCRIBE_BASE_URL` (already there), optional
`OUTREACH_MAILBOX_DAILY_LIMIT`, `OUTREACH_SENDS_PER_TICK`, `OUTREACH_MIN_GAP_MS`,
`OUTREACH_PROBE_DELAY_MS`, `OUTREACH_RUN_BUDGET_MS`; build variable `OUTREACH_CRON_SCHEDULE`
(for example `*/5 * * * *`). API project: `OUTREACH_TENANTS` only. Tests:
`OUTREACH_GMAIL_BASE_URL`, `GOOGLE_TOKEN_BASE_URL`.

Setup (Devin, once the Workspace exists; no agent does account or DNS work):
1. In the Workspace admin: SPF, DKIM (generated in the admin console) and DMARC for
   `zerosum-solutions.com`; keep "trust internal apps" on.
2. A Google Cloud project owned by the Workspace organisation: enable the Gmail API; consent
   screen user type Internal with the two scopes; one OAuth client of type Desktop. Store the
   client id and secret in ZS Vault.
3. `generateSealKeyPair()` once: the public key for the Mac command, the private key on the
   workers project only, both in ZS Vault.
4. Set the business profile's postal address and time zone (`America/Los_Angeles`) for the
   hub tenant.
5. Run OS-2 for each mailbox, signed in as that mailbox in EGO Lite.

## First slice (one PR)

OS-1 to OS-25 with the migration. Nothing is scheduled and `OUTREACH_SEND_ENABLED` stays unset
in every deployed environment until Devin launches.

Acceptance test (`packages/core/test/outreach/acceptance.test.ts`, real Postgres, `FakeGmail`,
injected clock in `America/Los_Angeles`): tenant A (allowlisted, real postal address) has two
connected mailboxes. The owner creates a three-step campaign (delays 0, 3, 5; window 08:00 to
10:30; cap 2) and imports six prospects: four good, one with a hard-suppressed company, one
already suppressed. Two are rejected with their reasons; four split 2/2. Activation by direct
dispatch is `TenantDenied`; request plus approve makes it `active`. With
`OUTREACH_SEND_ENABLED` unset, runs through the window send nothing. With it `true`, runs at
5-minute steps from 07:55 to 10:35 send step 1 to all four (two per mailbox, never before 08:00
or at 10:30, at most one per mailbox per run, two concurrent runs never double-send); each sent
message has the footer with the address, a working unsubscribe URL and the two
`List-Unsubscribe` headers. Three business days later step 2 goes in the same thread with
`Re: ` subject, `In-Reply-To` and `References`, except for prospect 2, who replied in the
thread, and prospect 3, whose step 1 bounced (one `bounce` suppression). Prospect 4 clicks
unsubscribe after step 2 and gets no step 3; prospect 1 gets step 3 and is `completed`; the
campaign is `completed`. A timeout after acceptance on one send settles `sent` by probe with
one fake send. Tenant B reads none of tenant A's rows and its owner gets 404 on every route.
The fake recorded exactly the expected sends and nothing reached Google.

## Build order

1. Contracts: `outreach.ts`, the `outreach` permission, the `outreach:` prefix, error codes.
2. Migration and `packages/db/test/outreach.test.ts` (grants, RLS, two-tenant denial, catalog
   seeding).
3. Pure modules with unit tests: `templates.ts`, `schedule.ts`, `mime.ts`, `classify.ts`.
4. `gmail-port.ts`, `gmail.ts` (stubbed `fetch`), `fake-gmail.ts`, the fetch guard, and the
   `scopes`/`loginHint`/`hostedDomain` options in `calendar/google.ts` (calendar tests stay
   green).
5. Actions and the owner session: create, import, activate (approval policy), pause, stop,
   mailbox connect and disconnect; `ACTION_PERMISSIONS`.
6. Unsubscribe resolve extension (OS-18).
7. Worker: leases, settle and probe, inbound poll, pre-send check, send, bounce suppression,
   bounce-rate pause, completion.
8. API: routes, config, cron entry, `build-vercel.mjs`, `worker-env.mjs`, worker-split test,
   README.
9. Operator command `outreach:connect-mailbox` and its test.
10. MCP tools.
11. Acceptance test; `docs/integrations.md`; set this file's status to built.

## Known limits

- At most once, not exactly once: a send whose outcome the probe cannot confirm stops that
  prospect (`send_outcome_unknown`) rather than risk a duplicate (OS-16).
- That the Gmail API keeps our `X-Zs-Ref` header, returns the sent `Message-ID` through
  `gmail.metadata`, and that Workspace DKIM signs `List-Unsubscribe` are unverified until the
  first real send; the probe and threading depend on the first two.
- A reply in a new thread is seen only through the history cursor; after a gap longer than
  Gmail keeps history (OS-19 reset) such a reply is missed. In-thread replies are always
  checked before a follow-up.
- A reply that lands between the thread check and the send (seconds) can still get that one
  follow-up.
- Out-of-office detection relies on `Auto-Submitted`; an auto-reply without it stops the
  sequence as a reply.
- No holidays; business days are Monday to Friday in the tenant zone.
- A password change on a mailbox revokes its grant; the mailbox shows `reauthorize` until
  OS-2 runs again.
- The unsubscribe link is on the hub's API domain, not the sending domain.
- One sequence per address per tenant, ever; a second campaign to the same person needs a
  revision.
- The warm-up ramp counts days from the mailbox's first send in this system; a mailbox that
  already sent from elsewhere ramps as new. Two mailboxes at 20 a day give 40
  first-touch-or-follow-up sends a day once warm.
- Replies are read in Gmail; nothing reaches the hub Inbox or CRM yet.
- A reply from another address of the same person (an alias) in a new thread is not matched to
  the prospect (OS-19 matches by thread, then by the prospect's own address).
- The bounce-rate check (OS-20) runs per campaign after each send and once per mailbox per run;
  two mailboxes sending for one campaign in the same instant can overshoot the limit by up to one
  send per mailbox before the pause lands.
- The send decision commits the `sending` row under row and advisory locks (see "As built, review
  fixes"). A change that commits after that point (a revoke, a suppression, a pause) still lets
  that one send go: the window between the commit and `messages.send` is a single request.
- A role address (`postmaster@`, `abuse@`, ...) is refused at import (OS-7), not again at send.
- A response lost after the request was written is treated as `uncertain` only for a timeout or a
  network failure; a Gmail HTTP answer with an unexpected status other than the listed ones is also
  `uncertain`, and nothing finer is tried.
- A tenant without a `tenant_plans` row sends (the plan gate passes it too); fail-closed on a
  missing row is a billing decision, not an outreach one.

## As built (first slice, 2026-11-08)

Where the code differs from the numbered rules above; the rules stay the intent.

- The worker needs a second database login, `OUTREACH_RUNTIME_DATABASE_URL` (an unprivileged
  login), next to `OUTREACH_DATABASE_URL`: the bounce suppression goes through the shared action
  path under RLS, which refuses a service login. The operator command uses the same variable.
- The operator command writes through `createOutreachOperator` (core) and so needs the runtime
  login, not the `db:hosted-*` service login. A forged `state` stops the command before any code
  exchange, so there is no grant to revoke in that case; every failure after the exchange revokes.
- `--disconnect` clears the stored token but does not revoke the grant at Google: the runtime login
  cannot read the sealed token. The command prints a reminder to revoke the app at
  myaccount.google.com/permissions. The worker does not revoke on disconnect either.
- The mailbox cap is `min(mailbox daily limit, OUTREACH_MAILBOX_DAILY_LIMIT)`, then the warm-up
  ramp. Import fields `firstName` and `company` may be empty; `missing_field` applies only when a
  campaign variable uses them.
- Pausing a draft or completed campaign, and stopping a prospect that is not open, answer the
  record as it is. Importing into a `completed` campaign gives `campaign_not_activatable`.
- Only activation can be approved; create, import, pause, stop and the mailbox actions are in
  `NEVER_APPROVED_ACTIONS`. Pause and stop are allowed for read-only agent tokens.
- There is no Node-process worker script: the worker runs from the cron function only.
- The workers project holds 22 functions (the README's earlier count of 21 was already stale).

## As built, review fixes (2026-11-09)

Migration `supabase/migrations/20261109110000_outreach_hardening.sql` (additive: three nullable columns, one
column grant, two invoker triggers). After the Sol, Argon, DeepSeek and Grok review of the first slice.

- **Own mail (OS-19, B1).** A message is `own` only when its `X-Zs-Ref` is the id of one of this mailbox's
  `outreach_sends` and it carries the `SENT` label or the mailbox as sender. A prospect's reply that copies the
  header is still a reply. The content type is parsed with its parameters (quote-aware, any case) and a bounce
  needs `multipart/report` with `report-type=delivery-status`.
- **Send gate (OS-13, B2).** A mailbox sends only when, in this run, settling its open attempts and reading its new
  mail both succeeded and the reader reached the history head. Otherwise the run sends nothing for it.
- **Resumable inbound read (B3).** The reader classifies each history page in order before it reads the next. A run
  that hits `maxHistoryPages` or `maxInboundMessages` keeps the next page token in `history_resume_token` and the
  cursor where it was; the next run resumes from the token. The cap is checked per page, so one page is always read
  whole. The cursor moves only after the last page.
- **History gap (OS-19, B4).** A missing cursor or an expired one moves the cursor to the mailbox head. When the
  mailbox has open prospects with a mailed thread, replies in the gap cannot be recovered, so the mailbox is
  paused with `pause_reason = 'history_gap'` and `paused_until = 9999-12-31`, an `outreach_history_reset` report
  with `paused: true` goes to the operator, and nothing is sent. Reconnecting the mailbox (OS-3) clears the pause;
  the operator is expected to check Gmail for replies first. A mailbox with nothing mailed resets without a pause.
- **Decision point (OS-14, OS-15, B5).** The gate runs in one transaction that also commits the `sending` row. Lock
  order: mailbox lease row, business profile (share), tenant plan (share), campaign (update), the shared advisory
  locks `suppression:<tenant>:email:<address>` and `crm:contact:email:<tenant>:<address>`, the CRM contact row
  (share), the prospect (update), the activation approval (share). The suppression handler takes the first advisory
  lock exclusively; the CRM writers already take the second. A writer that committed first is therefore seen, and a
  writer that comes later waits for the `sending` row. A follow-up runs the gate twice around its Gmail thread
  check. Interleaving tests hold a writer's transaction open against a running worker.
- **Approval (OS-8, OS-24, B6).** The worker sends only for an approval that is `approved`, of action
  `outreach.campaign.activate`, targeting this campaign; otherwise the campaign pauses (`approval_revoked` or
  `approval_invalid`). Two triggers back this for the runtime role: it cannot set a campaign `draft` or `completed`,
  cannot make one `active` (or swap an active campaign's approval) without such an approved approval, and cannot
  move a prospect out of a closed status or reschedule a running one.
- **Open attempts (B7).** The candidate query skips a prospect that already has a `sending`, `sent`, `uncertain` or
  `lost` attempt for its next step; a unique violation on the open-attempt index in the gate is a skip. Candidates
  are taken per campaign (25 each) and interleaved, so one campaign that cannot send does not hide the others.
- **Message-ID wait (OS-14, B8).** The 24 hours count from the first failed lookup, stored in
  `outreach_sends.message_id_first_failed_at`. A lookup answered with 401 or `invalid_grant` ends the mailbox's run
  into `reauthorize`.
- **Budget (OS-13, B9).** When the run budget has passed before `messages.send` is invoked, the `sending` row becomes
  `not_sent` (`out_of_time`), the prospect keeps its step, and the mailbox stops for the run.
- **Bounce rate (OS-20).** The rate is distinct prospects with a `bounce` event over sent rows, checked after each
  send and once per mailbox per run, under the lease. A prospect stopped before any mail by a bounce suppression
  never counts.
- **Rendering (OS-5, OS-6, OS-17).** A rendered subject over 300 characters or a body over 18,000 is refused at
  import (`render_too_long`) and stops the prospect at send time, as does a header value Gmail cannot carry.
- **Time zone (OS-12).** A business with no time zone pauses its campaigns (`time_zone_missing`); there is no UTC
  fallback. A first send date ahead of today (the zone moved west) counts as warm-up day zero.
- **Smaller changes.** `last_attempt_at` rotates mailboxes; `ctx.leased` also requires an `active` mailbox; the
  allowlist is lower-cased once; `outreach.mailbox.disconnect` is allowed for a read-only tenant; the import limit of
  5,000 counts the rows kept; a reconnect refuses a mailbox id other than the stored row's and clears a pause; the
  operator's approval reference is derived from the idempotency key and the store is retried with the same command
  before the fresh grant is revoked; the approval summary cuts each field on its own; a malformed id from a tenant
  outside the allowlist is 404; only the prospect import route takes a body up to 1 MiB; the cron outcome compares
  `stepsFailed` with `stepsSucceeded`; the MCP stdio entry reads `OUTREACH_TENANTS`.

## As built, opener (2026-11-10)

Migration `supabase/migrations/20261110100000_outreach_opener.sql`: one nullable column
`outreach_prospects.opener` with the check above, and the column joins the runtime role's insert grant (the service
role already holds table-level grants). Campaign steps are unchanged, so step immutability and `content_digest`
hold. Revision of OS-5, OS-7; OS-14 is unchanged in text (the render check already stops a prospect whose used
variable is empty).

- **Variable.** `OUTREACH_VARIABLES` gains `opener`. `renderStep` and `missingVariables` take
  `opener: string | null` in `TemplateValues`; the value is inserted in the same single pass as the others and is never
  re-scanned, so an opener holding `{{company}}` renders as those characters. `render_too_long` applies unchanged.
- **Import.** The row schema bounds `opener` to 300 characters with no CR or LF (the schema error names
  `prospects.<index>.opener`); the handler trims it and stores null when it is empty. An `excluded` row stores no opener
  (such a row is checked only for `invalid_email` and `duplicate`). `missing_field` applies when a step uses
  `{{opener}}` and the row has none.
- **Send.** The worker reads `opener` with the other prospect facts and renders with it. A prospect whose opener went
  missing (a direct database edit) stops as the existing render failure does.
- **Reads.** The prospect record gains `opener` (string or null).
- **Existing prospects.** An address that is already a prospect is a `duplicate` and cannot be re-imported to add an
  opener; a campaign that uses `{{opener}}` is created and filled from the start.
- **Replays and limits (review of this revision).** The prospect record parses a stored result without `opener` as
  null, so an idempotent replay of a stop recorded before this change still answers. The dispatcher bounds one
  command to 262,144 characters of text, so an import of 500 rows whose fields are all near their maximum (an opener
  of 300 characters adds up to 150,000) is refused whole with `ValidationFailed`; send it in smaller calls. Lengths are
  counted in UTF-16 units by the contract and in characters by Postgres, so the contract is never the looser side. The
  approval summary (OS-8) shows no opener, as it shows no company or industry: the approved set is pinned by the
  prospects digest and openers cannot change after import, but the owner reads them in the prospect list, not in the
  approval. The mail header encoder now encodes subject text that holds `=?`, so a value that looks like an encoded
  word reaches the recipient as typed.
