# @zs/dashboard

The owner dashboard: a phone-first Next.js 16 PWA with six areas (Home, Inbox, Calendar,
Customers, Site, Agents). Settings, Connections and Plan sit under the account menu.

## Run it

```sh
mise exec -- pnpm --filter @zs/dashboard dev     # http://localhost:3200
mise exec -- pnpm --filter @zs/dashboard build
mise exec -- pnpm --filter @zs/dashboard typecheck
mise exec -- pnpm --filter @zs/dashboard test    # vitest, no browser
mise exec -- pnpm --filter @zs/dashboard e2e     # Playwright on the demo adapter, phone 390x844 and desktop 1440x900
mise exec -- pnpm --filter @zs/dashboard e2e:live  # the same journeys against the real API and Postgres
```

`e2e` builds the app and serves it on `127.0.0.1:3217`; it always starts its own server
(`reuseExistingServer: false`), so a stale build on that port cannot answer. Screenshots of every area go to
`e2e/__screenshots__/` (gitignored). First run: `pnpm exec playwright install chromium`.
`e2e/retries.spec.ts` covers retries after a lost response (the demo adapter's
`loseNextResponse`, `setOffline` and `writeLog`). `e2e/layout.spec.ts` covers focus
return after Escape on every sheet and controls clear of the phone tab bar.
`e2e/retries.spec.ts` also covers late answers: a customer save that lands after its dialog
was reopened or closed, and a deal reload that fails after a conflict (`failDealReads`).
`e2e/offline.spec.ts` runs with service workers allowed: install, go offline, reload,
still styled and working; `/api` responses are never stored. `e2e/session.spec.ts` covers
the signed-out state after a 401 and sign-out, and that no cached query outlives either.
`e2e/a11y.spec.ts` runs axe (default rules, no serious or critical issues) on every area at
both viewports and checks 44px targets, `label[for]` targets, visible reasons on disabled
buttons, focus rings no overflow clips, one visible h1 in an open conversation, and toasts
that stay 10 seconds and can be dismissed from the keyboard.
`e2e/body-limits.spec.ts` (desktop only) starts the same build a second time in live mode,
with an in-process fake Supabase Auth, and sends raw chunked and `Content-Length` uploads
past the sign-in (2 KiB) and proxy (64 KiB) limits: each gets 413 while still sending, and
a client that hangs up mid-body leaves the server serving.

`e2e:live` needs the local test cluster at `127.0.0.1:55432` (or `ZS_TEST_DATABASE_URL`,
loopback only). Its global setup (`e2e/live/global-setup.ts`):

1. creates a throwaway `zs_e2e_*` database;
2. runs `@zs/api seed:demo` with a random `JWT_SECRET` (migrations, the `zs_runtime` login,
   the local auth stub, the Halden & Rowe seed with its owner as a member, and a 7-day dev
   JWT). It adds a staff member (`staff@example.com`) and a signed-up person who belongs to
   no business to the auth stub, and signs one-hour tokens (`role` authenticated, a
   run-specific `iss`, always an `iat`, and a live `session_id` in `auth.sessions`) for the
   owner, the staff member and the outsider. The staff token makes the conflicting writes;
3. serves a fake Supabase Auth (`e2e/live/fake-gotrue.ts`) on a free loopback port. It
   answers the GoTrue endpoints the dashboard uses (`/otp`, `/verify`, `/token`, `/logout`,
   `/user`), signs access tokens with the run's secret and keeps sessions in the run's
   `auth.sessions` stub (`e2e/live/pg-auth-store.ts`).
   It sends no email: it keeps the last link per address at `GET /__test/last-link`;
4. starts `@zs/api` on port 8798 as `zs_runtime` with `JWT_ISSUER` set,
   `JWT_MAX_TTL_SECONDS=3600` and `JWT_CLOCK_SKEW_SECONDS=60`, the production defaults, and
   `SESSION_CHECK=supabase` against the fake's `/user` with no cache, so the API sees a
   sign-out on the next request, as hosted;
5. builds the dashboard into `.next-live/` with `ZS_API_URL`, `SUPABASE_URL` (the fake) and
   a random `SUPABASE_ANON_KEY` (all server-only), with the sign-in limits raised for the
   run, and serves it on `127.0.0.1:3218`. It fails if the build output holds any token,
   the JWT secret or the anon key. Every test's `page` signs in the way a person does: it
   asks for a link at `/sign-in` and opens it (`e2e/live/fixtures.ts`); `anonymousPage` and
   the bare `request` context never sign in;
