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

`e2e:live` needs the local test cluster at `127.0.0.1:55432` (or `ZS_TEST_DATABASE_URL`,
loopback only). Its global setup (`e2e/live/global-setup.ts`):

1. creates a throwaway `zs_e2e_*` database;
2. runs `@zs/api seed:demo` with a random `JWT_SECRET` (migrations, the `zs_runtime` login,
   the Halden & Rowe seed and a 7-day dev JWT). It takes the owner from that JWT and signs
   one-hour tokens (`role` authenticated, a run-specific `iss`) for the owner and for
   another person in the same business;
3. starts `@zs/api` on port 8798 as `zs_runtime` with `JWT_ISSUER` set and
   `JWT_MAX_TTL_SECONDS=3600`, the production default, then builds the dashboard into
   `.next-live/` with `NEXT_PUBLIC_API_URL` and the owner token and serves it on port 3218.

The live run also checks that the API refuses the 7-day seed token and tokens with the
wrong role, no issuer or a lifetime one second over the cap. It checks that slots for an
unknown calendar answer 403 with the same body the demo adapter sends.

The tests make the conflicting writes (a booking for the chosen time, a re-save of a deal)
through the API with the second token. Teardown stops both servers and drops the
database, also when setup fails. Server logs go to `test-results/live/`. Screenshots are
prefixed `live-`. Phone and desktop share one database, so they run one after the other
on separate seeded deals. It is not in CI: the CI e2e job has no Postgres service, and a
second production build plus the live run would push that job past about four minutes.

## Data

All data goes through one typed client in `src/lib/api/`. Components use the hooks in
`src/lib/queries.ts` and never import the demo adapter.

- `NEXT_PUBLIC_API_URL` set: the HTTP client talks to `apps/api` with a bearer token.
  See `.env.example`. Put real values in `.env.local`, which is never committed, and add
  the dashboard origin to the API's `ALLOWED_ORIGINS`. Request, response, page and error
  shapes all come from `@zs/contracts` (`http.ts`); calendars and pipeline stages come
  from `GET /v1/booking/resources` and `GET /v1/crm/pipelines`.
- `NEXT_PUBLIC_API_URL` unset: an in-memory demo adapter serves made-up data for
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

The list routes take paging only (at most 100 rows a page). The client walks `nextOffset`
and runs contact search, the deal contact filter and the booking date range itself.
There is no single-contact route, so a contact page reads the list. API bookings carry no
customer or title, so live mode shows them as "Appointment".

`TODO(api)`: results, usage, inbox, site, agents, connections and plan have no API yet.
Live mode still reads them from the demo workspace.

## Notes

- Build and dev use webpack (`--webpack`). Turbopack does not map the contracts'
  NodeNext `.js` import specifiers to `.ts` sources.
- `next build` skips its own type check; `typecheck` runs `tsc --noEmit` (TypeScript 7).
- The service worker (`public/sw.js`) caches the app shell and static assets only. It
  never caches `/v1/` or `/api/` requests, or any request with an `Authorization` header.
  It registers in production builds only.
- Theme tokens come from Mish neutral-product and live in `src/styles/theme.css`.
