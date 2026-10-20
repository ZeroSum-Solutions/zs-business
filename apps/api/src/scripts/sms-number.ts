// Entry point: an operator assigns or removes a tenant's SMS sending number (twilio.md T-7). It
// connects with DELIVERY_DATABASE_URL (a login that may SET ROLE service_role) and
// DATABASE_CA_CERT, like the delivery worker. Run from apps/api:
//   pnpm sms:number --tenant <uuid> --number +15555550100 [--help-reply "<text>"]
//   pnpm sms:number --tenant <uuid> --remove
// The number must already be bought in Twilio, registered for A2P 10DLC (or a verified toll-free
// number), with its messaging webhook at <TWILIO_WEBHOOK_BASE_URL>/webhooks/twilio/inbound/<uuid>.
import process from "node:process";
import { assignSmsNumber } from "@zs/core";
import { asService, createRuntimePool } from "@zs/db";
import { parseSmsNumberArgs, SMS_NUMBER_USAGE } from "../sms-number.js";

const args = parseSmsNumberArgs(process.argv.slice(2));
if (!args) {
  console.error(SMS_NUMBER_USAGE);
  process.exit(2);
}
const url = process.env.DELIVERY_DATABASE_URL;
if (!url) {
  console.error("Set DELIVERY_DATABASE_URL (and DATABASE_CA_CERT for a hosted database)");
  process.exit(2);
}
const ca = process.env.DATABASE_CA_CERT;
const pool = createRuntimePool({
  connectionString: url,
  max: 1,
  applicationName: "zs-sms-number",
  onError: (summary) => console.error("Database pool error", summary),
  ...(ca === undefined ? {} : { ssl: { ca, rejectUnauthorized: true } }),
});
try {
  const result = await asService(pool, (tx) => assignSmsNumber(tx, {
    tenantId: args.tenantId,
    phoneNumber: args.phoneNumber,
    ...(args.helpReply === undefined ? {} : { helpReply: args.helpReply }),
    now: new Date(),
  }));
  console.log(result.phoneNumber === null ? `Removed the SMS number of ${args.tenantId}` : `Tenant ${args.tenantId} sends SMS from ${result.phoneNumber}`);
} finally {
  await pool.end();
}
