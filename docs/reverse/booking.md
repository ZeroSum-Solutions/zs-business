# F1 booking: reverse-engineering record

Authority: `docs/requirements/booking.md` (B-1..B-28). Sources were read for behaviour
only. No code was ported, so `NOTICE` needs no new entry (see section 4).

## 1. What was studied, and where

All cal.diy paths are at commit `54343aa685ae8f33159d2f485ec4a57bad5c574a`, read with
`git show 54343aa:<path>`. The scheduler is the read-only clone at
`/Users/zero-suminc./.cache/zs-sources/rise-scheduler-64b7fe78` (commit `64b7fe78`). No REA
evidence ids: the sources are plain repositories, so source reading was enough.

| Ref | Location | Behaviour observed |
| --- | --- | --- |
| U1 | cal.diy `packages/features/schedules/lib/slots.ts:97` | Sorts the caller's `dateRanges` array in place. |
| U2 | `slots.ts:113` | Rounding interval falls back to `process.env.NEXT_PUBLIC_AVAILABILITY_SCHEDULE_INTERVAL`. |
| U3 | `slots.ts:114-121` | Derives the rounding interval from the first divisor of the frequency in `[60,30,20,15,10,5]`. |
| U4 | `slots.ts:123` | Reads the ambient clock (`dayjs.utc()`) and adds the notice. |
| U5 | `slots.ts:133` | Clears seconds and milliseconds after taking the notice bound. |
| U6 | `slots.ts:138-147` | Converts to the target zone before checking minute alignment (half-hour zones). |
| U7 | `slots.ts:27-69` | Optional "optimized slots" shifts starts toward hour/15/5-minute marks. |
| U8 | `slots.ts:178` | End test subtracts one second: `start + length - 1s` must not be after the range end. |
| U9 | `slots.ts:99-100,179-183` | Deduplicates slots by start key in a `Map`. |
| U10 | `packages/trpc/server/routers/viewer/slots/util.ts:672-673` | Notice helper: `minimumBookingNotice \|\| 1` (zero notice becomes one minute). |
| U11 | `util.ts:1093-1097` | Duration falls back to event length; step is `slotInterval \|\| duration \|\| length`. |
| U12 | `util.ts:1148-1156` | Restriction schedule keeps a slot only if start and end lie within one range (inclusive). |
| U13 | `util.ts:927-947,1312-1345` | Period types (rolling, rolling window, range) and `isTimeOutOfBounds` limit the booking window. |
| U14 | `util.ts:134,911` | Reads configuration from `process.env` inside the service. |
| R1 | rise-scheduler `backend/src/services/booking.ts:42-50` | `claimSession`: conditional `UPDATE ... WHERE status='available'` arbitrates competing claims on one pre-existing row. |
| R2 | `booking.ts:38` | Falls back to a default database handle when no transaction is supplied. |
| R3 | `booking.ts:47,67-77` | Uses an ambient `new Date()` and writes an audit row after the claim. |

## 2. Obligation ledger

Paths are relative to the repo root. `slots.test.ts`, `create.test.ts`, `public.test.ts`
and `integration.test.ts` are in `packages/core/test/booking/`.

