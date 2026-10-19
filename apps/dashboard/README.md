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

`e2e:live` needs the local test cluster at `127.0.0.1:55432` (or `ZS_TEST_DATABASE_URL`,
loopback only). Its global setup (`e2e/live/global-setup.ts`):

1. creates a throwaway `zs_e2e_*` database;
2. runs `@zs/api seed:demo` with a random `JWT_SECRET` (migrations, the `zs_runtime` login,
   the Halden & Rowe seed and a 7-day dev JWT). It takes the owner from that JWT and signs
   one-hour tokens (`role` authenticated, a run-specific `iss`, always an `iat`) for the
   owner and for a "second person" in the same business. The second token is only a
   signed claim: that user id has no membership row. The API trusts the token's tenant
   claim, which is all the conflict tests need; it is not a second real account;
3. starts `@zs/api` on port 8798 as `zs_runtime` with `JWT_ISSUER` set,
   `JWT_MAX_TTL_SECONDS=3600` and `JWT_CLOCK_SKEW_SECONDS=60`, the production defaults;
4. builds the dashboard into `.next-live/` with `ZS_API_URL` and the owner token as
   `ZS_API_TOKEN` (server-only), and serves it on `127.0.0.1:3218` with a random
   `DASHBOARD_ACCESS_CODE` and `DASHBOARD_SESSION_SECRET` for this run (given to `next start`
   only, not the build). It fails if the build output holds any token, the JWT secret, the
   access code or the session secret. Every test's `page` signs in through `/sign-in` first
   (`e2e/live/fixtures.ts`); `anonymousPage` and the bare `request` context never do;
5. snapshots the seeded bookings, contacts and deals into a `zs_e2e` schema. Before each
   test the `seededRows` fixture (`e2e/live/fixtures.ts`, `e2e/live/reset.ts`) deletes
   rows added since and restores every deal's stage and revision, so tests do not depend
   on order. It refuses any database that is not a loopback `zs_e2e_*` one.

No child process inherits the shell's environment (`e2e/live/child-env.ts`): each gets
`PATH`, `HOME`, locale and terminal variables plus what setup sets. Before each start,
setup checks that every database variable (`*DATABASE*`, `*_DB_*`, `POSTGRES*`,
`SUPABASE*`) names the run's `zs_e2e_*` database on loopback, and refuses any libpq `PG*`
variable. So a `RUNTIME_DATABASE_URL` in your shell cannot reach the seed or the API.

The live run also checks that the API refuses the 7-day seed token and tokens with the
wrong role, no issuer, no `iat` or a lifetime one second over the cap. It checks that the
browser makes no request to the API origin and sends no `Authorization` header, that an
anonymous caller, a forged cookie and a caller's own bearer token all get 401 from the proxy
and `/api/session`, that a visitor signs in at `/sign-in` and out again (the cookie is
httpOnly and `SameSite=Strict`, and the proxy refuses the browser after sign-out), that the
proxy refuses a cross-site POST and a forged `X-Forwarded-Host`, that a failed reload after
a deal conflict keeps the move off, that slots for an unknown calendar answer 403 with the
same body the demo adapter sends, and that a booking whose answer was dropped is retried
with the same `Idempotency-Key` and replayed by the API.

The tests make the conflicting writes (a booking for the chosen time, a re-save of a deal)
through the API with the second token. Teardown stops both servers, drops the
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

- `ZS_API_URL` set (with `ZS_API_TOKEN`): live mode. The browser calls the same-origin
  proxy `/api/v1/...` (`src/app/api/[...path]/route.ts`, `src/lib/server/api-proxy.ts`),
  which adds `Authorization: Bearer $ZS_API_TOKEN` on the server and forwards to
  `apps/api`. Both variables are server-only; the build only learns
  `NEXT_PUBLIC_API_MODE=live`. The proxy passes only GET and POST to `/v1/booking/*` and
  `/v1/crm/*`, only `Accept`, `Content-Type` and `Idempotency-Key`, refuses cross-site
  callers and non-JSON POSTs, and answers `no-store`. A request whose `Sec-Fetch-Site` is
  present and not `same-origin` is refused, and so is an `Origin` that is not the request's
  `Host`. `X-Forwarded-Host` counts instead of `Host` only with `DASHBOARD_TRUST_PROXY=1`.
