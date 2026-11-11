# F1: booking authority

Status: implemented. The numbered rules below are the contract the code and tests
follow. The slot calculation (`getAvailableSlots`), the `booking.create` handler, the
`createBooking` wrapper, the schema and the migrations ship in this repository. At the
time of writing, `pnpm --filter @zs/core test:booking` runs the booking suites in five files
(public examples, slot calculation, handler acceptance, the real Postgres seam and cancellation), and
all pass. The public examples cover a small part of the contract; the acceptance tests
cover the rest.

Revision 4 (2026-11-10, first-client week): booking outcomes. B-37 to B-47 let an owner or staff member mark a booking that
has started as `completed` or `no_show`, and make review requests (`agents.md` G-20) depend on `completed`, at the queue and
again at delivery. B-17 to B-19 and B-21 to B-23 do not change; `booking.create` still accepts only
`{bookingId,resourceId,startsAt}`.

Revision 4 review (2026-11-11): three independent reviews of the first draft changed B-37, B-40, B-43, B-44, B-46 and added
B-47. The read shape is now present-only-when-marked (B-47); the queue locks the booking row (B-43); delivery stops a
review request whose booking is not `completed` at send time (B-43, B-44, B-46, `delivery.md` D-6); the stamp check includes
the actor (B-40).

Revision 3 (2026-11-10, first-client week): cancellation. B-1 brings owner cancellation into scope; B-20 and
B-24 let a booking be `confirmed` or `cancelled` and limit the overlap constraint to confirmed rows; B-29 to B-35 add
the `booking.cancel` action. B-17 to B-19 and B-21 to B-23 do not change: `booking.create` still accepts only
`{bookingId,resourceId,startsAt}`. Rescheduling and the customer's own link are in `booking-self-service.md`.

Revision 2 (2026-10-22): B-3 accepts client-supplied instants in UTC years 0001 through 9999
only. The frozen booking instant schema refuses anything outside that range, so every booking
boundary (create, the availability recheck, slot search, availability and list range filters)
answers 400 `ValidationFailed` and writes nothing. CRM consent instants and source observations
follow the same rule.

## Evidence and decisions

All prose and schemas here are original. No implementation was ported.
**Desired** identifies our required behavior. **Upstream does** describes only the
specific inspected behavior, not a claim about an entire product.

- S1: cal.diy, MIT, commit `54343aa685ae8f33159d2f485ec4a57bad5c574a`,
  `packages/features/schedules/lib/slots.ts`: slot enumeration, rounding, notice,
  range ordering and duplicate suppression.
- S2: the same commit, `packages/trpc/server/routers/viewer/slots/util.ts`:
  availability aggregation, configured duration/interval, restriction checks and
  period filtering. This was a behavior reference only.
- S3: our scheduler, commit `64b7fe7818b6d88f1d1061a00a65599027be1d43`,
  read only at `/Users/zero-suminc./.cache/zs-sources/rise-scheduler-64b7fe78/backend/src/services/booking.ts`,
  `claimSession`: a conditional state change arbitrates competing claims.
- S4: the local HighLevel behavior notes dated 2026-10-17, including the saved
  calendar guide `help.gohighlevel.com-2548190608.md`: recurring hours, date-specific
  hours, duration, interval, preparation time and advance-booking settings.
- S5: the product assembly plan dated 2026-10-17, sections 1, 2 and 6: tenant
  ownership and one authority for booking confirmation. Its SeldonFrame table is void.
- Browser observation on 2026-10-17: `http://localhost:3000` redirected to a sign-in
  screen. No authenticated booking behavior was observed. No source, script body,
  bundle, UI wording or asset from that app informed this contract.

## Numbered rules

**B-1. Desired, product scope (S4/S5).** F1 shipped with at most one bookable
resource per tenant; M1 (migration `20261018120000_booking_multi_resource.sql`) lifts
that limit so a tenant may own several resources, each locked and constrained on its
own (B-20, B-21). F1 supports its schedule, external busy periods, and confirmed bookings.
Round robin, multiple hosts, reminders, payments, recurring bookings and rescheduling
APIs are outside this slice. Cancellation by an owner is inside it from revision 3 (B-29). Resource provisioning and connector
sync will get separate write actions; they must obey B-21 before shipping.

**B-2. Desired (S1/S2 comparison).** `getAvailableSlots(input, deps)` is synchronous
and pure: no database, network, environment access, ambient clock or input mutation.
On valid input, call `deps.clock.now()` exactly once; whether it is called for
invalid input is unspecified. A non-finite instant raises `ValidationFailed`. For
identical validated input and clock value, return identical output. **Upstream does:**
S1 reads the current time and an environment-derived alignment fallback; S2 also
reads time/configuration from its service environment. We inject these dependencies so
replays and boundary tests have one definition of now.

