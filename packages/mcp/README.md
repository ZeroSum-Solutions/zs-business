# @zs/mcp

MCP server (stdio) over `@zs/core`. Tools: `create_booking`, `upsert_contact`,
`create_deal`, `move_deal_stage` (writes, each needs an `idempotencyKey`) and
`list_contacts`, `list_deals`, `list_pipelines`, `list_bookings`, `list_resources`,
`find_slots` (reads). Inputs use the `@zs/contracts` request schemas. Every result puts one
JSON object in both `structuredContent` and `content[0].text`: the same body as the HTTP
route (list tools return `{ items }`), or on failure `isError: true` with the shared
`apiErrorBodySchema` body.

The tenant and actor are fixed per process by injected config, never by tool input:

```sh
DATABASE_URL=postgres://zs_runtime@127.0.0.1:55432/zs_dev \
ZS_TENANT_ID=<tenant uuid> ZS_ACTOR_ID=<actor uuid> \
  mise exec -- pnpm --filter @zs/mcp start
```

`ZS_ACTOR_ID` must be a member of `ZS_TENANT_ID` (`tenant_members`); otherwise every tool
answers `Forbidden`. Its tools are calendar and customer work, which staff may do too. It is an
operator credential on the server, so it checks membership and role but not a Supabase
session.

`DATABASE_URL` must log in as the unprivileged runtime role; the server refuses to start
when the login is a superuser or has BYPASSRLS. `createMcpServer(deps)` takes
the scoped database, clock, ID generator and principal, so tests connect it to an
in-memory client.
