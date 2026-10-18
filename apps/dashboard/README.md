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

`e2e` builds the app and serves it on port 3217. Screenshots of every area go to
`e2e/__screenshots__/` (gitignored). First run: `pnpm exec playwright install chromium`.
`e2e/retries.spec.ts` covers retries after a lost response (the demo adapter's
`loseNextResponse`, `setOffline` and `writeLog`). `e2e/layout.spec.ts` covers focus
return after Escape on every sheet and controls clear of the phone tab bar.
`e2e/offline.spec.ts` runs with service workers allowed: install, go offline, reload,
still styled and working; `/api` responses are never stored.

`e2e:live` needs the local test cluster at `127.0.0.1:55432` (or `ZS_TEST_DATABASE_URL`,
loopback only). Its global setup (`e2e/live/global-setup.ts`):

1. creates a throwaway `zs_e2e_*` database;
2. runs `@zs/api seed:demo` with a random `JWT_SECRET` (migrations, the `zs_runtime` login,
   the Halden & Rowe seed and a 7-day dev JWT). It takes the owner from that JWT and signs
   one-hour tokens (`role` authenticated, a run-specific `iss`, always an `iat`) for the
   owner and for another person in the same business;
3. starts `@zs/api` on port 8798 as `zs_runtime` with `JWT_ISSUER` set,
   `JWT_MAX_TTL_SECONDS=3600` and `JWT_CLOCK_SKEW_SECONDS=60`, the production defaults;
4. builds the dashboard into `.next-live/` with `ZS_API_URL` and the owner token as
   `ZS_API_TOKEN` (server-only), fails if the build output holds any token or the JWT
   secret, and serves it on port 3218.

No child process inherits the shell's environment (`e2e/live/child-env.ts`): each gets
`PATH`, `HOME`, locale and terminal variables plus what setup sets. Before each start,
setup checks that every database variable (`*DATABASE*`, `*_DB_*`, `POSTGRES*`,
`SUPABASE*`) names the run's `zs_e2e_*` database on loopback, and refuses any libpq `PG*`
variable. So a `RUNTIME_DATABASE_URL` in your shell cannot reach the seed or the API.

The live run also checks that the API refuses the 7-day seed token and tokens with the
wrong role, no issuer, no `iat` or a lifetime one second over the cap. It checks that the
browser makes no request to the API origin and sends no `Authorization` header, that the
proxy refuses a cross-site POST, that slots for an unknown calendar answer 403 with the
same body the demo adapter sends, and that a booking whose answer was dropped is retried
with the same `Idempotency-Key` and replayed by the API.

The tests make the conflicting writes (a booking for the chosen time, a re-save of a deal)
through the API with the second token. Teardown stops both servers and drops the
database, also when setup fails. Server logs go to `test-results/live/`. Screenshots are
prefixed `live-`. Phone and desktop share one database, so they run one after the other
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
  callers (`Origin`, `Sec-Fetch-Site`) and non-JSON POSTs, and answers `no-store`.
  `build` runs `scripts/bundle-secrets.ts`, which fails if `.next/static` or a prerendered
  page holds a JWT or the value of `ZS_API_TOKEN` or `JWT_SECRET`. See `.env.example`;
  put real values in `.env.local`, which is never committed. Request, response, page and
  error shapes all come from `@zs/contracts` (`http.ts`); calendars and pipeline stages
  come from `GET /v1/booking/resources` and `GET /v1/crm/pipelines`.
  `TODO(auth)`: one server-side owner token is a pilot setup. Real sign-in replaces it
  with the signed-in person's token, kept in an httpOnly session on this server.
- `ZS_API_URL` unset: an in-memory demo adapter serves made-up data for
  "Halden & Rowe Fine Jewelry", including the booking and deal conflicts. Changes reset
  on reload. In demo mode `window.__zsDemo` exposes `bookAsSomeoneElse` and
  `editDealElsewhere` so tests can trigger the conflicts.
- Errors: the demo adapter parses requests with the same `@zs/contracts` schemas and throws
  the error the HTTP client would build from the API's body: the fixed message per code,
  allowlisted conflict reasons, and 403 (never 404) for an unknown calendar, deal or stage.
  `test/error-parity.test.ts` compares both against `mapError` from `@zs/core`. Shown
  copy comes from the status, `reason` and field, never from the server message.

Errors: every non-2xx body is read with `apiErrorBodySchema`. The client maps the status
to an `ApiError` kind and shows plain copy, not the server message. A 409 with
`details.reason` `overlap` or `slot_unavailable` is a taken slot (`isSlotTaken`) and
`stale_revision` is a changed deal (`isStaleRevision`). A 400 points at the first field in
`details.issues`. The demo adapter throws the same errors.

Writes: every write path (booking, contact, deal move) gets its `Idempotency-Key` from
`useIntentKey()` (`src/lib/intent-key.ts`). The key belongs to the full request body (for
a deal move: deal, expected revision, target stage), so a retry of the same write reuses
it and the API replays the first attempt, while any other body (another calendar at the
same instant) gets a new key. The key is dropped once the attempt gets a definitive
answer (2xx or 4xx); after a network error, a 5xx or an unreadable body it is kept. There
is no deal-create screen yet; when one is added it uses the same hook.

The list routes take paging only (at most 100 rows a page). The client walks `nextOffset`
and runs contact search, the deal contact filter and the booking date range itself.
There is no single-contact route, so a contact page reads the list. API bookings carry no
customer or title, so live mode shows them as "Appointment".

`TODO(api)`: results, usage, inbox, site, agents, connections and plan have no API yet.
Live mode still reads them from the demo workspace.

## Notes

- Build and dev use webpack (`--webpack`). Turbopack does not map the contracts'
  NodeNext `.js` import specifiers to `.ts` sources.
- `next build` type-checks (`ignoreBuildErrors: false`); `typecheck` runs `tsc --noEmit` (TypeScript 7) on its own.
- Every response, pages and `/api` alike, carries `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` (`next.config.ts`). There is no `script-src`: Next hydrates with inline scripts.
- The service worker (`public/sw.js`) caches the app shell and static assets only. On
  install it caches each shell page, then every `/_next/static` script, style and font
  those pages and their styles reference, so the app opens offline styled and working.
  Assets are cache-first; pages are network-first with the cached copy as fallback. It
  is registered as `/sw.js?v=<build id>`, so each build gets its own cache and the old
  one is deleted. It never caches `/v1/` or `/api/` requests, non-GETs, requests with an
  `Authorization` header or responses marked `no-store` or `private`. It registers in
  production builds only.
- Sheets return focus to the control that opened them (`DialogContent` in
  `src/components/ui/dialog.tsx`). On phones `html` has scroll padding for the top bar
  and tab bar, so scrolled-to and focused controls are never under them.
- Theme tokens come from Mish neutral-product and live in `src/styles/theme.css`.