**B-3. Desired, data boundary.** Validate with the frozen schemas. IDs are UUIDs
and normalize to lowercase. Instants use UTC `YYYY-MM-DDTHH:mm:ss.sssZ` with exactly
three fractional digits, in UTC years 0001 through 9999 (Postgres has no year zero).
Reject invalid calendar dates, instants outside that range, nonpositive intervals,
unknown fields and invalid numbers with `ValidationFailed`; do not coerce them.
Each feature function uses schema `safeParse` and maps parse failures to
`ValidationFailed`. Calling an exported schema's `parse` directly still raises a
zod error; that parser utility is not the feature function's error boundary.
Query windows span at most 31 elapsed days. Slot length and step are integral
1..1440 minutes, buffers 0..1440, and notice/horizon 0..525600. These explicit limits
bound enumeration and configuration; horizon zero yields no slots.

**B-4. Desired, time zones.** Accepted means the frozen schema accepts it: any
name with a slash that the runtime knows, including `Etc/GMT±N`, plus exactly
`UTC`. Examples include `America/New_York`, `america/new_york`, `Asia/Kolkata`
and `Etc/GMT+5`. Any other spelling without a slash, including `utc`, `GMT` and
`EST5EDT`, is rejected with `ValidationFailed`. Unknown zones and numeric offsets
are also rejected; never fall back to the machine zone. Output uses the accepted
input identifier; we do not promise a canonical spelling. UTC instants drive
database comparisons, so SQL does not reinterpret local labels using a second
time-zone database. Clients may display another zone without changing the authority.

**B-5. Desired, local schedule (S4).** Weekdays are ISO 1=Monday through 7=Sunday.
Each weekday appears at most once. A missing weekday has no availability. A local
window uses integral minutes from midnight, start 0..1439 and end 1..1440, with
start < end. Overnight hours are two windows on adjacent weekdays, ending at 1440
and starting at 0. Touching windows across midnight form one continuous interval
(B-9). Merge overlapping or touching windows for evaluation; input order has no
meaning.

**B-6. Desired, overrides (S4).** At most one override may exist per local ISO
date. If present, its windows replace that date's entire weekly schedule. An empty
override closes the date. A missing override uses weekly rules. Reject duplicate
weekday/override entries instead of making array order decide the schedule.

**B-7. Desired, DST.** Interpret the effective schedule as membership in local
wall-clock windows on each date: an instant is available when its local label falls
inside a window. Map that membership to a union of intervals on the UTC timeline.
A missing wall-clock minute in a spring gap produces no candidate. A repeated
minute in a fall overlap produces both distinct UTC candidates if each passes the
other rules. Never silently shift a nonexistent time or collapse repeated labels.
This is our explicit policy; S1/S2 were not proof of their full DST behavior.

**B-8. Desired (S1/S2 comparison).** Candidate starts lie on a resource-local grid:
`minuteOfDay % slotStepMinutes == 0`, with zero seconds and milliseconds.
Here `minuteOfDay = localHour * 60 + localMinute`, never elapsed UTC minutes since
midnight. Reset that wall-label grid on every local date, including both occurrences
in a DST overlap. For step 45, local 03:00 is aligned even on a spring-forward day.
Evaluate alignment after conversion to the resource zone, so half-hour
offsets work. **Upstream does:** S1 converts to its supplied zone before rounding,
derives rounding intervals from frequency divisors and optionally optimizes starts;
S2 supplies a slot interval or duration fallback. We retain local-zone alignment
but require one explicit step and no optimization, offsets or hidden fallback.

**B-9. Desired, durations.** Add `slotLengthMinutes` as elapsed UTC minutes to each
candidate start. The appointment interval must lie entirely within the union in
B-7. A slot may cross midnight or a clock transition only if its entire elapsed
interval remains available. Wall-clock labels need not differ by the elapsed
duration during DST. Return UTC instants to distinguish those cases.

**B-10. Desired (S1/S2 comparison).** Every interval is half open `[start,end)`.
The entire appointment must fit inside the query range, and equality of its end
with the range or availability end is allowed. **Upstream does:** S1 subtracts one
second during its end-boundary test; S2 separately checks full slot containment
for restriction schedules. We use exact millisecond containment everywhere to
avoid accepting a slot that extends beyond an end boundary.

**B-11. Desired (S1/S2 comparison).** Accept a candidate start exactly at
`now + minimumNoticeMinutes * 60000`; reject any earlier instant. Preserve the
clock's seconds and milliseconds when computing this lower bound, then select
the next grid candidate. Zero notice permits a start equal to now.
**Upstream does:** S1 clears seconds/milliseconds after taking its notice bound;
S2 has a helper whose zero notice falls back to one minute. We do neither, so a
candidate never receives less notice than configured.

**B-12. Desired (S2 comparison).** The horizon is an exclusive start bound:
`start < now + bookingHorizonMinutes * 60000`. It measures elapsed time, not local
calendar days. Only the start is horizon-limited; the full appointment must still
fit the query and schedule. If notice meets/exceeds the horizon, return no slots.
**Upstream does:** S2 delegates several period modes and calendar-day settings to
period filtering. We choose one elapsed-time policy to make the edge unambiguous.

**B-13. Desired, busy data (S2).** The caller supplies a complete snapshot of busy
intervals for the resource. Each has the same tenant/resource IDs as the resource;
reject a mismatch with `ValidationFailed`. Existing booking entries contain the
appointment interval and that booking's saved before/after buffer values. Expand
those once. External entries describe occupied time directly and get no extra
buffer. Overlapping/duplicate busy entries have union semantics. **Upstream does:**
S2 consumes busy data through its broader availability service. We choose this
smaller explicit input boundary to keep slot calculation pure and independently testable.

