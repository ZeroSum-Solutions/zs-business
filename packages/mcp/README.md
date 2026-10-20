# @zs/mcp

MCP server (stdio) over `@zs/core`. Tools: `create_booking`, `upsert_contact`,
`create_deal`, `move_deal_stage`, `set_deal_details`, `draft_reply`, `approve_reply`,
`discard_reply` (writes, each needs an `idempotencyKey`) and `list_contacts`, `get_contact`,
`list_deals`, `list_pipelines`, `list_bookings`, `list_resources`, `find_slots`,
`list_threads`, `get_thread`, `home_results` (reads), mirroring the HTTP routes. Inputs use the `@zs/contracts` request schemas. Every result puts one
JSON object in both `structuredContent` and `content[0].text`: the same body as the HTTP
route (list tools return `{ items }`), or on failure `isError: true` with the shared
`apiErrorBodySchema` body.

The server acts with one member's Supabase access token and authorizes exactly like the HTTP
API (`authenticate` in `@zs/core`). On **every** tool call it:

1. verifies the token with the same `JWT_*` settings as the API, against the injected clock,
   so the token stops working at its `exp` (401 `Unauthorized`);
2. checks the token's Supabase session is still live, so signing out stops it at once (401);
3. checks the token's user is a member of the tenant the token claims (403 `Forbidden`);
4. runs the tool through the edge session, which re-checks the membership and the role the
   read or action needs. Staff may do the calendar, customer and inbox-draft tools;
   `approve_reply` and `home_results` are owners only (403 for staff).

The tenant and actor come only from the verified token, never from tool input. A failed check
answers `isError: true` with the shared error body, like any other failure.

```sh
DATABASE_URL=postgres://zs_runtime@127.0.0.1:55432/zs_dev \
JWT_VERIFIER=hs256 JWT_SECRET=<the API's secret> SESSION_CHECK=local-stub \
ZS_ACCESS_TOKEN=<a member's access token> \
  mise exec -- pnpm --filter @zs/mcp start
```

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | The runtime LOGIN role (`zs_runtime`). |
| `ZS_ACCESS_TOKEN` | The member's Supabase access token (locally, the dev JWT `seed:demo` prints). |
| `JWT_VERIFIER`, `JWT_SECRET`, `JWT_JWKS_URL`, `JWT_ISSUER`, `JWT_MAX_TTL_SECONDS`, `JWT_CLOCK_SKEW_SECONDS` | Exactly as for `@zs/api` (see its README); parsed by the same `jwtEnvSchema` from `@zs/core`. |
| `SESSION_CHECK`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SESSION_CACHE_SECONDS` | Exactly as for `@zs/api`: `supabase` on any hosted project, `local-stub` only with a loopback `DATABASE_URL`. |

A Supabase access token lives one hour by default, so a long-running server needs a fresh
token: restart it with a new `ZS_ACCESS_TOKEN`, or embed `createMcpServer` with a function
token source that returns the current token (it is read on every call). The local 7-day dev
token needs `JWT_MAX_TTL_SECONDS=604800`, as for the API.

`DATABASE_URL` must log in as the unprivileged runtime role; the server refuses to start
when the login is a superuser or has BYPASSRLS. `createMcpServer(deps)` takes the scoped
database, clock, ID generator, token verifier and access token (a string, or a function
returning the current one), so tests connect it to an in-memory client with real signed
tokens.