| Rule | How the code meets it | Proof |
| --- | --- | --- |
| B-1 | One resource per tenant: `booking_resources_one_per_tenant` (`supabase/migrations/20261017170000_booking.sql:84`). Only `booking.create` is registered (`packages/core/src/booking/create.ts:125`). | `integration.test.ts`; `create.test.ts` "commits state, action and outbox" |
| B-2 | `getAvailableSlots` is synchronous, parses first, calls `clock.now()` once (`slots.ts:135-138`); `readClock` rejects non-finite (`slots.ts:128`). No DB or env access; the ambient scan covers `src/`. | `slots.test.ts` "reads the clock exactly once…"; `test/ambient.test.ts` |
| B-3 | Frozen schemas through `safeParse`, failures become `ValidationFailed` (`slots.ts:136`, `create.ts:78,130`). | `slots.test.ts` "rejects … with ValidationFailed" (8 cases); "accepts exactly 31 days" |
| B-4 | Zones are checked by the frozen schema. The engine uses `Intl` only (`time-zone.ts:9-21`) and echoes the input identifier (`slots.ts:151`). SQL compares UTC `timestamptz` only. | `slots.test.ts` "rejects zone …" (6), "accepts a lowercase IANA name", "supports Etc/GMT+5" |
| B-5 | ISO weekday from civil days (`time-zone.ts:47`); per-date windows merged (`slots.ts:63`); availability merged across dates (`slots.ts:113`); window spans merged per day (`slots.ts:59`). | `slots.test.ts` "merges overlapping windows", "joins windows touching across midnight", "missing weekday" |
| B-6 | Override replaces the weekly day, empty closes it (`slots.ts:78`). Duplicates rejected by schema and SQL (`migration:26-68`). | `slots.test.ts` "closes a date with an empty override"; `buffers-override` fixture; `create.test.ts` stored-config cases |
| B-7 | Constant-offset segments (`time-zone.ts:81`) map wall-clock windows to UTC per segment (`slots.ts:96-110`). A gap label maps outside every segment; an overlap label maps into two. | `dst-gap`, `dst-overlap` fixtures; `slots.test.ts` "spring gap", "European fall overlap" |
| B-8 | Grid `minute = k*step` on each local date, per segment (`slots.ts:105-108`). | `alignment-notice` fixture; `slots.test.ts` "45-minute step … half-hour zone"; `create.test.ts` "misaligned start" |
| B-9 | Slot end = start + elapsed length; must sit inside one merged availability span (`slots.ts:120-121`). | `dst-gap` fixture; `slots.test.ts` "keeps elapsed duration across the spring gap" |
| B-10 | Half-open, exact-ms containment in the query range (`slots.ts:119`). | `slots.test.ts` "allows an appointment ending exactly at the range end…" |
| B-11 | `earliest = max(from, now + notice)`, inclusive, ms preserved (`slots.ts:88`). | `slots.test.ts` notice tests; `create.test.ts` "one millisecond short of notice", "accepts … exactly at the notice bound" |
| B-12 | `start < now + horizon` (`slots.ts:89,119`); notice ≥ horizon returns `[]` (`slots.ts:90`). | `slots.test.ts` "treats the horizon as an exclusive start bound", "horizon zero"; `create.test.ts` "start exactly at the horizon" |
| B-13 | Booking entries expand saved buffers once; external entries are used as is (`slots.ts:140-145`); union by merge (`slots.ts:114`). Tenant/resource match is a schema refine. | `slots.test.ts` "unions duplicate and unsorted busy entries", "foreign busy entry" |
| B-14 | Candidate occupied `[s-before, e+after)` against merged busy, touching allowed (`slots.ts:122`, `overlapsAny` `slots.ts:41`). | `slots.test.ts` "lets preparation time extend…", "uses a booking's saved buffers…" |
| B-15 | Recheck loads busy rows by intersection with the occupied range, not the date (`create.ts:52-66`). Buffers are never clipped. | `slots.test.ts` "previous-day booking", "next-day external block"; `create.test.ts` both B-15 cases |
| B-16 | Output sorted and unique (Set then sort, `slots.ts:94,117`); input never mutated (`mergeSpans` sorts a copy, `slots.ts:19`). | public fixtures (`expect(input).toEqual(before)`); `slots.test.ts` union test |
| B-17 | Wrapper parses `createBookingCommandSchema` (`create.ts:130`); handler re-parses (`create.ts:78`); duration, buffers and status come from stored state only. | `public.test.ts` B-17/B-18; `create.test.ts` "rejects an invalid command without dispatching" |
| B-18 | Forwards parsed data once, validates the envelope, no catch (`create.ts:129-135`). | `public.test.ts` B-17/B-18; `create.test.ts` B-18 test |
| B-19 | `resolveTarget` checks tenant scope and throws `Conflict{reason:"id_in_use"}` (`create.ts:69-75`). `handle` locks, loads the owned resource or throws `TenantDenied` (`create.ts:31-38,87`), rechecks the ID under the lock (`create.ts:88`), re-evaluates with dispatcher `now` and throws `Conflict{reason:"slot_unavailable"}` (`create.ts:97-98`). | `create.test.ts` "rechecks a slot that was shown…", 5 `slot_unavailable` cases, "denies another tenant's resource", "reports id_in_use…" |
| B-20 | `bookings_resource_occupied_excl` (`migration:117-121`), immediate, no `WHERE`. The dispatcher maps `23P01` to `Conflict`. | `create.test.ts` "exactly one of two concurrent overlapping creates", "wider race", "two concurrent overlapping direct inserts" |
| B-21 | Exact lock expression after the dispatcher's idempotency lock (`create.ts:83-86`); UUIDs cast through `::uuid::text` (lowercase). No UPDATE grant (`migration:165-166`). | `create.test.ts` "holds the B-21 resource lock…" (uppercase input, waits, then sees the block); "rejects an overlapping direct insert…" |
| B-22 | Success comes only from the dispatcher commit; the row stores `confirmed`, dispatcher `now` and the buffers used (`create.ts:100-121`). | `create.test.ts` "commits state, action and outbox together", "keeps saved buffers…", "rolls back the booking row…" |
| B-23 | Dispatcher replay and error semantics unchanged; the handler throws typed `ActionError`s only for domain failures; corrupt stored config throws a plain error (`create.ts:47`). | `create.test.ts` "returns the stored action for an identical retry…", "rolls back…" (`ValidationFailed`, `BindingMismatch`) |
| B-24 | Three tables, required columns, `timestamptz`, PKs, composite FKs, checks, exclusion (`migration:70-138`); Drizzle mirror in `packages/db/src/schema/booking.ts`. | `integration.test.ts`; `create.test.ts` stored-config cases |
| B-25 | `tenant_id NOT NULL` + tenant FK, RLS enabled and forced with matching `USING`/`WITH CHECK` (`migration:140-154`); minimal grants (`migration:158-173`). | `packages/db/test/isolation.test.ts` (catalog-driven, picks the three tables up); `create.test.ts` "enables and forces RLS…", "rejects a cross-tenant insert…" |
| B-26 | Public folders stay out of baseline `test`; booking tests are normal tests with no skips. | `pnpm -r test`, `pnpm --filter @zs/core test:booking` |
| B-27 | `bookingHandlers` has exactly `booking.create`, frozen (`create.ts:125-127`), exported through `src/index.ts`. | `integration.test.ts` |
| B-28 | Seed INSERTs supply exactly the B-24 columns. Defaults on `time_zone`, `weekly`, `overrides`, booking buffers and `status` only keep catalog fixtures constructible. Runtime may INSERT/SELECT `bookings`; service role has full access. | `integration.test.ts`; `create.test.ts` direct-insert, `23P01` and `42501` tests |