**B-14. Desired, buffer policy.** For candidate `[s,e)`, reserve
`[s-before*60000,e+after*60000)`. The appointment must fit availability; preparation
time may extend beyond working hours, the query window, or midnight. Any positive
overlap between this occupied interval and a busy occupied interval rejects the
candidate. Exact touching is allowed. Both bookings' buffers matter; never apply
the resource's current buffers again to an already expanded existing booking.

**B-15. Desired, midnight coverage.** Load busy periods by intersection with the
possible occupied intervals, including dates outside the displayed query. A
booking ending the previous day can still block a candidate through its after
buffer. A next-day external block can conflict with a candidate's after buffer.
Do not clip buffers at date, schedule, query, notice or horizon boundaries.

**B-16. Desired (S1 comparison).** Return `{resourceId,timeZone,slots}` with slots
sorted by UTC start, unique by start instant. Do not mutate or sort caller-owned
arrays. Empty availability is a successful empty list. **Upstream does:** S1
deduplicates starts but sorts its range array in place. We retain uniqueness and
chronological order while preserving the purity promised in B-2.

**B-17. Desired, command boundary.** `createBooking(command, ctx)` accepts action
type `booking.create`, target type `booking`, and payload `{bookingId,resourceId,
startsAt}`. Pre-mint `bookingId` at the server edge and use it as target ID. The
command also carries the existing approval reference and idempotency key. The
server binds approval to the exact parsed action, actor, tenant, target and payload.
The client cannot submit duration, buffers, status or an occupied range.

**B-18. Desired, dispatcher integration (S5).** `BookingWriteContext.dispatch`
is a trusted server capability, constructed as
`command => sharedDispatch(serverContext, command)`, where `sharedDispatch` comes
from the unchanged `createDispatcher(handlers)`. That bound server context owns
actor, tenant, database, clock, configuration, ID generation and approval resolution.
Do not accept this context from HTTP/MCP input. The feature wrapper (`createBooking`) uses
`createBookingCommandSchema.safeParse(command)` and forwards its `data` to dispatch
exactly once. Invalid input raises `ValidationFailed` without reaching dispatch.
Validate the returned envelope with `createBookingOutputSchema.safeParse`; a parse
failure raises `ValidationFailed`. Return the parsed `{actionId,result:BookingRecord}`
on success. The shared dispatcher raises `ValidationFailed` for a non-finite clock;
the wrapper propagates every dispatcher error unchanged. `bookingHandlers`
registers the `booking.create` handler (B-27); a composition root passes it to
`createDispatcher`. Dispatching an action type that no handler registers still raises
`NotImplemented`.

**B-19. Desired, authoritative recheck.** A shown slot is advisory. The existing
`resolveTarget(tx,target)` receives no payload. It must verify the tenant creation
scope and confirm the booking target ID is unused before returning that target.
If it finds an existing owned booking ID, it throws `Conflict` with
`details.reason="id_in_use"` directly; it must not return a used create target or
return null for that domain conflict. The unchanged dispatcher preserves this typed
resolver error. It may not infer resource ownership from target input. In `handle`,
which receives the command, verify payload resource ownership, load current
schedule/configuration and busy periods, and re-evaluate the
requested start using the dispatcher's injected transaction time. A well-formed
start that fails B-7–B-9, B-11, B-12, B-14 or B-15 (B-10's query range and B-13's
input checks do not apply to create), including misalignment, out-of-hours time, notice
or horizon bounds, and busy overlaps, raises `Conflict` with
`details.reason="slot_unavailable"`, including a start that no longer qualifies.
For this availability recheck, only schema failures raise `ValidationFailed`.
IDs are tenant-scoped: a create-target ID that exists only in another tenant is
unused and the create succeeds if the other rules pass. `TenantDenied` applies to
foreign or absent existing targets and
parents, including the resource; an absent create-target ID is expected.
Derive the end and occupied interval from this authoritative resource state.
Recheck target uniqueness under the resource lock. An insert that loses a target-ID
race after resolution still raises `Conflict` through the unique constraint; that
SQL race may carry constraint details without an `id_in_use` reason.

**B-20. Desired (S3 comparison).** The database arbitrates overlapping bookings.
Require an immediate Postgres exclusion constraint on equal tenant/resource IDs
and overlapping occupied ranges, including saved buffers. Two approved commands
with different keys/IDs for conflicting time cannot both commit. Return one
success and one typed `Conflict`, with no losing booking/action/outbox row.
Race tests assert only `code === "Conflict"`: the loser may report
`details.reason="slot_unavailable"` or `details.postgresCode="23P01"`. The
constraint is limited with `WHERE status='confirmed'` from revision 3: a `cancelled` booking
(B-30) takes no part in it, so its time can be booked again.
**Upstream does:** S3 conditionally updates one pre-existing available session,
then reports whether the claim lost. We retain database arbitration but require
range exclusion because independently created, overlapping intervals are not
claims on one pre-existing session row.

