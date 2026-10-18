# @zs/dashboard

The owner dashboard: a phone-first Next.js 16 PWA with six areas (Home, Inbox, Calendar,
Customers, Site, Agents). Settings, Connections and Plan sit under the account menu.

## Run it

```sh
mise exec -- pnpm --filter @zs/dashboard dev     # http://localhost:3200
mise exec -- pnpm --filter @zs/dashboard build
mise exec -- pnpm --filter @zs/dashboard typecheck
mise exec -- pnpm --filter @zs/dashboard test    # vitest, no browser
mise exec -- pnpm --filter @zs/dashboard e2e     # Playwright, phone 390x844 and desktop 1440x900
```

`e2e` builds the app and serves it on port 3217. Screenshots of every area go to
`e2e/__screenshots__/` (gitignored). First run: `pnpm exec playwright install chromium`.

## Data

All data goes through one typed client in `src/lib/api/`. Components use the hooks in
`src/lib/queries.ts` and never import the demo adapter.

- `NEXT_PUBLIC_API_URL` set: the HTTP client talks to the API with a bearer token.
  See `.env.example`. Put real values in `.env.local`, which is never committed.
- `NEXT_PUBLIC_API_URL` unset: an in-memory demo adapter serves made-up data for
  "Halden & Rowe Fine Jewelry", including the booking and deal conflicts. Changes reset
  on reload. In demo mode `window.__zsDemo` exposes `bookAsSomeoneElse` and
  `editDealElsewhere` so tests can trigger the conflicts.

Open items are marked in the code:

- `TODO(contracts)`: list pages, booking resources, pipelines, contact search and a
  single-contact route are not in `@zs/contracts` yet. The shapes live in
  `src/lib/api/types.ts`.
- `TODO(api)`: results, usage, inbox, site, agents, connections and plan have no API yet.
  Live mode still reads them from the demo workspace.

## Notes

- Build and dev use webpack (`--webpack`). Turbopack does not map the contracts'
  NodeNext `.js` import specifiers to `.ts` sources.
- `next build` skips its own type check; `typecheck` runs `tsc --noEmit` (TypeScript 7).
- The service worker (`public/sw.js`) caches the app shell and static assets only. It
  never caches `/v1/` or `/api/` requests, or any request with an `Authorization` header.
  It registers in production builds only.
- Theme tokens come from Mish neutral-product and live in `src/styles/theme.css`.