6. snapshots the seeded bookings, contacts and deals into a `zs_e2e` schema. Before each
   test the `seededRows` fixture (`e2e/live/fixtures.ts`, `e2e/live/reset.ts`) deletes
   rows added since and restores every deal's stage and revision, so tests do not depend
   on order. It refuses any database that is not a loopback `zs_e2e_*` one.

No child process inherits the shell's environment (`e2e/live/child-env.ts`): each gets
`PATH`, `HOME`, locale and terminal variables plus what setup sets. Before each start,
setup checks that every database variable (`*DATABASE*`, `*_DB_*`, `POSTGRES*`,
`SUPABASE*`) names the run's `zs_e2e_*` database on loopback, and refuses any libpq `PG*`
variable. The one exception is `SUPABASE_URL` (with its anon key), which must be the run's
fake auth server on loopback. So a `RUNTIME_DATABASE_URL` in your shell cannot reach the seed or the API.

The live run also checks that the API refuses the 7-day seed token and tokens with the
wrong role, no issuer, no `iat`, a lifetime one second over the cap or a signed-out
session (401), and a signed-in person who is not a member (403); that staff can read the
calendar but not the team list. It checks that the
browser makes no request to the API origin and sends no `Authorization` header, that an
anonymous caller, the old pilot cookie and a caller's own bearer token all get 401 from the
proxy and `/api/session`, that an unknown address gets the same answer as the owner's and
no link, that a visitor signs in by email link and out again (the `zs-auth` cookies are
httpOnly and `SameSite=Strict`, a link works once, and after sign-out cookies copied
before it get 401), that the
proxy refuses a cross-site POST and a forged `X-Forwarded-Host`, that a failed reload after
a deal conflict keeps the move off, that slots for an unknown calendar answer 403 with the
same body the demo adapter sends, and that a booking whose answer was dropped is retried
with the same `Idempotency-Key` and replayed by the API.

The tests make the conflicting writes (a booking for the chosen time, a re-save of a deal)
through the API with the staff token. Teardown stops the servers, drops the
database and deletes `.next-live/` and `test-results/live/`, also when setup fails.
Server logs go to `test-results/live/` with every JWT replaced by `[redacted-jwt]`
(`e2e/live/redact.ts`); set `ZS_LIVE_KEEP_LOGS=1` to keep them. Setup also keeps them when
it fails. Playwright traces are off, since a trace would record the page's requests.
Screenshots are prefixed `live-`. Phone and desktop share one database, so they run one after the other
on separate seeded deals. It is not in CI: the CI e2e job has no Postgres service, and a
second production build plus the live run would push that job past about four minutes.

## Data

All data goes through one typed client in `src/lib/api/`. Components use the hooks in
`src/lib/queries.ts` and never import the demo adapter.

- `ZS_API_URL` set: live mode. The browser calls the same-origin proxy `/api/v1/...`
  (`src/app/api/[...path]/route.ts`, `src/lib/server/api-proxy.ts`), which sends the
  signed-in person's own Supabase access token as `Authorization: Bearer` and forwards to
  `apps/api`. The API checks the token, that its session is still live in Supabase Auth,
  and the person's membership and role on every request. All settings are server-only; the
  build only learns `NEXT_PUBLIC_API_MODE=live`. The proxy passes only GET, POST and DELETE
  to `/v1/booking/*`, `/v1/crm/*`, `/v1/me` and `/v1/members*`, only `Accept`,
  `Content-Type` and `Idempotency-Key`, refuses cross-site callers and non-JSON POSTs, and
  answers `no-store`. A POST body may be 64 KiB and must arrive within 15 seconds; it is
  read through `src/lib/server/body.ts`, which never holds more than the limit: a larger
  declared `Content-Length` gets 413 unread, a chunked upload is cancelled as soon as it
  passes the limit (413), a stalled one at the deadline (408), and a dropped one is 400.
  A request whose `Sec-Fetch-Site` is present and not `same-origin` is refused, and so is
  an `Origin` that is not the request's `Host`. `X-Forwarded-Host` counts instead of
  `Host` only with `DASHBOARD_TRUST_PROXY=1`.