**B-21. Desired, other concurrent writes.** After the dispatcher's idempotency
lock, acquire
`pg_advisory_xact_lock(hashtextextended('booking-resource:' || tenant_id || ':' || resource_id, 0))`
before the authoritative recheck, with both UUIDs expressed as lowercase text, and
hold it until commit. Every future schedule or external block mutation for that
resource must use this exact expression and lock order through the shared
dispatcher. Do not require an UPDATE grant just to read-lock a resource row.
Thus a create cannot race a schedule closure or new external block.
The exclusion constraint remains mandatory even when this lock serializes creates.
The integration suite must also prove the constraint rejects an overlapping direct
insert under the runtime role; an application lock alone is not booking authority.

**B-22. Desired (S3/S5 comparison).** Resolve success only after the dispatcher
commits booking state, action history and its outbox event atomically. Persist
`status=confirmed`, the dispatcher's time as `createdAt`, and the buffers used at
creation. Later configuration changes do not rewrite existing occupied ranges.
**Upstream does:** S3 writes a claim and an audit record using a supplied or default
database context. We require the shared transaction and outbox for all callers,
so no adapter can announce success before durable state exists.

**B-23. Desired, retry/error contract.** Identical approved retries return the
same stored action ID and result. Preserve the dispatcher's `IdempotencyConflict`,
`BindingMismatch`, `TenantDenied`, `ValidationFailed` and `Conflict` semantics.
SQL `23P01` must remain `Conflict` with `details.postgresCode` and constraint name
when supplied. `NotImplemented` is the unregistered-action signal. Unexpected
infrastructure failures propagate as errors; never turn them into empty slots or
success. TypeScript does not encode checked throws; exported error aliases describe
the typed domain errors, not every possible transport/database outage.

**B-24. Desired, storage ownership.** The schema lives in
`packages/db/src/schema/booking.ts` and the SQL in
`supabase/migrations/20261017170000_booking.sql`; migration
`20261018120000_booking_multi_resource.sql` (M1) later changed `booking_resources`
(see the table). Required tables/columns:

| Table | Required columns and constraints |
| --- | --- |
| `booking_resources` | `tenant_id`, `id`, `time_zone`, `weekly` JSONB, `overrides` JSONB, `slot_length_minutes`, `slot_step_minutes`, `buffer_before_minutes`, `buffer_after_minutes`, `minimum_notice_minutes`, `booking_horizon_minutes`; PK `(tenant_id,id)`, FK to tenant, schema-equivalent config validation; M1 dropped the original one-per-tenant unique constraint on `tenant_id` and added a nullable `name` (1 to 200 characters) that B-28 inserts may omit |
| `bookings` | `tenant_id`, `id`, `resource_id`, `starts_at`, `ends_at`, `occupied_starts_at`, `occupied_ends_at`, `buffer_before_minutes`, `buffer_after_minutes`, `status`, `created_at`; PK `(tenant_id,id)`, composite resource FK, positive appointment range, saved buffer bounds and exact occupied-bound checks; from revision 3 `status` is `confirmed` or `cancelled`, with nullable `cancelled_at`, `cancelled_by` (the owner member who cancelled) and `cancel_reason` that are set together with `cancelled` and only then (B-30); from revision 4 nullable `outcome` (`completed` or `no_show`), `outcome_set_at` and `outcome_set_by`, set together and only on a `confirmed` booking (B-37, B-38) |
| `booking_external_blocks` | `tenant_id`, `id`, `resource_id`, `starts_at`, `ends_at`, `source`, `created_at`; PK `(tenant_id,id)`, composite resource FK, positive range, nonempty source |

Use `timestamptz` for instants. Define `bookings_resource_occupied_excl` using
`btree_gist`: equal `tenant_id`, equal `resource_id`, and
`tstzrange(occupied_starts_at,occupied_ends_at,'[)') WITH &&`. Never constrain only
appointment starts or unbuffered ranges. Resource config must retain empty date
overrides distinctly from absent overrides.
This constraint arbitrates booking rows only. External blocks are guarded by the
B-21 advisory lock and authoritative recheck; they are not covered by the exclusion
constraint.

**B-25. Desired, tenant enforcement (S5).** Every table has `tenant_id NOT NULL`,
tenant FK, enabled and forced RLS, plus matching `USING` and `WITH CHECK` predicates
on the transaction's tenant. Parent/child FKs include `tenant_id`; grant the runtime
role only needed operations. Add two-tenant read/write denial tests using actual
`zs_runtime` credentials. Service-role-only tests cannot establish isolation.

**B-26. Desired, verification boundary.** Baseline `test` excludes the feature
folders (`test/booking`, `test/crm`); `test:booking` runs the booking folder with
normal tests, without skips, `todo`, expected-failure flags or no-test success. Public
slot fixtures assert exact outputs for alignment/notice, buffers/overrides, and both
DST transitions. The write example checks the bound-dispatcher boundary using a
scripted dispatcher response. `packages/core/test/booking/integration.test.ts` uses
the B-27/B-28 seam with the real `@zs/db/testing` database, two-tenant fixture and
`zs_runtime` scoped database. It seeds a resource with service-role SQL, dispatches
through the registered handler and checks the committed booking. That test is a
template, not the acceptance set. Real Postgres acceptance lives in
`packages/core/test/booking/create.test.ts` (handler behavior) and
`packages/core/test/booking/slots.test.ts` (slot calculation), and the isolation
suite in `packages/db/test/isolation.test.ts`. These must keep covering cross-tenant denial,
invalid zones, midnight buffers, exact horizon and notice edges, stale availability,
exclusion races, retries and rollback. Separate hidden tests may check requirements
beyond the public examples.

