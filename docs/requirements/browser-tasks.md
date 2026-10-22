# Browser tasks

Status: draft contract, not built (2026-10-22). Code follows this file once its first slice
lands; a change to a numbered rule needs a new revision of this file first.

Scope: an assistant in the Agents area ("Website tasks") that does a chore on a website with
no API, for one tenant, in a browser profile of its own. An owner sees each step. This
revision turns on read-only tasks only, and the first one is downloading a supplier's invoices
as PDFs the owner can send to document intake (BT-13). Write tasks (a form submit) are specified here with their approval gate,
but stay disabled until a later revision turns them on.

Out of scope: write tasks in production (BT-11 keeps them off), vision (no approved lane),
insurer or payer portals, solving CAPTCHA or MFA, Browser Use Cloud or any hosted browser,
using any member's own browser or session, scheduling runs on a timer.

## Evidence and decisions

- `docs/integrations.md`: "Browser Use (website tasks): build later, read-only tasks first,
  runner on the pilot Mac", owner area Agents, build order step 8. Its shared rules apply:
  planners are separate from executors, workers on the pilot Mac pull jobs over HTTPS with a
  scoped token and expose no inbound port, profiles and caches are keyed by the server-derived
  tenant, page content is data, spend goes through the wallet (`delivery.md` D-11).
- Browser Use (MIT, `docs/licenses.md`) runs unmodified inside a separate Python service. Read
  2026-10-22 at release 0.13.13: it can restrict navigation to allowed domains, fill secrets
  from placeholders only on matching domains, stop between steps through a callback, cap steps
  and failures, turn vision off, and call Cerebras. Its anonymous telemetry and cloud sync are
  on by default (`ANONYMIZED_TELEMETRY`, `BROWSER_USE_CLOUD_SYNC`).
- The runner runs on the pilot Mac for the pilot; no VM, no Browser Use Cloud. Decided
  2026-10-22 (coordinator, standing approval).
- Model lanes, decided 2026-10-22 (coordinator, standing approval), as `docs/integrations.md`
  "Model lanes for tenant work": client personal data never goes to DeepSeek; text that may hold
  personal data uses Cerebras; the personal Gemini key is never used for client production
  traffic; vision has no approved lane, so browser tasks run text-only and any task that needs
  vision waits (Known limits). A supplier portal page can show names and addresses, so the
  planner uses the Cerebras lane (`agents.md` G-18).
- Read-only browser tasks first, decided 2026-10-22 (coordinator, standing approval): write
  tasks are specified with the approval gate (BT-11) but disabled until a later revision turns
  them on.
- Insurer or payer portal tasks are out, because those pages hold health data. Decided
  2026-10-22 (supervisor brief).
- The first read-only task is a supplier-portal invoice download into document intake.
  Decided 2026-10-22 (supervisor brief).
- Paperclip is ideas only, decided 2026-10-22 (supervisor brief): the numbered
  run event log (BT-9) and the stalled-run close (`agents.md` G-16) are written fresh here.
- Prefix `BT-`, because `B-` belongs to `booking.md`.

## Rules

**BT-1. One port, two phases.** Browser work runs only through `BrowserRunner`
(`packages/core/src/browser/port.ts`): `plan(cmd, signal)` drives the browser with a model and
stops before any submit; `execute(cmd, signal)` submits an approved form with no model. A plan
ends `read_done` (artifacts and steps), `submit_ready` (BT-11) or `stopped` with a reason.
`createFakeBrowserRunner` returns scripted results, so `pnpm -r test` needs no Python, no
Chrome and no network. `createHttpBrowserRunner` calls `services/browser-runner`, a Python
service that wraps Browser Use.

**BT-2. Where it runs.** The runner runs on the pilot Mac. It pulls claimed jobs from the API
over HTTPS with its scoped token (BT-7) and opens no inbound port. It refuses to start unless
`ANONYMIZED_TELEMETRY=false` and `BROWSER_USE_CLOUD_SYNC=false` are set, and it never calls
Browser Use Cloud. Each job runs a Chrome it launched itself.

