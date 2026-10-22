# M6: agents (inquiry follow-up and agent kinds)

Status: contract for M6 (2026-10-20), revision 4 (2026-10-22). Code follows this file; a change to a
numbered rule needs a new revision of this file first. Revision 2 (2026-10-22 audit, B5-01,
B5-02): G-8 adds the skip reason `superseded`, for an inquiry the customer followed with a newer
request before its draft committed (the draft action re-checks G-7's latest-request condition
under the customer's row lock), and G-10 names the database guard that keeps closed runs as
they are. Revision 3 (2026-10-22 audit B3, review round 2): G-4 and G-5 read the draft's time
after its locks. Revision 4 (2026-10-22, phase 2 specs): adds G-14..G-21, which are not built
yet: agent kinds, usage and daily cost caps, `stalled` runs, an abort signal and usage on the
model port, real model adapters per lane, templated reminder and review kinds under a standing
template approval (`approvals.md` A-15), and a document intake kind. G-1..G-13 are unchanged,
and so are `agent_followups` and the M6 tests; where a new rule replaces part of an old one
(G-9's port, G-13's `FOLLOWUP_MODEL`), it says so and takes effect when it is built.

Scope: one agent. It finds website inquiries nobody has answered, asks a model port for a
follow-up email, and leaves it in the Inbox as a draft with a pending send proposal. An owner
reads it and approves, edits by discarding and redrafting, or discards it. The agent never
approves and never sends. Caps, quiet hours and two kill switches bound what it may draft; every
run and every decision it makes is recorded. Revision 4 adds three more agent kinds on the same
tables, switches and records (G-14): appointment reminders and review requests sent from an
owner-approved template, and document intake proposals for an owner to approve.

Out of scope: SMS follow-ups by the inquiry agent, a vision lane, an agent org chart or
agent-to-agent delegation, billing model usage to the wallet. The scheduler that runs the agent
on a timer is G-13. Revision 4 adds three more kinds and real model adapters (G-14..G-21).

## Evidence and decisions

- Plan (approved 2026-10-18): "M6 one inquiry follow-up agent with approval, caps and kill
  switch".
- Inbox (`inbox-home.md` I-1, I-5..I-7): a reply is fixed once drafted, its send is the action
  `inbox.reply.send` that only runs under an owner's stored approval. The agent writes the same
  `inbox_replies` row and the same `approvals` proposal a member draft does, so the owner's
  existing approve, discard and delivery path handles agent drafts unchanged.
- Approvals (`approvals.md` A-5..A-9): a proposal records `requested_by`; only `approve`
  decides; the decider runs the send. The agent's proposal names the agent as requester.
- Delivery (`delivery.md` D-6, D-9): consent and suppression are re-checked at delivery. The
  agent checks them before drafting too, so a person who opted out is never written to and
  their details never reach the model.
- Public intake (`public-intake.md` P-3): a server-built principal per tenant runs through the
  shared dispatcher with its own `authorize`. The agent uses the same pattern.
- Revision 4 input: `docs/integrations.md` ("Agent kinds and real model", "Model lanes for
  tenant work") and the 2026-10-22 research on agent kinds, checked against the repo:
  `agent_settings` is keyed by `tenant_id` alone and `agent_runs.agent` allows only
  `'inquiry_followup'` (`supabase/migrations/20261020800000_followup_agent.sql:8,54`); the port
  is `FollowUpModel.draft(prompt)` with no signal or usage (`packages/core/src/agents/model.ts:8`);
  `FOLLOWUP_MODEL` accepts only `fake` (`apps/api/src/followup/config.ts:23`). Bookings have only
  the status `confirmed` (`booking.md` B-24), and contact consent is per channel with no purpose
  (`crm.md` C-9); intake grants carry the purpose `marketing_updates` (`public-intake.md` P-8).
- Paperclip is ideas only, decided 2026-10-22 (supervisor brief): not the client
  runtime, no agent org chart, no ported code. Its ideas (a cost ledger, a budget with a warning
  level and a hard stop, run events, a watchdog for silent runs) are written fresh here.
- Model lanes, decided 2026-10-22 (coordinator, standing approval), as `docs/integrations.md`
  "Model lanes for tenant work": client personal data never goes to DeepSeek. Text that may hold
  personal data uses Cerebras; DeepSeek Flash only serves work with no personal data; the
  personal Gemini key is never used for client production traffic; vision has no approved lane
  yet, so any work that needs vision waits (Known limits). G-18 enforces this.
- Standing approval for reminder templates, decided 2026-10-22 (coordinator, standing
  approval): an owner approves a template revision once; every send from it still goes through
  the outbox with consent and suppression checks; any change to the template (wording,
  variables, channel, timing) creates a new revision that needs approval again, and the old
  approval no longer covers sends. Written as `approvals.md` A-15; G-19 and G-20 use it.
- Review requests need `marketing_updates` (marketing) consent, decided 2026-10-22 (supervisor
  brief). G-20.

## Numbered rules

**G-1. The agent principal.** Each tenant has one agent actor,
`agentActorId(tenantId) = derivedId(tenantId, "followup-agent", "actor")`. It is no member and
holds no permission. Its `authorize` admits only the four agent actions (G-6); every other
action, `approval.approve` and `inbox.reply.send` included, is `TenantDenied`. Member sessions
cannot run the agent actions (no `ACTION_PERMISSIONS` entry). The agent's server-built keys
start `agent:`, which joins `SERVER_IDEMPOTENCY_PREFIXES`.

**G-2. Settings.** `agent_settings`, one row per tenant, holds `enabled` (default off), the
caps (G-4), quiet hours (G-5), the time zone, the per-tenant kill switch (`killed_at`,
`killed_by`, `kill_note`), `revision`, `updated_by` and `updated_at`. A tenant without a row
reads as the defaults with the agent off. Owners change settings with `agent.settings.update`
(permission `agents`, owners only) under compare-and-set on `revision` (409 `stale_revision`
with `currentRevision`).

**G-3. Kill switches.** The agent may draft only while all of these hold:
- the global switch (`agent_global_switch`, one row, written only by the service role) is not
  killed;
- the tenant's row has `enabled = true`;
- the tenant's kill switch is not engaged (`killed_at` null).
`agent.kill` engages the tenant switch (permission `inbox.drafts`, so staff can stop it too);
`agent.resume` clears it (permission `agents`, owners only). The draft action locks the
tenant's settings row `FOR UPDATE`, and takes a shared transaction advisory lock for the global
switch, before it checks them. A tenant kill writes that row and a global flip takes the
advisory lock exclusively, so a kill that commits stops every draft that commits after it: no
new draft appears once `kill` has answered. A draft already committed stays a draft; it still
needs an owner's approval to send.

**G-4. Caps.** In the draft action's transaction, after the locks of G-3:
- `maxDraftsPerDay` (1..200, default 10): agent drafts in the tenant in the 24 hours before now;
- `maxDraftsPerContact` (1..10, default 1) in `contactWindowHours` (1..2160, default 168):
  agent drafts for that customer in that window;
- one agent draft per inquiry, ever (a unique index backs it).
Because every draft for a tenant holds the settings row lock while it counts and inserts,
concurrent runs cannot exceed a cap. The draft reads its time after the locks. The counts have
no upper time bound: a run whose clock is behind another's still counts a draft that committed
with a later time.

**G-5. Quiet hours.** `quietStartMinute` and `quietEndMinute` (0..1439, local minutes past
midnight in `timeZone`, defaults 21:00 and 08:00) name a window in which the agent drafts
nothing. Equal values mean no quiet hours. A window may cross midnight. Local time comes from
the injected clock and the IANA zone, never the host's zone. The draft action reads that clock
after its locks (G-3), so a wait on them counts toward quiet hours.

**G-6. Agent actions.** All run through the shared dispatcher as the agent principal:
- `agent.run.start` `{runId, requestedBy}`: checks G-3 and G-5 and inserts the run, `running`,
  or `stopped` with its `stopReason` when the agent may not draft now.
- `agent.followup.skip` `{followupId, runId, intakeItemId, contactId, reason}`: records a
  decision not to draft, with a reason from the pre-check (G-8).
- `agent.followup.draft` `{followupId, runId, intakeItemId, contactId, replyId, approvalId,
  subject, body}`: locks (G-3), re-checks everything (G-3, G-4, G-5, G-8), then either inserts
  the reply (`draft`, `drafted_by` = the agent), the proposal (`inbox.reply.send`, target the
  reply, payload `{replyId}`, `requested_by` = the agent, default expiry 7 days, summary
  `Send the follow-up "<subject>"`) and a `drafted` decision, or records a `skipped` decision
  with the reason. It never writes `message.send_requested`.
- `agent.run.finish` `{runId, stopReason}`: closes the run, `completed` or `stopped`, with its
  counts taken from its decisions.
Keys are `agent:<step>:<runId>[:<intakeItemId>]`, and every ID derives from them, so a retried
run replays the steps that committed and continues with the rest. A run whose step failed for
an inquiry (a lock timeout, a lost connection) is not finished: it stays `running`, the error
reaches the caller, and a retry with the same key continues it. A stop reason ends the run
either way.

**G-7. Candidates.** An inquiry is a website request (`intake_items`) with a customer
(`new_contact` or `linked`), created between `lookbackDays` (1..90, default 14) and `waitHours`
(1..720, default 24) before now, that is the customer's latest request, has no agent draft yet,
and after which no reply to that customer (any status but `discarded`) was drafted. Inquiries
no run has decided come first, then those decided longest ago, oldest request first within
each, so inquiries skipped for lasting reasons cannot take every run's batch. At most
`maxCandidatesPerRun` (injected config) per run, counting what a resumed run already decided;
a resumed run leaves out what it decided. A run records its limit when it starts
(`agent_runs.max_decisions`) and keeps it when resumed. Each decision locks the run's row and is
refused once the run holds that many, so calls that resume one run at the same time cannot
together decide more.

**G-8. Skips.** A candidate is skipped, with its reason recorded, when the customer has no
real email (`no_email`), the email is suppressed (`suppressed`), email consent is `denied`
(`consent_denied`), the customer reached the per-customer cap (`contact_cap`), a reply was
drafted since the request (`answered`), or the customer has made a newer request since
(`superseded`; that request is the candidate now, G-7). The run checks these before calling the model, so a
skipped customer's details are never sent to it; the draft action checks them again under its
locks. A model error or an answer that fails validation is `model_error` and
`model_invalid`. Reasons that apply to the whole tenant (`global_killed`, `disabled`,
`tenant_killed`, `quiet_hours`, `daily_cap`) end the run with that `stopReason`.

**G-9. The model port.** `FollowUpModel.draft(prompt)` gets the business name, the customer's
name, the request time, the visitor's notes and the booking (start, end and zone) and
returns `{subject, body}`; nothing else about the tenant or other customers. The answer is
trimmed and must fit the reply limits (subject one line 1..200, body 1..5000). Tests and the
cloud use `createFakeFollowUpModel`, which is deterministic; no real model or key is wired.

**G-10. Records.** `agent_runs` (one row per run: requester, start, finish, status, stop
reason, counts) and `agent_followups` (one row per decision: run, inquiry, customer, outcome,
reason, reply, approval, time) are append-only for the runtime role apart from closing a run.
A run moves once from `running` to `completed` or `stopped`, and a closed run never changes
(`agent_runs_guard`, for every role).
Both have `tenant_id`, forced RLS with the tenant policy, and the catalog two-tenant denial
test.

**G-11. Reads and routes.** Under `/v1/agents/followup`:
- `GET /` (permission `inbox.drafts`): settings, `revision`, `killed`, `globalKilled`,
  `canDraft` and the reason it cannot.
- `PUT /settings` (`agents`), `POST /kill` (`inbox.drafts`), `POST /resume` (`agents`); each
  takes `Idempotency-Key`.
- `POST /runs` (`agents`): runs the agent once now for the caller's tenant, when the server has
  a model configured (404 otherwise).
- `GET /runs` (`inbox.drafts`): newest first, keyset cursor; `GET /runs/:id` with its decisions.
MCP offers the status, the runs and `stop_followup_agent`; no tool changes settings, resumes or
runs the agent.

**G-12. Approval stays human.** An agent draft is approved with the Inbox approve route or the
approvals route by an owner, who becomes the send's actor (A-6, A-7). Staff cannot approve. The
delivery worker then re-checks the approval, consent and suppression as for every reply (D-6).

**G-13. Scheduled runs.** Off unless the deploy sets `FOLLOWUP_AGENT=on`, and on Vercel only
when the build sets `FOLLOWUP_CRON_SCHEDULE`. `GET /cron/followup` (its own Vercel function,
`Authorization: Bearer <CRON_SECRET>`, 404 without a secret, 401 before any work, 200 without
work while off) and `pnpm followup:worker` (a Node loop every `FOLLOWUP_INTERVAL_MS`) share
one runner:
- Time is cut into slots of `FOLLOWUP_SLOT_MINUTES`. A tenant gets one run per slot, keyed
  `schedule:<slot start>` (G-6), so a repeated call in the slot continues an unfinished run
  and skips a finished one.
- The service role reads which tenants are due: none while the global switch is off;
  otherwise tenants with the agent enabled, not killed and outside quiet hours, least recently
  run first. Every switch and cap is still re-checked under the draft action's locks
  (G-3..G-5), and the run itself goes through the agent principal under RLS (G-1).
- A run starts no tenant whose worst case (`FOLLOWUP_MAX_CANDIDATES` inquiries, each waiting at
  most `FOLLOWUP_MODEL_TIMEOUT_MS` for the model) could outlast `FOLLOWUP_RUN_BUDGET_MS`; the
  rest wait for the next call. A model answer later than the timeout is dropped, and that
  inquiry is skipped as `model_error` for this run.
- A tenant whose run fails, or leaves an inquiry undecided (G-6), is reported, counted in
  `errors` and left due; the run goes on with the next tenant.
- No real model provider is wired: `FOLLOWUP_MODEL` accepts only `fake`, and only against
  loopback databases. `pnpm followup:global-switch on|off` flips the global switch (G-3).

**G-14. Agent kinds.** `agent_kind` is one of `inquiry_followup` (M6), `appointment_reminder`,
`review_request`, `document_intake` and `voice_receptionist` (`voice-receptionist.md`; its
runs are call sessions, V-4, on the `personal_data` lane); a new kind needs a revision of this
file. It keys:
- settings: `agent_settings` gains `agent_kind` (default `inquiry_followup`, so existing rows
  keep their meaning) and the key `(tenant_id, agent_kind)`. Its kind-specific settings sit in
  `config` (JSONB), validated by `agentKindConfigSchemas[kind]` in `packages/contracts`;
  unknown keys are `ValidationFailed`. Each kind is off by default, and a missing row reads as
  that kind's defaults with the kind off. Each kind has its own kill switch on its row (G-3),
  and the one global switch stops every kind;
- runs: the `agent_runs_agent` check covers the five kinds; new kinds record their decisions
  in `agent_decisions` (`tenant_id, id, run_id, agent_kind, subject_type, subject_id,
  contact_id, outcome, reason, message_id, approval_id, created_at`), append-only, forced RLS,
  in the catalog two-tenant test. `agent_followups` does not change;
- actors: each kind has its own principal, `derivedId(tenantId, "<kind>-agent", "actor")`,
  except that `inquiry_followup` keeps G-1's `followup-agent` ID. Its `authorize` admits only
  its own kind's actions; an `appointment_reminder` actor running an `inquiry_followup` or
  `document_intake` action is `TenantDenied`. Keys are `agent:<kind>:<step>:<runId>[:...]`,
  which cannot collide with G-6's `agent:<step>:` keys.
Settings, kill and resume for a new kind use `/v1/agents/:agentKind` with G-11's routes and
permissions; `/v1/agents/followup` stays as it is. G-3's locks, G-5's quiet hours and G-10's
run guard apply to every kind, each on its own settings row.

**G-15. Usage and a daily cost cap per kind.** Every model call writes one `agent_model_calls`
row (`tenant_id, id, run_id, agent_kind, subject_id, lane, model, input_tokens,
output_tokens, cost_micros, provider_request_id, outcome, created_at`), forced RLS, keyed
`agent:<kind>:model:<runId>:<subjectId>` so a replay writes nothing twice. It is append-only
apart from one move of `outcome` from `started` to `ok`, `error` or `invalid`.
`cost_micros` is USD millionths from the injected price table (`modelPrices`); the server
refuses to start when a configured lane's model has no price. `agent_runs` gains `model`,
`input_tokens`, `output_tokens` and `cost_micros`, summed from its calls when the run closes.
Each kind's settings hold `maxCostMicrosPerDay` (0..100000000, default 1000000):
- before a model call, under the settings lock, the run adds the kind's cost in the 24 hours
  before now to the call's worst case (its input plus `maxOutputTokens`, priced). Above the cap
  the run ends `stopped` with `stopReason` `cost_cap` and the call is not made. Otherwise it
  inserts the call's row as `started` at the worst case, so concurrent runs count it, and after
  the call records the reported usage; a call that fails or is aborted (G-17) with no reported
  usage keeps its worst case;
- `agent_model_calls` rows are plain table writes in the caller's own transactions (no outbox
  event). The call that first takes that 24-hour cost to 80% or more of the cap then commits the
  direct action `agent.cost.warn` through the dispatcher, keyed
  `agent:<kind>:cost-warn:<localDate>`, whose one outbox event is `agent.cost_warning`; a
  template suggestion (G-19) that crosses the line commits it the same way. G-11's
  status read shows `costSpentMicros`, `costCapMicros` and `costWarning`.
Templated kinds make no calls at run time; their only cost is wording suggestions (G-19). Model cost is recorded and capped, not
charged to the wallet (Known limits).

**G-16. Stalled runs.** The scheduler (G-13) closes a run that is still `running` when
`started_at` is more than `AGENT_STALL_AFTER_MS` before now: `agent.run.stall {runId}`, key
`agent:<kind>:stall:<runId>`, sets `stopped` with `stopReason` `stalled` and counts from the
decisions that committed. Config refuses a value no larger than the run's worst case
(`FOLLOWUP_MAX_CANDIDATES` times `FOLLOWUP_MODEL_TIMEOUT_MS`, plus `FOLLOWUP_RUN_BUDGET_MS`).
Each decision locks the run row (G-7) and is refused with `Conflict` `run_closed` once the run
is closed, so a late step of a stalled run writes nothing. A retry with the stalled run's key
replays the closed run; undecided candidates go to the next run. The stop reasons `cost_cap`
and `stalled` join the `agent_runs_stop_reason` check.

**G-17. The model port takes an abort signal and returns usage.** The shared port is
`TextModel.complete({system, input, schema, maxOutputTokens}, signal)`, which returns
`{output, usage: {inputTokens, outputTokens}, model, providerRequestId?}`. `system` is fixed
text owned by the kind; tenant data goes only in `input`, as JSON. `FollowUpModel.draft(prompt,
signal)` wraps it and keeps G-9's inputs and limits. The runner passes a signal that aborts at
`FOLLOWUP_MODEL_TIMEOUT_MS` by the injected timer, and on G-3 kills: the adapter stops its HTTP
request, and the decision is `model_error`, recorded within the timeout. `output` must pass
`schema`, or the decision is `model_invalid`. The fakes take the signal, honour an abort, and
report fixed token counts, so tests see usage without a network.

**G-18. Real model adapters per lane.** Two lanes, each with its own adapter behind G-17:
- `personal_data`: `createCerebrasModel` (Cerebras, prepaid). It serves every kind whose input
  may hold a customer's personal data: `inquiry_followup`, `document_intake` and
  `voice_receptionist`;
- `no_personal_data`: `createDeepSeekModel` (DeepSeek Flash). It serves only callers whose
  input holds no customer data, such as G-19's template wording suggestion.
Each kind declares its lane in code (`AGENT_KIND_LANES`), and `modelForLane("personal_data")`
can return only the Cerebras adapter or a fake: a deploy that points a personal-data kind at
DeepSeek fails at start. No adapter reads the personal Gemini key, and no lane takes images.
Config becomes `AGENT_MODEL_PERSONAL_DATA` (`fake` or `cerebras`) and
`AGENT_MODEL_NO_PERSONAL_DATA` (`fake` or `deepseek`), each real value with its key from the
deploy's secret store. `FOLLOWUP_MODEL` stays accepted as another name for
`AGENT_MODEL_PERSONAL_DATA`, and `fake` stays loopback only (G-13). Tests use recorded HTTP
fixtures and never call a vendor.

**G-19. Templated kinds call no model.** `appointment_reminder` and `review_request` send text
rendered from an approved template revision and never call a model at run time:
- `message_templates (tenant_id, id, agent_kind, current_revision)` and
  `message_template_revisions (tenant_id, id uuid, template_id, revision, channel, purpose,
  subject, body, variables, timing_hours, content_digest, standing_approval_id, created_by,
  created_at)`, `UNIQUE (tenant_id, template_id, revision)`, forced RLS, two-tenant test. `template.revision.create` (permission `agents`)
  writes a revision; nothing edits one. A body may use only its kind's variables
  (`{customer_first_name}`, `{business_name}`, `{booking_start_local}` for both,
  `{booking_link}` for reminders, `{review_link}` for review requests); any other placeholder
  is `ValidationFailed`. Values are inserted as plain text. The queue action records every
  value it rendered, `{business_name}` included, so a later profile edit (`business-profile.md`
  BP-9) cannot change what the approval check compares.
- Sends run only under A-15's standing approval of the current revision; without it the
  decision is skipped `template_not_approved`. Each send is the kind's direct action
  (`agent.reminder.queue` or `agent.review.queue`), which writes `message.send_requested`
  (`delivery.md` D-1) with the rendered content, so D-5, D-6 and D-9 still run at delivery.
- `appointment_reminder`: a `confirmed` booking with a customer (`booking-customer.md` or its
  intake item) whose start lies within `timing_hours` (1..168, default 24) after now; purpose
  `transactional`; one reminder per booking ever (unique index on `agent_decisions`), at most
  `maxSendsPerDay` (1..500, default 200).
- Skips: `no_address`, `suppressed`, `consent_denied`, `consent_missing` (an SMS needs a
  `granted` grant, D-6), `template_not_approved`. Quiet hours and the daily cap end the run
  (G-5, G-8).
- An owner may ask for a suggested wording (`POST /v1/agents/:agentKind/template-suggestion`,
  permission `agents`). Its input is the business name, the kind and the variable list, never
  customer data, on the `no_personal_data` lane (G-18). Each suggestion is one model call
  under G-15: it writes an `agent_model_calls` row (the requested kind, no `run_id`, key
  `agent:<kind>:suggestion:<idempotencyKey>`) and counts against that kind's
  `maxCostMicrosPerDay`, so a templated kind's cap is not zero once suggestions are used. At the
  cap it is refused with `Conflict` `cost_cap` before any provider call. It writes nothing else.

**G-20. Review requests need marketing consent.** `review_request` sends with purpose
`marketing` and only to a customer whose consent for the channel is `granted`. Contact consent
has no purpose column (`crm.md` C-9), and every grant recorded today comes from a
`marketing_updates` box (`public-intake.md` P-8), so a `granted` channel stands for
`marketing_updates` consent, with one exception: a grant whose source starts with
`twilio-voice:` (`twilio.md` T-12) was given for one booking-link text and never counts. A
missing or voice-sourced grant is skipped `consent_missing` before anything is queued, and
`delivery.md` D-6 refuses the same grant again at delivery. A test proves that a contact whose
only grant came from pressing 1 gets no review request at queue time and, if one is forced into
the outbox, none at delivery. Candidates are `confirmed` bookings with a customer
whose end is at least `timing_hours` (1..720, default 24) and at most `lookbackDays` (1..30,
default 7) before now. Caps: one request per customer in `contactWindowDays` (1..730, default
180), at most `maxSendsPerDay` (1..100, default 20). Every eligible customer gets the same
request: the kind has no setting, variable or step that asks about satisfaction or filters by
sentiment first. The review link is `config.reviewUrl` (an `https` URL the owner sets); without
it the kind cannot be enabled (`ValidationFailed`).

**G-21. Document intake treats documents as data.** Specified, not enabled: `document-intake.md`
keeps any model out of its extraction path, so its first slice uses no agent. This rule applies
once a revision of `document-intake.md` adds a model step (for `knowledge` documents) and names
the action this kind's principal runs before a job reaches `review`; until then the kind cannot
be turned on (`Conflict` `kind_not_available`). Then `document_intake` turns a document that
`document-intake.md` has extracted into a proposed field diff. The document's text goes to the
`personal_data` lane only in `input`, marked as document content; the fixed `system` text says
it is data. The model has no tools; its output must pass the kind's diff schema (allowed
targets and fields only), or the decision is `model_invalid`. The kind's principal may only
record a proposal: the diff goes to the owner as one approval under `document-intake.md`, and
nothing is applied before an owner approves it. Text in a document that asks for anything else
(send, delete, change settings) cannot cause another action, because no such action is
admitted. Caps: `maxDocumentsPerDay` (1..500, default 50), `maxPagesPerDocument` (1..50,
the `document-intake.md` DL-8 limit, default 20; a longer document is skipped `too_long`), and G-15's cost cap.