**B-27. Desired, handler export and composition.**
`packages/core/src/booking/index.ts` exports
`bookingHandlers: Readonly<Record<string, ActionHandler>>`, keyed by the action
type `booking.create`. `ActionHandler` uses the default `DispatchConfig`; handlers
require no config keys because all feature settings live in tables. The map
contains exactly the key `booking.create` and no other key, so it is disjoint from
`crmHandlers`. Direct dispatch of an unregistered action still raises the shared
dispatcher's `NotImplemented`. Export `bookingHandlers`
through `packages/core/src/index.ts` as well. A server composes both features with
`const dispatch = createDispatcher({ ...bookingHandlers, ...crmHandlers })`.
It supplies a trusted `DispatchContext` named `ctx`, with `db` set to the runtime
scoped database (in tests, `TestDatabase.db`, backed by `zs_runtime`), `config: {}`,
the injected clock/ID generator, actor/tenant and caller-supplied `resolveApproval`.
Bind `BookingWriteContext.dispatch = command => dispatch(ctx, command)` at that
server boundary. No dispatcher or shared action-type changes are required.

**B-28. Desired, SQL fixture and inspection contract.** Tests use
`withTestDatabase` and `createTwoTenantFixture` from `@zs/db/testing`. After the
fixture provisions tenants, tests seed `booking_resources` and
`booking_external_blocks` as `service_role` using plain SQL through
`fixture.service`. INSERTs supply only the B-24 required columns with these exact
Postgres types; all listed columns are NOT NULL:

| Table | Column types |
| --- | --- |
| `booking_resources` | `tenant_id uuid`, `id uuid`, `time_zone text`, `weekly jsonb`, `overrides jsonb`, `slot_length_minutes integer`, `slot_step_minutes integer`, `buffer_before_minutes integer`, `buffer_after_minutes integer`, `minimum_notice_minutes integer`, `booking_horizon_minutes integer` |
| `booking_external_blocks` | `tenant_id uuid`, `id uuid`, `resource_id uuid`, `starts_at timestamptz`, `ends_at timestamptz`, `source text`, `created_at timestamptz` |
| `bookings` | `tenant_id uuid`, `id uuid`, `resource_id uuid`, `starts_at timestamptz`, `ends_at timestamptz`, `occupied_starts_at timestamptz`, `occupied_ends_at timestamptz`, `buffer_before_minutes integer`, `buffer_after_minutes integer`, `status text`, `created_at timestamptz` |

`weekly` and `overrides` hold exactly the JSON arrays of the frozen
`bookingResourceSchema` fields with those names. For example, `weekly` may be
`[{"weekday":1,"windows":[{"startMinute":540,"endMinute":1020}]}]` (ISO weekday, 1 = Monday, B-5) and `overrides`
may be `[]` or `[{"date":"2026-10-19","windows":[]}]`. Do not wrap those arrays,
rename their keys or require another configuration table. Every extra column an
implementer adds must be nullable or have a default. No extra NOT NULL table or
mandatory related row may be required for these INSERTs; only the tenant and
resource parents listed in B-24 may be prerequisites. Tests may SELECT `bookings`
as `service_role` using any subset of exactly its B-24 columns listed above;
grant that access. The same service-role seed/read access applies to the two
configuration tables. Inspection does not establish RLS: tenant-denial and direct
exclusion-constraint tests still run under `zs_runtime` (B-21/B-25).
For those tests, inside `fixture.a.run`, `zs_runtime` may INSERT a `bookings` row
that supplies exactly the eleven B-24 columns above, with `status='confirmed'` and
occupied bounds equal to the appointment bounds widened by the saved buffers; grant
that INSERT. A non-overlapping row commits. An overlapping row fails with SQLSTATE
`23P01` and constraint `bookings_resource_occupied_excl`; no trigger, rule or
earlier check may pre-empt it with another error. The extra-column rule above
applies to `bookings` too. The same INSERT for another tenant's `tenant_id` fails
only through RLS `WITH CHECK` (SQLSTATE `42501`).

## Frozen API and public examples

`packages/contracts/src/booking.ts` exports zod schemas and inferred types for
resource configuration, windows, intervals, busy entries, slot input/output,
create input/command/output and booking records. It also exports `GetAvailableSlots`,
`CreateBooking`, their dependencies/context, and error-code schemas/error types.
The root contracts/core indexes export the feature surface.

Fixtures in `packages/core/fixtures/public/booking/`:
`alignment-notice.json`, `buffers-override.json`, `dst-gap.json`, `dst-overlap.json`,
and `create-booking.json`. They contain synthetic IDs and data only. Five public
tests consume these examples; a sixth is the SQL integration template. All six pass
at the time of writing.