**BT-3. Targets and allowed origins.** `browser_targets` (`tenant_id, id, name, task_kind,
allowed_origins, allowed_paths, sign_in_path, enabled, attested_by, attested_at, revision,
updated_at`) holds what a task may
visit. `allowed_origins` lists exact `https://host[:port]` origins, 1 to 5, with no wildcards. A
navigation, redirect or new tab outside them ends the run `stopped` with reason
`origin_denied`, before the page loads. An owner creates and enables a target with
`browser.target.save` (permission `agents`) under compare-and-set on `revision`, and must attest
that the site's terms allow automated access and that it is not an insurer or payer portal
(`attested_by`, `attested_at`). Targets are off by default.

**BT-4. Task kinds.** `task_kind` is one of a fixed list; a new kind needs a revision of this
file. This revision has one: `supplier_invoice_download` (read-only). It signs in, opens the
invoice list, and downloads the PDF invoices dated in the requested month. There is no kind
for claim status, payer portals or health records.

**BT-5. Read-only means no change on the site.** The model picks steps; the runner, not the
model, decides whether a step may run. For a read-only task kind:
- Paths. Each target lists `allowed_paths` (1 to 10 path prefixes, set with the target, BT-3)
  and its `sign_in_path`. A navigation or link whose path is outside them is not followed.
- Requests. The runner intercepts every request the page makes. After sign-in, only `GET` and
  `HEAD` requests to the allowed origins may leave; any other method (a JavaScript button that
  posts, a fetch, a form) is aborted before it is sent. The one exception is the sign-in form's
  own `POST` to `sign_in_path`, once per run.
- Operations. The planner's actions are a fixed list per task kind: open an allowed URL, click a
  link whose resolved target is an allowed `GET` URL, set a date filter that changes only the
  query string, and download an `application/pdf` response. There is no free typing outside
  the sign-in fields and no generic click.
Any refused step ends the run `stopped` with reason `write_refused`. The acceptance test serves
a fake supplier site with a `GET` delete link outside `allowed_paths`, a JavaScript button that
`POST`s to an allowed path and a second form; each attempt ends `write_refused`, and the fake
site's log shows no request other than `GET`, `HEAD` and the one sign-in `POST`.

**BT-6. Profiles and files are per tenant.** Each (tenant, target) has its own profile at
`<BROWSER_ROOT>/<tenantId>/<targetId>/profile`, built only from the server-derived tenant and a
target UUID it owns. Downloads and screenshots go to Storage under
`tenants/<tenantId>/browser-runs/<runId>/`, behind a tenant policy. No member's or the repo
owner's browser profile is ever used. Deleting a target deletes its profile. A two-tenant test
shows that tenant B's run cannot open tenant A's profile, downloads or screenshots, and that a
tenant ID in a job payload is ignored.

**BT-7. The runner principal.** `browser-runner` is a server-built principal with a scoped
token. It may claim a queued browser job, append events and upload artifacts for the run it
holds, and report the result. It cannot read CRM, slots, bookings, the Inbox or another run;
any other action is `TenantDenied`. A claim is a lease (`lease_until`); an expired lease
returns the job to the queue and the next claim starts a new attempt.

**BT-8. Credentials.** `browser_credentials (tenant_id, target_id, secret_ref)` points at a
Supabase Vault secret; the value is never stored in a table. The claim response carries the
values for the claimed target only, and the runner keeps them in memory for that run. They are
passed to Browser Use only as sensitive-data placeholders bound to the target's origins, so
the model sees placeholders, never values. A test plants a known password and checks that it
appears in no prompt, event, log line, artifact name or row.

**BT-9. Runs, events and caps.** `browser_runs` (`tenant_id, id, target_id, task_kind, status,
stop_reason, requested_by, started_at, finished_at, steps, cost_micros`) and
`browser_run_events (tenant_id, run_id, seq, origin, path, action, screenshot_ref,
created_at)`, forced RLS, catalog two-tenant test. `seq` counts from 1 with no gaps. Events
store origin and path, never the query string or fragment. Per run: `maxSteps` (1..100,
default 25), `deadlineMs` (default 600000) and `maxCostMicros`; per tenant per day: runs
(default 5) and cost. Model usage is recorded per step as `agents.md` G-15 records it.
Reaching a cap stops the run with `step_cap`, `deadline` or `cost_cap`. Before the job starts,
the API's claim handler, in a service-role transaction like the delivery worker's
(`delivery.md` D-10), reserves `maxSteps` times the step price for the existing `browser_runs`
row (`delivery.md` D-11, job kind `browser_run`); without funds the claim returns nothing and
the run ends `insufficient_funds`. On close it captures
the steps it took and releases the rest.

