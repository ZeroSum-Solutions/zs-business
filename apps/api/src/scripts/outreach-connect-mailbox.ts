// Entry point, owner-run on the Mac: connect (or disconnect) one outreach mailbox (outreach-sequencer.md OS-2, OS-3).
//   pnpm --filter @zs/api outreach:connect-mailbox --tenant <uuid> --mailbox <address> --name "<From name>" [--daily-limit 20] [--dry-run]
//   pnpm --filter @zs/api outreach:connect-mailbox --tenant <uuid> --mailbox <address> --disconnect
// Settings (OUTREACH_TENANTS, OUTREACH_GOOGLE_CLIENT_ID and _SECRET, OUTREACH_TOKEN_PUBLIC_KEY, OUTREACH_RUNTIME_DATABASE_URL
// (an unprivileged login: the write goes through the shared action path under RLS), DATABASE_CA_CERT off loopback, and
// optionally OUTREACH_MAILBOX_DOMAINS) come from the process settings. It never sends mail and prints no token.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { createGmailClient, createGoogleClient, createOutreachOperator } from "@zs/core";
import { assertRuntimeLogin, createRuntimePool, createScopedDatabase } from "@zs/db";
import { redactSecrets } from "../hosted.js";
import {
  CONNECT_MAILBOX_USAGE,
  ConnectFailed,
  connectMailbox,
  disconnectMailbox,
  OUTREACH_GMAIL_SCOPES,
  parseConnectEnv,
  parseConnectMailboxArgs,
} from "../outreach/connect-mailbox.js";
import { checkOutreachDatabaseUrl } from "../outreach/config.js";

const args = parseConnectMailboxArgs(process.argv.slice(2));
if (!args) {
  console.error(CONNECT_MAILBOX_USAGE);
  process.exit(2);
}

const settings = process.env;
const required = args.disconnect ? ["OUTREACH_RUNTIME_DATABASE_URL"] : ["OUTREACH_GOOGLE_CLIENT_ID", "OUTREACH_GOOGLE_CLIENT_SECRET", "OUTREACH_RUNTIME_DATABASE_URL"];
const missing = required.filter((name) => !settings[name]);
if (missing.length > 0) {
  console.error(`Set ${missing.join(", ")}`);
  process.exit(2);
}
const databaseUrl = settings.OUTREACH_RUNTIME_DATABASE_URL ?? "";
const caCert = settings.DATABASE_CA_CERT;
const pool = createRuntimePool({
  connectionString: databaseUrl,
  max: 1,
  applicationName: "zs-outreach-connect",
  onError: (summary) => console.error("Database pool error", summary),
  ...(caCert === undefined ? {} : { ssl: { ca: caCert, rejectUnauthorized: true } }),
});

try {
  checkOutreachDatabaseUrl("OUTREACH_RUNTIME_DATABASE_URL", databaseUrl, caCert);
  const connectEnv = parseConnectEnv(settings);
  await assertRuntimeLogin(pool);
  const db = createScopedDatabase(pool, { cancel: "none", onResetFailure: (error) => console.error("Session reset failed; connection discarded", error) });
  const operator = createOutreachOperator({
    db, clock: { now: () => new Date() }, generateId: randomUUID, outreach: { tenants: connectEnv.tenants },
  }, args.tenantId);
  const deps = {
    env: connectEnv,
    operator,
    gmail: createGmailClient({ config: settings.OUTREACH_GMAIL_BASE_URL ? { baseUrl: settings.OUTREACH_GMAIL_BASE_URL } : {} }),
    makeGoogle: (redirectUrl: string) => createGoogleClient({
      config: {
        clientId: settings.OUTREACH_GOOGLE_CLIENT_ID ?? "",
        clientSecret: settings.OUTREACH_GOOGLE_CLIENT_SECRET ?? "",
        redirectUrl,
        scopes: [...OUTREACH_GMAIL_SCOPES],
        ...(settings.GOOGLE_TOKEN_BASE_URL ? { tokenBaseUrl: settings.GOOGLE_TOKEN_BASE_URL } : {}),
      },
    }),
    checkTenant: async (tenantId: string) => {
      const found = await db.tenant(tenantId, async (tx) => (await tx.query("SELECT 1 FROM business_profiles WHERE tenant_id=$1", [tenantId])).rowCount);
      if (found !== 1) throw new Error("The tenant has no business profile in this database");
    },
    print: (line: string) => console.log(line),
  };
  if (args.disconnect) await disconnectMailbox(args, deps);
  else await connectMailbox(args, deps);
} catch (error) {
  console.error(error instanceof ConnectFailed ? `${error.code}: ${error.message}` : redactSecrets(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  await pool.end();
}