## Cancellation (revision 3)

**B-29. Desired, the action.** `booking.cancel` has target type `booking` and payload
`{bookingId, reason, notifyCustomer}`. `reason` is null or one line of 1..500 characters (trimmed, Postgres text,
no line break), kept for the team and never sent to the customer; any member with the `calendar` permission can read it. `notifyCustomer` is a boolean. The HTTP and tool bodies
(`POST /v1/booking/bookings/:id/cancel`, MCP `cancel_booking`) may omit both fields (send `{}`; a JSON `null` body is refused); the server fills `reason: null` and
`notifyCustomer: true` before it binds the action, so one cancellation has one canonical payload. The action needs the
`calendar` permission, so staff and owners cancel. It runs through the shared dispatcher with an idempotency key like
every other write. `BookingRecord.status` is `confirmed` or `cancelled`.

**B-30. Desired, state.** `confirmed` becomes `cancelled` once and never goes back. The handler sets `cancelled_at` to
the clock read under the lock (B-31), `cancelled_by` to the acting member and `cancel_reason`; a check keeps the three columns set
exactly when the status is `cancelled`. The runtime role may update only those four columns, and a trigger refuses any
runtime update of a row that is already `cancelled`. The booking row, its ID and its customer link stay: a cancelled
booking can still be read, and its ID is never reused (B-19 still sees it).