## Known limits (revision 1)

- `POST /runs` runs inside one HTTP request and its deadline. If the deadline fires mid-run the
  caller gets 503 and the run may stay `running`; a retry with the same key continues it. The
  model port takes no abort signal yet. M5 should size `maxCandidatesPerRun` for its model or
  run the agent from the scheduler only. (G-16 and G-17 close this once built.)
- A member run checks `agents` in its own transaction just before the run, so a demotion that
  commits in that gap still lets one run start; its writes are limited to the agent actions.
- Every run that has room left after the undecided inquiries records a skip again for an
  inquiry that is still suppressed, without an address or capped.

## Known limits (revision 4)

- Model cost is recorded and capped per kind (G-15) but not charged to the tenant's wallet:
  `delivery.md` D-11 has no model-call job kind. Whether tenants pay for model usage is an open
  question.
- No vision lane is approved. No kind reads images, and any task that needs vision waits for a
  business-billed lane (`docs/integrations.md`, open question 2).
- Bookings have no cancelled, completed or no-show status yet (`booking.md` B-24). Until one
  lands, a booking that did not happen still gets its reminder and a review request; the owner
  stops a kind with its kill switch.
- G-20 reads a `granted` channel as `marketing_updates` consent. Once a second consent purpose
  exists, G-20 must check the purpose itself.