**BT-10. Text-only on the Cerebras lane.** The planner calls Cerebras with vision off, through
the same lane guard as `agents.md` G-18: DeepSeek and the personal Gemini key are refused at
start. Page text is data: the planner's fixed instructions say so, and BT-3, BT-5 and BT-11
limit what an injected instruction could do. A step the model cannot take without seeing the
page ends the run `stopped` with `needs_vision`; no task kind that needs vision is enabled.
Screenshots are taken for the owner's audit only and never go to a model.

**BT-11. Write tasks: specified, disabled.** When a later revision enables them: a write plan
ends `submit_ready` with the origin, the form's fields and values, a form hash and a
screenshot. Core writes an `approvals` row for `browser.submit` whose payload is those fields
and that hash, so the approver sees the real payload (`approvals.md` A-12). Only an owner
approves (A-6). `execute` reopens the same profile, checks that the page's form hash and values
equal the approved payload, then clicks submit with no model; on any difference it stops with
`drift` and submits nothing. In this revision `browser.submit` is not in `ACTION_PERMISSIONS`,
no write task kind exists, and `execute` is refused with `Conflict` `write_tasks_disabled`.

**BT-12. Stops and hand-backs.** Before every step the runner's stop callback reads the
agents' global switch (`agents.md` G-3), the tenant's browser kill switch
(`browser_task_settings.killed_at`) and the run's caps; a kill stops the run `killed` before its
next step. `browser.kill` (permission `inbox.drafts`) engages it and `browser.resume`
(`agents`, owners only) clears it, as G-3 does for agents. A CAPTCHA, an MFA prompt or an
unknown dialog ends the run `needs_owner`; the runner never solves or waits for a solver. A run
still `running` past its deadline plus a grace is closed `stalled` (as `agents.md` G-16).
Browser tasks are off by default (`browser_task_settings.enabled`).

**BT-13. Hand-off to document intake.** `supplier_invoice_download` accepts only PDF files up
to 20 MiB, at most 50 per run, stored as run artifacts (BT-6). The run itself never creates
intake jobs and never writes CRM, catalog or accounting rows. The owner sees the files on the
run and may send one to document intake with `catalog.intake.upload` (`document-intake.md`
DL-3), which copies the artifact into intake storage and records `source` `browser:<runId>`.
`document-intake.md` has no invoice target yet (Known limits), so the first slice ends at the
stored PDF.

## First slice

The tables (`browser_targets`, `browser_credentials`, `browser_task_settings`, `browser_runs`,
`browser_run_events`), the fake runner, the claim and report routes, and
`supplier_invoice_download` against a local fixture supplier site on loopback.

Acceptance test, under the runtime role, with the fake runner and then the Python service
against the fixture site: a run on tenant A downloads two fixture invoices, which appear as
run artifacts and no intake job is created; the owner sends one to intake and its job records
source `browser:<runId>`; a link to an origin outside the target
stops the run `origin_denied` and loads nothing; tenant B cannot read A's runs, events,
screenshots or profile path; a planted password appears nowhere outside the browser; a kill
between steps stops the run before its next step; a fixture form other than sign-in ends the
run `write_refused`; and `execute` is refused with `write_tasks_disabled`.

## Known limits

- No vision lane is approved, so sites that only a vision model can drive are not supported.
  A business-billed Gemini project is an open question (`docs/integrations.md`, question 2).
- The runner on the pilot Mac is a single point of failure: when the Mac is off, jobs wait in
  the queue. Moving it to a VM is a new vendor and needs approval.
- Open question: how long screenshots and run events are kept. Until decided, they are kept
  until the target is deleted.
- Open question: the step price a tenant pays for a browser run (BT-9).
- Open question: whether Browser Use's Cerebras support handles the sign-in and download flow
  of real supplier portals text-only. The first slice proves it on the fixture site only.
- A site's terms can change after the owner attests; the attestation is not re-checked.