**B-31. Desired, the write.** After the dispatcher's idempotency lock, take the B-21 resource lock, lock the booking
row `FOR UPDATE`, then decide on the locked state:
- `confirmed` and not over (`ends_at` after the dispatcher's time): cancel it.
- already `cancelled` (a second call under another key, or a customer link that got there first): change nothing, return
  the stored cancellation with `customerNotice: "already_cancelled"`, send nothing.
- `ends_at` at or before the time: `Conflict` `details.reason = "booking_over"`.
The time is the injected clock, read once after the resource lock is held, so a long wait for the lock cannot cancel a
booking that has since ended; that same time is `cancelled_at`.
A booking ID that does not exist for the caller's tenant, including one that exists only in another tenant, is
`NotFound` before any lock: tenant B learns nothing about tenant A's bookings.

**B-32. Desired, the slot is free.** A cancelled booking takes no part in availability. The exclusion constraint ignores it
(B-20), `loadBusy` ignores it (B-13), and the calendar push to Google ignores it (google-calendar.md G-10). Lists return
`confirmed` bookings by default; `status=cancelled` or `status=all` read the history. Those two reads use a plain
overlap test, because cancelled rows may overlap anything. The booking detail read always works and adds `cancelledAt`
and `cancellationReason` to a cancelled booking only. A new booking can take the freed slot at once (the same
transaction order as B-21 makes the cancel and the new create serialize).

**B-33. Desired, the customer's notice.** When the booking is cancelled by this call and `notifyCustomer` is true, the
handler looks up the customer (an owner's link, else the contact of the website request, `booking-customer.md` BC-6).
With a contact that has a usable email, the action's one outbox event is `message.send_requested` (delivery.md D-1):
a `transactional` email whose message ID derives from the tenant and booking, so a booking is ever noticed once. The
email names the business, the local start time and the zone, and never the owner's reason. Delivery re-checks
suppression, the approval of this action and the wallet (D-5, D-6). The result's `customerNotice` says what happened:
`queued`, `off`, `no_customer`, `no_email` or `already_cancelled`. A cancellation never fails because a notice cannot
be sent.

**B-34. Desired, audit.** The audit trail of a cancellation is the `actions` row (actor, time, payload with the reason,
result) written with the booking change in one transaction, plus the three `cancelled_*` columns. With no notice the
outbox event is the dispatcher's default `booking.cancel` event; with a notice it is the `message.send_requested` event
(`outbox_one_per_action`), and the action row remains the record. An identical retry returns the stored action and
result and writes nothing.

**B-35. Desired, tenancy.** Tests cover: tenant B cannot cancel, read the cancellation of, or list tenant A's bookings
through the action or the reads; the runtime role of tenant B updating tenant A's booking by direct SQL changes zero rows
(RLS); the runtime role cannot reopen a cancelled booking, change another column, or cancel without `cancelled_at`; the
overlap constraint accepts a booking over a cancelled one and still rejects a booking over a confirmed one (two concurrent
creates for one freed slot: one wins, one gets `Conflict`).

**B-36. Known limits (revision 3).** These are decided, not forgotten.
- The trigger of B-30 exempts only the service role (the workers), the same test as
  `calendar_connections_runtime_guard` (google-calendar.md G-4); a session that leaves `SET ROLE` still runs under it.
- A Google event already pushed for the booking stays on the owner's calendar: the Google client has no delete call yet.
  A push that has not been sent is dropped, including one claimed but not yet sent (the send re-checks `confirmed`);
  the worker marks the unsent push `failed` with `booking_cancelled` once its lease ends.
- The dashboard lists confirmed bookings only. A cancelled booking, with its reason, is read through the API or the
  `cancel_booking` result; a history view is a later change.
- A repeat cancel under a new key still writes an `actions` row and the default `booking.cancel` event, although it
  changes nothing (`already_cancelled`).
- Home's "bookings taken" counts every booking by `created_at` (inbox-home.md H-4), cancelled ones included.
- A tenant on a read-only plan cannot cancel (PL-8 lists the allowed actions; `booking.cancel` is not one).
- A reminder or review message already queued before the cancel is not recalled. New ones skip a cancelled booking
  (`CUSTOMER_BOOKINGS` reads `confirmed` only). A review request also needs the booking to be `completed` (B-43).
- There is no automation-catalog `booking.cancelled` event and no `propose_booking_cancel` for automation tokens. Both need
  an `automation_scope` enum change and come with a later revision.
- The cancellation email is an ordinary charged message (D-6): with an empty wallet, a suppressed address or a revoked
  approval the cancel still succeeds and delivery drops the notice later, so `queued` means handed to delivery, not
  delivered. The dashboard says "queued".

## Outcomes (revision 4)

Evidence and decisions: the first client's owner asked for it. A review request went out on elapsed time alone (`agents.md`
G-20 selected `confirmed` bookings whose end had passed), so a customer who never came could be asked how the visit was. Only
the business knows who came, so the business says so, and the review request waits for that answer. The cancel action
(B-29..B-35) is the style copied: one dispatcher action, the resource lock, a row lock, the injected clock read after the
locks, one outbox event.

**B-37. Desired, the values.** A booking has an outcome: `completed` (the customer came and was served), `no_show` (the
customer did not come) or `unknown`. `unknown` is the absence of a mark and the default: a new booking is `unknown`, and so
is a past booking nobody marked. The database stores no `unknown` value; the column `bookings.outcome` is null for it. The
reads report `outcome` as `completed` or `no_show`, and leave the key out when the booking is `unknown` (B-47); a request can
only set `completed` or `no_show`, because a mark is never cleared (B-39).

**B-38. Desired, the action.** `booking.outcome.set` has target type `booking` and payload `{bookingId, outcome}`, with
`outcome` one of `completed` or `no_show`. The HTTP route is `POST /v1/booking/bookings/:id/outcome` with body
`{ "outcome": "completed" | "no_show" }` and an `Idempotency-Key`; the MCP tool is `set_booking_outcome`. Both bodies are
strict: no other field is accepted, and a missing or other `outcome` is `ValidationFailed`. The action needs the `calendar`
permission, so owners and staff may mark, the same as cancelling (B-29). It runs through the shared dispatcher with an
idempotency key like every other write, and a tenant on a read-only plan cannot mark one (PL-8; the action is not on its
allowed list). The reply is `{ booking, outcome, outcomeAt, changed }`: the booking record, the stored mark, when it was
set, and whether this call changed it.

**B-39. Desired, when and whether it changes.** The time is the injected clock, read once after the B-21 resource lock
is held, and it must be at or after the booking's `starts_at`. Before the start the action is `Conflict` with
`details.reason = "booking_not_started"` and nothing changes; there is no upper bound (a booking from last month can still be
marked). A mark can be replaced by the other value (`completed` to `no_show`, or back): the owner may have tapped the wrong
button. It is never cleared back to `unknown`. Setting the value the booking already has changes nothing and returns
`changed: false` (no second write, the stored `outcomeAt` stays). A booking that is `cancelled` has no outcome: the action is
`Conflict` with `details.reason = "booking_cancelled"`. A booking ID that does not exist for the caller's tenant, including one
that exists only in another tenant, is `NotFound` before any lock.

**B-40. Desired, the record.** The row keeps the latest mark: `outcome`, `outcome_set_at` (the clock read under the lock) and
`outcome_set_by` (the acting member). A check (`bookings_outcome_fields`) keeps all three set together or all null, so a
mark cannot be stored without the member who set it, and keeps them null on a cancelled row. The history is the `actions` rows (`booking.outcome.set`, with actor, time, payload and result): every change is its own
row, so a mark replaced twice leaves three rows. The runtime role may update only `outcome`, `outcome_set_at` and
`outcome_set_by` through this action (a column grant), and the trigger of B-30 still refuses any runtime update of a
cancelled row.

**B-41. Desired, cancel clears it.** `cancelBookingRow` clears the three outcome columns in the same update that cancels (a
booking that has started but not ended can be marked, then cancelled). A cancelled booking therefore has no outcome (B-39).
The customer's own cancel and move (`booking-self-service.md` BS-6, BS-8) run the same function and need no change.

**B-42. Desired, the events.** The action writes the dispatcher's default outbox event `booking.outcome.set` with the mark in
its result; there is no customer message and no automation-catalog event (the same limit as B-36 for cancel). A call that
changes nothing (`changed: false`) still writes its `actions` row and event, like a repeat cancel.

**B-43. Desired, review requests.** A review request (`agents.md` G-20) is queued only for a booking that is `confirmed` and
whose `outcome` is `completed`. A `no_show`, a `cancelled` and an `unknown` booking never queue one: they are not candidates,
so no decision row is written for them either. The check sits where the candidates are read (`findKindCandidates`) and again
inside the queue action's locks and the skip action (`loadBookingFact`), so a caller that bypasses the runner is refused
with `Conflict` `not_a_candidate`. Both actions take the booking row `FOR SHARE` (`lockBookingRow`) immediately before that
read, after the `booking_contacts` lock. A mark or a cancel holds the row `FOR UPDATE` until it commits, so the queue either
waits for it and reads the committed answer, or commits first and the later mark waits; the mark and the cancel never slip in
between the read and the queue. The queue is not the last gate: delivery checks again at send time (below and `delivery.md`
D-6).

Delivery. A message that belongs to a queued `review_request` decision (`agent_decisions.message_id`, `subject_type =
'booking'`) is sent only while its booking is still `confirmed` and `completed`. Otherwise the delivery is `blocked` with
final reason `booking_not_completed`, and the provider is not called. This is the stronger half of the rule: it covers an
owner correcting `completed` to `no_show` after the request was queued, a cancel after the queue, and a request queued before
outcomes existed (B-44). The check reads the booking row at the delivery's own re-check, after the approval and consent checks. Appointment reminders are unchanged: they still need `confirmed` only, because a reminder
goes out before the visit, when no outcome can exist. G-20's other rules (consent, window, caps, once per booking) still apply.

**B-44. Desired, bookings that ended before this ships.** The migration adds the columns and writes no data: every existing
booking is `unknown`, so none of them gets a review request, including one that ended inside the lookback window. This is
decided, not forgotten: a review request is a message to a customer, and the business never said whether they came. A review
request that was queued by the earlier code and has not been sent when this ships is stopped at delivery with
`booking_not_completed`, because its booking is `unknown` (B-43); one already sent is not recalled. An owner
can mark an old booking `completed` (B-39 has no upper bound); it is then a candidate again if it still lies inside the
`lookbackDays` window.

**B-45. Desired, tenancy and tests.** Tests cover: staff and owner may mark, a request without the `calendar` permission is
refused; an outcome before the start time is `booking_not_started` by the injected clock, and one exactly at the start is
accepted; `completed` replaced by `no_show` and back, each recorded in `actions`; the same value again changes nothing;
idempotent replay (same key, same result, no second `actions` row; the same key with another body is an
`IdempotencyConflict`); a cancelled booking is refused and cancelling a marked booking clears the mark; tenant B cannot mark,
read the mark of, or list the marks of tenant A's bookings, and the runtime role of tenant B updating tenant A's booking
by direct SQL changes zero rows, and the runtime role cannot set an outcome on a cancelled row or set `outcome` without its
stamp or the stamp without a mark, including a null `outcome_set_by` (checks and trigger); the `booking.outcome.set` outbox
row; review requests through queueing and delivery for a `completed` booking (queued and sent) and for `no_show`,
`cancelled` and unknown bookings (no decision, no message); a queue transaction that starts while a mark or a cancel is
uncommitted waits for it and then reads the committed answer (and does not wait when nothing is in flight); a request queued
as `completed` and then corrected to `no_show`, cancelled, or left with no mark, is `blocked` with `booking_not_completed` at
delivery, and any new request is still refused; a booking body with no `outcome` key and with `outcome: null` both parse
(B-47); the API route, the MCP tool and the dashboard control, the Agents page condition line and the toast copy.

**B-46. Known limits (revision 4).** These are decided, not forgotten.
- A review request already queued when the owner changes `completed` to `no_show` is not recalled from the queue, but it is
  never sent: delivery re-reads the booking and blocks it with `booking_not_completed` (B-43). A request that was already
  sent cannot be taken back, so the dashboard toast promises only that one "that has not gone out yet" will not be sent.
- A booking still in progress can be marked (the start has passed); the owner may mark it again after it ends.
- An `unknown` booking that ended long ago is not flagged or nagged; the dashboard shows an unmarked past booking with the two
  buttons and nothing more. A reminder for the owner to mark is a later change.
- There is no "mark all" and no bulk call.
- Home's counts and the automation catalog do not use the outcome yet.

**B-47. Desired, the read shape and the rollout.** `outcome` follows the API's present-only-when convention (as `cancelledAt`
and `outcomeAt` do): the booking summary and detail carry `outcome` only on a marked booking, and the key is absent for
`unknown`. The schema is `outcome: "completed" | "no_show" | null`, optional, so a body with the key missing and a body with
`null` both parse and both mean `unknown`; the server never sends `null`.

Why the server omits the key: the dashboard that is deployed before this change parses booking bodies with a strict object, so
it rejects any key it does not know, `outcome: null` included. Omitting the key keeps new API plus old dashboard working for
every booking nobody has marked. It does not help for a marked booking: the old dashboard cannot read one. So the order is
fixed:
1. Deploy the dashboard that carries the tolerant schema (it also hides the controls on a server that sends no `outcome`).
2. Then deploy the API, MCP server and migration that let a booking be marked.
3. Reload any open dashboard tab before the first mark; a tab still on the old build fails to read a marked booking.

Old API plus new dashboard works at once, because a missing `outcome` means `unknown`. Rolling the API back after marks exist
is safe for the dashboard (marked rows are simply not sent). No two-PR split is needed: the only unsafe order is API first.
