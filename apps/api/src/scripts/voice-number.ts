// Entry point: an operator sets or removes a tenant's voice number settings (twilio.md T-10). It
// connects with DELIVERY_DATABASE_URL (a login that may SET ROLE service_role) and
// DATABASE_CA_CERT, like the delivery worker. Run from apps/api:
//   pnpm voice:number --tenant <uuid> --forward-to +15555550100 [--ring-seconds 20]
//     [--booking-url https://example.com/book] [--disclosure-version v1 --disclosure "<words>"] [--enable]
//   pnpm voice:number --tenant <uuid> --remove
// The tenant needs its SMS number first (pnpm sms:number); the voice number is the same number.
// In Twilio, point the number's voice webhook at <TWILIO_WEBHOOK_BASE_URL>/webhooks/twilio/voice/<uuid>
// and set its fallback URL to a static TwiML apology. With --disclosure-version and no --disclosure
// the wording is the default for the business name.
import process from "node:process";
import { assignVoiceNumber, defaultDisclosure } from "@zs/core";
import { asService, createRuntimePool } from "@zs/db";
import { parseVoiceNumberArgs, VOICE_NUMBER_USAGE } from "../voice-number.js";

const args = parseVoiceNumberArgs(process.argv.slice(2));
if (!args) {
  console.error(VOICE_NUMBER_USAGE);
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
  applicationName: "zs-voice-number",
  onError: (summary) => console.error("Database pool error", summary),
  ...(ca === undefined ? {} : { ssl: { ca, rejectUnauthorized: true } }),
});
try {
  const result = await asService(pool, async (tx) => {
    let disclosure: { version: string; text: string } | undefined;
    const version = args.disclosureVersion;
    if (version !== undefined && args.disclosureText !== undefined) disclosure = { version, text: args.disclosureText };
    else if (version !== undefined) {
      // A version named without words: use the recorded one, or record the default wording.
      const recorded = await tx.query("SELECT 1 FROM voice_textback_disclosures WHERE tenant_id=$1 AND version=$2", [args.tenantId, version]);
      if (!recorded.rowCount) {
        const name = (await tx.query<{ name: string }>("SELECT name FROM tenants WHERE tenant_id=$1", [args.tenantId])).rows[0]?.name;
        if (name === undefined) throw new Error("Unknown tenant");
        disclosure = { version, text: defaultDisclosure(name) };
      }
    }
    return assignVoiceNumber(tx, {
      tenantId: args.tenantId,
      forwardTo: args.forwardTo,
      ...(args.ringSeconds === undefined ? {} : { ringSeconds: args.ringSeconds }),
      ...(args.textbackEnabled === undefined ? {} : { textbackEnabled: args.textbackEnabled }),
      ...(args.bookingUrl === undefined ? {} : { bookingUrl: args.bookingUrl }),
      ...(disclosure ? { disclosure } : args.disclosureVersion === undefined ? {} : { disclosureVersion: args.disclosureVersion }),
      now: new Date(),
    });
  });
  console.log(result === null ? `Removed the voice number of ${args.tenantId}`
    : `Tenant ${args.tenantId}: ${result.phoneNumber} rings ${result.forwardTo} for ${result.ringSeconds}s; text-back ${result.textbackEnabled ? "on" : "off"}`);
} finally {
  await pool.end();
}