- Sign-in (`src/lib/server/supabase.ts`, `src/lib/server/sign-in.ts`): Supabase Auth with
  an email link, through `@supabase/ssr` on the server only. Live mode needs `SUPABASE_URL`
  and `SUPABASE_ANON_KEY`; while either is missing, the proxy, `/api/session` and sign-in
  answer 503 and the server log says which. The anon key never reaches the browser.
  - `POST /api/sign-in` `{ email, next? }` asks Supabase to email a link
    (`shouldCreateUser: false`: people join only by invitation) and always answers 204, so
    it never tells whether an address has an account. The link goes to `/auth/confirm` on
    the host the browser used (after the same-origin check), so the Supabase redirect allow
    list must hold only this dashboard's URL. Requests are rate limited in memory, 5 per
    address and 30 in total per 15 minutes by default (`DASHBOARD_SIGN_IN_PER_ADDRESS`,
    `DASHBOARD_SIGN_IN_GLOBAL`), then 429 with `Retry-After`. The body may be 2 KiB and must
    arrive within 10 seconds, read the same bounded way (413 `too_large`, 408 `timeout`).
    Each attempt is reserved before its body is read, so parallel requests cannot outrun
    the limit, and a refused body still counts; one Supabase could not take is given back.
    The address comes from the right-most `X-Forwarded-For` entry only with
    `DASHBOARD_TRUST_PROXY=1`; otherwise every caller shares one key.
  - `GET /auth/confirm?token_hash=…&type=email&next=…` verifies the link with Supabase and
    sets the session cookies: `zs-auth` (split into `zs-auth.0`, `zs-auth.1`, … when long),
    httpOnly, `SameSite=Strict`, `Path=/`, `Secure` over https. It then redirects to
    `next`, which leads only to a page on this site (`src/lib/safe-next.ts`). A used,
    expired or forged link goes back to `/sign-in?error=link`. The Magic Link email
    template must link to `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email`, so
    the link works on any device.
  - The server refreshes the access token from the refresh token when it is near expiry
    and writes the new cookies on that response. When Supabase refuses the session, or the
    API answers 401, the cookies are cleared and the browser shows the signed-out screen.
  - "Sign out" posts `/api/sign-out`, which revokes the session in Supabase
    (`signOut({ scope: "local" })`: this session only) and clears the cookies. The API asks
    Supabase Auth whether the session is live, so cookies copied before sign-out get 401 within
    its short cache window. If Supabase cannot be reached the answer is 502 and the cookies
    stay, so Try again can still revoke the session. Without the Supabase settings, a request
    holding a session cookie gets 503 `sign_out_unavailable` and keeps it too.
    The browser waits for that answer: the pages and cache go at once, but the signed-out
    screen shows only after a 2xx. A 502 or a network error shows "Sign-out did not
    finish. Try again." with a Try again button that posts again (`src/lib/session.tsx`,
    `src/components/shell/session-gate.tsx`). A 401 from the API ends the session at once
    and posts nothing.
  - The retired pilot cookie `zs_dashboard_session` opens nothing: any request carrying it
    gets 401 (unless it also has a live session) and the cookie is expired.
  `build` runs `scripts/bundle-secrets.ts`, which fails if `.next/static` or a prerendered
  page holds a JWT or the value of `SUPABASE_ANON_KEY`, `ZS_API_TOKEN` or `JWT_SECRET`. See
  `.env.example`; put real values in `.env.local`, which is never committed. Request,
  response, page and error shapes all come from `@zs/contracts` (`http.ts`); calendars and
  pipeline stages come from `GET /v1/booking/resources` and `GET /v1/crm/pipelines`.
- `ZS_API_URL` unset: an in-memory demo adapter serves made-up data for
  "Halden & Rowe Fine Jewelry", including the booking and deal conflicts. Changes reset
  on reload. In demo mode `window.__zsDemo` exposes `bookAsSomeoneElse` and
  `editDealElsewhere` so tests can trigger the conflicts.
- Live mode labels every area that still reads the demo workspace with a "Sample data"
  badge, and disables its writes (cancel plan, agent switches and approvals, settings,
  connections, site edits) with the reason shown as visible text
  (`src/components/ui/sample.tsx`). Nothing pretends to save.
- Errors: the demo adapter parses requests with the same `@zs/contracts` schemas and throws
  the error the HTTP client would build from the API's body: the fixed message per code,
  allowlisted conflict reasons, and 403 (never 404) for an unknown calendar, deal or stage.
  `test/error-parity.test.ts` compares both against `mapError` from `@zs/core`. Shown
  copy comes from the status, `reason` and field, never from the server message.

