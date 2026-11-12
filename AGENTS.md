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
- Tests and smoke runs use local Postgres or a Supabase branch, and clean up after themselves.
  Schema changes ship as migrations.
- Agents on Devin's Mac may write production rows when the work needs it (Devin, 2026-11-07).
  Prefer a repo script (for example `db:hosted-tenant-create`, `db:hosted-provision-owner`)
  over hand-written SQL. Dry-run it, take a `db:hosted-backup` first, apply, verify the result,
  and keep the receipt in `~/Backups/zs-business/receipts/`. Cloud sessions still never touch
  hosted systems (below).
- Never edit `/Users/zero-suminc./projects/mish` or `/Users/zero-suminc./projects/rise-scheduler`
  from this repo's work. Read them only.
- Conventional commits on feature branches. No AI attribution lines in commits, PR bodies or
  PR comments (no "Generated with", no Co-Authored-By, no session links).
- Push only to your own feature branch, never to `main`; `main` takes changes only through a
  PR (branch protection enforces it, for admins too). Create worktrees with
  `git worktree add --no-track -b <branch> <path> origin/main` and push with
  `git push origin HEAD:refs/heads/<branch>`: a branch that tracks `origin/main` pushes to
  `main` under `push.default=upstream`.

## Work tracking (Plane, project ZSB)
- Work for this repo is tracked in the Plane project "ZS Business" (key `ZSB`). Plans and
  research live there as work items and Pages; code lives here.
- Put the work item key (`ZSB-<n>`) in the branch name or the PR title. The `plane-link`
  workflow then adds the PR to the work item, moves it to In Progress when the PR opens and to
  Done when it merges. It is best effort and never fails a PR.
- The tracker address and API key are secrets of the `plane` environment (`PLANE_URL`,
  `PLANE_API_KEY`), which only `main` may use. Never write them in this public repo, and keep
  the workflow on `pull_request_target` with no checkout.

## Cloud sessions (Claude Code on the web / desktop cloud)
- `scripts/cloud-setup.sh` runs at session start (`.claude/settings.json`). It installs Node 24,
  pnpm and Postgres on `127.0.0.1:55432`, so `pnpm -r test`, `test:booking` and `test:crm` work
  as in CI. It does nothing on a laptop.
- Cloud sessions hold no secrets and never touch hosted Supabase, Vercel, Resend or DNS.
  Deploys, hosted checks and the hidden test gate run on Devin's Mac.
- Work on a `cloud/<checkpoint>` branch and open a draft PR. Keep a `Status:` line at the
  top of the PR body. When the work is done and tests pass, comment `READY FOR REVIEW`.
  The Mac hub then runs a GPT-6.1 Sol review and posts findings as a PR comment that starts
  `REVIEW`. Fix verified findings, push, and comment `READY FOR REVIEW` again.
- Never merge. The hub lands PRs after review and green CI.
- Fan out freely: subagents are capped at 25 at once per session; for wider work, split it across project threads (each gets its own machine) (`.claude/settings.json`). A session has
  4 CPUs and one Postgres, so run heavy test suites one at a time.
