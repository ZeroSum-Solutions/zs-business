# zs-business — rules for agents

Public repo, owner Devin (Zero Sum Solutions). Never commit `.t3-runs/`, hidden tests, client data, secrets or third-party text. Read `docs/licenses.md` before you read or
copy any outside code.

## Stack (decided 2026-10-17)
TypeScript only, Node 24, pnpm workspaces. Postgres on Supabase (org
`Zerosumsolutions-Projects`), Drizzle, Hono for the HTTP API. Tests with vitest.
Layout: `packages/contracts` (zod request, response and error types), `packages/db`
(schema, scoped access), `packages/core` (CRM, booking, actions), `packages/mcp` (thin
adapter over core), `apps/api`, later `apps/dashboard` (Next.js, phone PWA), `supabase/`
(migrations and isolation tests).

## Hard rules
- Multi-tenant from the first table: every tenant table has `tenant_id`, RLS, and a
  two-tenant denial test that runs under the runtime role, not the service role.
- One server-side action path. It binds actor, tenant, target, payload and approval, and
  uses idempotency keys and a state-plus-outbox write in one transaction.
- Nothing says "booked" until a booking row commits under a constraint that rejects
  overlaps. Test it with two concurrent creates where one must lose.
- Inject the clock and config. No ambient `Date.now()` or `process.env` in core logic.
- Local Postgres or a Supabase branch only. No agent writes production rows; schema
  changes ship as migrations.
- Never edit `/Users/zero-suminc./projects/mish` or `/Users/zero-suminc./projects/rise-scheduler`
  from this repo's work. Read them only.
- Conventional commits on feature branches. No AI attribution lines.