- Pilot gate (`src/lib/server/pilot-gate.ts`, `src/lib/server/sign-in.ts`): live mode
  serves only a browser that signed in at `/sign-in` with the shared access code. Live mode
  needs `DASHBOARD_ACCESS_CODE` (16+ characters) and `DASHBOARD_SESSION_SECRET` (32+
  characters); while either is missing or short, the proxy, `/api/session` and sign-in
  answer 503 and the server log says which. `POST /api/sign-in` compares the code in
  constant time and sets `zs_dashboard_session`: httpOnly, `SameSite=Strict`, `Path=/`,
  `Secure` over https, valid for `DASHBOARD_SESSION_TTL_SECONDS` (default 12 hours). The
  value is an expiry and a nonce, HMAC-signed with a key made from the session secret and
  the access code, so changing either signs everyone out. Without a valid cookie the proxy
  and `/api/session` answer 401 and never attach the token. Sign-in attempts are rate
  limited in memory: 5 per address and 30 in total per 15 minutes, then 429 with
  `Retry-After`, even for the right code. Each attempt is reserved before its body is read,
  so parallel requests cannot outrun the limit, and only a successful sign-in gives its
  attempt back. The address comes from the right-most `X-Forwarded-For` entry only with
  `DASHBOARD_TRUST_PROXY=1` (the trusted proxy appends it). Without that, anyone can forge
  the header, so every caller shares one "direct" key: 5 attempts per 15 minutes for
  everyone together, inside the total of 30. "Sign out" posts `/api/sign-out`, which clears
  the cookie in that browser; a copied cookie stays valid until it expires or until the
  access code or session secret is rotated, and rotating either one is the way to revoke
  every session. The signed-out screen links to `/sign-in?next=<page>`; after sign-in,
  `next` leads only to a page on this site (`src/lib/safe-next.ts`). Demo mode has no gate.
  `build` runs `scripts/bundle-secrets.ts`, which fails if `.next/static` or a prerendered
  page holds a JWT or the value of `ZS_API_TOKEN`, `JWT_SECRET`, `DASHBOARD_ACCESS_CODE` or
  `DASHBOARD_SESSION_SECRET`. See `.env.example`;
  put real values in `.env.local`, which is never committed. Request, response, page and
  error shapes all come from `@zs/contracts` (`http.ts`); calendars and pipeline stages
  come from `GET /v1/booking/resources` and `GET /v1/crm/pipelines`.
  `TODO(auth)`: one server-side owner token behind a shared access code is a pilot setup.
  Real sign-in replaces both with the signed-in person's own token, kept in an httpOnly
  session on this server.
- `ZS_API_URL` unset: an in-memory demo adapter serves made-up data for
  "Halden & Rowe Fine Jewelry", including the booking and deal conflicts. Changes reset
  on reload. In demo mode `window.__zsDemo` exposes `bookAsSomeoneElse` and
  `editDealElsewhere` so tests can trigger the conflicts.
- Build and server must agree on the mode. `NEXT_PUBLIC_API_MODE` is baked in at build
  time from `ZS_API_URL`; `src/proxy.ts` compares it with the server's `ZS_API_URL` on every
  request (`src/lib/server/hosting-mode.ts`). A demo build started with `ZS_API_URL`, or a
  live build started without it, answers every page and `/api` request with a 500 that
  names the mismatch, and logs it once at start (`src/instrumentation.ts`). Rebuild with
  the same `ZS_API_URL` setting the server runs with.
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

Session: `GET /api/session` returns the server's `{ tenantId, userId }` (401 without a
valid pilot cookie: `signed_out` when there is none, `expired` when it is stale or forged). Every query key starts with that `tenantId`, and queries wait for it
(`useKeys()` in `src/lib/queries.ts`, `src/lib/session.tsx`). Any 401 or "Sign out"
clears the query cache and shows the signed-out screen. API reads use `cache: "no-store"`.

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

The API filters in SQL, so no list depends on how many older rows exist. The calendar
asks for one day or week (`from`/`to`, plus the booking that started before and still
runs), and home asks for the next four. The customer list reads 50 at a time, sorted by
name, with "Show more customers"; search goes to the API after a 250 ms pause. A customer
page reads `/v1/crm/contacts/:id` and that customer's deals (`contactId`); the board reads
one pipeline's deals and only their customers' names (`ids`). Reads keep the last result
on screen while the next loads, start a customer page from cached list data, and cancel
when the screen no longer needs them. Deal lists still walk pages, at most 20 (2,000 rows);
past that the board says "List incomplete — showing first N". The board shows "No
pipeline yet", "<name> has no stages yet", or a pipeline picker when there are several.
API bookings carry no
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
