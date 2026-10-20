# M6: inquiry follow-up agent

Status: contract for M6 (2026-10-20), revision 1. Code follows this file; a change to a
numbered rule needs a new revision of this file first.

Scope: one agent. It finds website inquiries nobody has answered, asks a model port for a
follow-up email, and leaves it in the Inbox as a draft with a pending send proposal. An owner
reads it and approves, edits by discarding and redrafting, or discards it. The agent never
approves and never sends. Caps, quiet hours and two kill switches bound what it may draft; every
run and every decision it makes is recorded.

Out of scope: a scheduler (the hub or M5 runs the agent on a timer through `runFollowUps`), a
real model adapter (M5 brings one behind the same port), other agents, SMS follow-ups.

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
tenant's settings row `FOR UPDATE` and the global row `FOR SHARE` before it checks them, and the
kill writes take those rows, so a kill that commits stops every draft that commits after it: no
new draft appears once `kill` has answered. A draft already committed stays a draft; it still
needs an owner's approval to send.

**G-4. Caps.** In the draft action's transaction, after the locks of G-3:
- `maxDraftsPerDay` (1..200, default 10): agent drafts in the tenant in the 24 hours before now;
- `maxDraftsPerContact` (1..10, default 1) in `contactWindowHours` (1..2160, default 168):
  agent drafts for that customer in that window;
- one agent draft per inquiry, ever (a unique index backs it).
Because every draft for a tenant holds the settings row lock while it counts and inserts,
concurrent runs cannot exceed a cap.

**G-5. Quiet hours.** `quietStartMinute` and `quietEndMinute` (0..1439, local minutes past
midnight in `timeZone`, defaults 21:00 and 08:00) name a window in which the agent drafts
nothing. Equal values mean no quiet hours. A window may cross midnight. Local time comes from
the injected clock and the IANA zone, never the host's zone.

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
run replays the steps that committed and continues with the rest.

**G-7. Candidates.** An inquiry is a website request (`intake_items`) with a customer
(`new_contact` or `linked`), created between `lookbackDays` (1..90, default 14) and `waitHours`
(1..720, default 24) before now, that is the customer's latest request, has no agent draft yet,
and after which no reply to that customer (any status but `discarded`) was drafted. Oldest
first, at most `maxCandidatesPerRun` (injected config) per run.

**G-8. Skips.** A candidate is skipped, with its reason recorded, when the customer has no
real email (`no_email`), the email is suppressed (`suppressed`), email consent is `denied`
(`consent_denied`), the customer reached the per-customer cap (`contact_cap`), or a reply was
drafted since the request (`answered`). The run checks these before calling the model, so a
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

**G-12. Approval stays human.** An agent draft is approved with the Inbox approve route or the
approvals route by an owner, who becomes the send's actor (A-6, A-7). Staff cannot approve. The
delivery worker then re-checks the approval, consent and suppression as for every reply (D-6).

## Tests

`packages/core/test/agents.test.ts` under the runtime role: never sends without an owner's
approval (no send event after a run; the delivery worker delivers nothing until an owner
approves; then exactly once), caps hold under concurrent runs, a kill stops new drafts
immediately (a draft racing a kill either commits before it or is refused), the global switch,
quiet hours across midnight in a zone, staff cannot approve and the agent principal cannot
approve or send, suppressed and consent-denied customers are skipped without a model call,
two-tenant isolation, replayed runs, and the catalog isolation suite over the new tables.