Errors: every non-2xx body is read with `apiErrorBodySchema`. The client maps the status
to an `ApiError` kind and shows plain copy, not the server message. A 409 with
`details.reason` `overlap` or `slot_unavailable` is a taken slot (`isSlotTaken`) and
`stale_revision` is a changed deal (`isStaleRevision`). A 400 points at the first field in
`details.issues`. The demo adapter throws the same errors. A 409 `stale_revision` or
`concurrent_update` is a changed deal (`isDealChanged`): the board reloads it. A 429 is
`rate_limited` and is never retried. A 401 is `unauthorized`: the session ends.

Session: `GET /api/session` returns `{ tenantId, userId, role }` from the API's `/v1/me`
for the signed-in person (401 `signed_out` with no session, `expired` when it ended or the
browser sent the old pilot cookie; 403 `no_access` when the person is not a member). Every query key starts with that `tenantId`, and queries wait for it
(`useKeys()` in `src/lib/queries.ts`, `src/lib/session.tsx`). Any 401 or "Sign out"
clears the query cache and shows the signed-out screen (in live mode, "Sign out" only once
`/api/sign-out` answers 2xx; until then a "Signing out" screen says so and offers Try again). API reads use `cache: "no-store"`.

Writes: the client never makes up an `Idempotency-Key`; every write method requires one
and throws without it. Every write path (booking, contact, deal move) gets it from
`useIntentKey()` (`src/lib/intent-key.ts`). The key belongs to the full request body (for
a deal move: deal, expected revision, target stage), so a retry of the same write reuses
it and the API replays the first attempt, while any other body (another calendar at the
same instant) gets a new key. The key is dropped once the attempt gets a definitive
answer (2xx or 4xx); after a network error, a 5xx or an unreadable body it is kept. There
is no deal-create screen yet; when one is added it uses the same hook. The booking
and add-customer dialogs count their openings (`useDialogGeneration`,
`src/lib/dialog-generation.ts`): an answer that arrives after the dialog closed or changed
calendar still refreshes the lists, and may confirm itself with a toast while the dialog is
closed, but never closes, clears or navigates away from a newer opening. A deal move that
hits a changed deal says "Reloaded" only once a read that started after the conflict has
succeeded. If that reload fails, the board says so, shows the error with "Try again", and
keeps that deal's move off until a read succeeds.

The list routes take paging only (at most 100 rows a page). The client walks `nextOffset`
and runs contact search, the deal contact filter and the booking date range itself.
It reads at most 20 pages (2,000 rows); past that, lists say "List incomplete — showing
first N" and a contact beyond the cap shows its own error instead of "not found".
There is no single-contact route, so a contact page reads the list. API bookings carry no
customer or title, so live mode shows them as "Appointment".

`TODO(api)`: results, usage, inbox, site, agents, connections and plan have no API yet.
Live mode still reads them from the demo workspace.

## Notes

- Build and dev use webpack (`--webpack`). Turbopack does not map the contracts'
  NodeNext `.js` import specifiers to `.ts` sources.
- `next build` type-checks (`ignoreBuildErrors: false`); `typecheck` runs `tsc --noEmit` (TypeScript 7) on its own.
- Every response, pages and `/api` alike, carries `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` (`next.config.ts`). There is no `script-src`: Next hydrates with inline scripts.
- The service worker (`public/sw.js`) caches the app shell only. On install it caches
  each shell page, then every `/_next/static` script and style those pages and their
  styles reference, so the app opens offline styled and working. `/_next/static` is
  cache-first; pages are network-first with the cached copy as fallback. It is
  registered as `/sw.js?v=<build id>`, so each build gets its own `zs-shell-<build id>`
  cache and older ones are deleted. It stores only same-origin (`basic`), OK responses
  whose type is HTML, JavaScript or CSS and that are not marked `no-store` or `private`.
  It never caches `/v1/` or `/api/` requests, non-GETs or requests with an
  `Authorization` header. It registers in production builds only.
  `test/service-worker.test.ts` runs it against fake caches and network.
- Focus shows as a 2px outline (`:focus-visible` in `globals.css`); inside scrolling
  lists it sits inset (`focus-inset`), and scrolling chip rows reveal a focused chip.
  Toasts stay 10 seconds, pause on hover or focus, close with Escape or "Dismiss", and
  errors stay until dismissed.
- Sheets return focus to the control that opened them (`DialogContent` in
  `src/components/ui/dialog.tsx`). On phones `html` has scroll padding for the top bar
  and tab bar, so scrolled-to and focused controls are never under them.
- Theme tokens come from Mish neutral-product and live in `src/styles/theme.css`.