- A standing template approval expires within 30 days (`approvals.md` A-5); templated sends
  then skip `template_not_approved` until an owner approves the revision again.
- `document_intake` depends on `document-intake.md` for the document, the diff schema and its
  approval; G-21 can land only after that contract's first slice.

## First slice (revision 4)

G-14's migration (kinds on settings, runs and actors; `agent_decisions`; `agent_model_calls`),
G-17's port with the fakes, and G-18's Cerebras adapter behind
`AGENT_MODEL_PERSONAL_DATA=cerebras` with a recorded HTTP fixture. Acceptance test, under the
runtime role: a run whose model never answers records `model_error` within
`FOLLOWUP_MODEL_TIMEOUT_MS` through the abort signal; the next call's usage fills
`agent_model_calls` and the run's totals; with `maxCostMicrosPerDay` set just above that cost,
the next run stops with `cost_cap` before calling the model; a config that points
`inquiry_followup` at DeepSeek fails at start; and the existing `agents.test.ts` passes
unchanged.

## Tests

`packages/core/test/agents.test.ts` under the runtime role: never sends without an owner's
approval (no send event after a run; the delivery worker delivers nothing until an owner
approves; then exactly once), caps hold under concurrent runs, a kill stops new drafts
immediately (a draft racing a kill either commits before it or is refused), the global switch,
quiet hours across midnight in a zone, staff cannot approve and the agent principal cannot
approve or send, suppressed and consent-denied customers are skipped without a model call,
two-tenant isolation, replayed runs, a run's limit held across overlapping calls that resume
it, and the catalog isolation suite over the new tables.
`apps/api/test/followup-runner.test.ts` and `followup-worker.test.ts` cover G-13: the
environment, the cron route, one run per slot, the switches and quiet hours, the daily cap,
least-recently-run order, the budget, a failing tenant, and the worker entry point.
Revision 4 (not built) adds: one kind's actor denied another kind's actions; each kind off by
default and killed on its own; the cost cap, the 80% warning once per local date and worst-case
recording; a stalled run closed and its late step refused `run_closed`; the lane guard at
start; templated sends refused before the grant, covered after it, and stopped by a new
revision (`approvals.md` A-15); a review request skipped `consent_missing` without a grant; a
document whose text asks for a send yielding only a diff proposal; two-tenant isolation over the
new tables.