## 3. Desired vs upstream

| Upstream | What we do instead | Why |
| --- | --- | --- |
| U1 sorts the caller's array in place | Sort copies (`mergeSpans`) | B-2/B-16 purity |
| U2, U14 read `process.env`; U4, R3 read the ambient clock | Injected clock; the step comes only from the stored resource | B-2, AGENTS.md "inject the clock and config" |
| U3, U7 derive or optimize rounding | One explicit `slotStepMinutes` grid on local minute-of-day | B-8: no hidden fallback or offsets |
| U5 clears seconds after the notice bound | Keep ms precision; take the next grid point at or after the bound | B-11: never give less notice than configured |
| U8 subtracts one second at the end boundary | Exact-ms half-open containment | B-10 |
| U10 turns zero notice into one minute | Zero notice permits `start == now` | B-11 |
| U11 duration/interval fallbacks | Length and step are required fields | B-3, B-8 |
| U12 inclusive range containment for restrictions only | The same exact containment for every check | B-10 |
| U13 calendar-day period modes | One elapsed-minute horizon | B-12 |
| R1 conditional update of one pre-existing row | Insert under a range exclusion constraint plus an advisory lock | B-20/B-21: independent rows cannot be arbitrated by a status flag |
| R2 default DB handle | Always the dispatcher's transaction | B-22: state, action and outbox commit together |

Other choices:
- Zone offsets come from `Intl` sampled hourly, with each change located to the second
  (`time-zone.ts:81`). cal.diy uses dayjs plugins; we use no date library.
- The SQL time-zone check covers only the accepted shape. `Intl` decides whether a name
  is known, so SQL never uses a second tz database (B-4).

## 4. Licence notes

- No file contains code ported from cal.diy or any other MIT source. The engine
  (interval segments, union of wall-clock membership, binary searches) is original and
  follows the B-rules, not cal.diy's loop structure. So no MIT header and no `NOTICE`
  entry is needed. The similarity scan required by `docs/licenses.md` should still run
  before merge.
- rise-scheduler is our own code. It was read only. Nothing was copied, run or installed.
- SeldonFrame, HighLevel and `.t3-runs` were not opened.

## 5. Known gaps

- The SQL time-zone check is shape-only (`'UTC'` or contains `/`). An unknown name such
  as `Foo/Bar` can be stored by service-role SQL. The create handler then raises a plain
  error (corrupt configuration), not a typed one.
- `offsetSegments` assumes at most one offset change per hour. Every tzdb zone meets this.
- Busy bounds from SQL are widened to whole milliseconds (floor/ceil). A sub-millisecond
  external block edge can reject a candidate that touches it exactly.
- Years after 9999 cannot be represented by the frozen instant schema. The engine does
  not guard against them beyond the schema.
- Resource provisioning, schedule edits and external-block sync have no write actions
  yet (B-1). When they land they must take the same B-21 lock through the dispatcher.
- No second-model review ran inside this task's time box. Run `codex-senior-review` and
  the MIT similarity scan before marking a PR ready.
