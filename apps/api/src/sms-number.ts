// The `pnpm sms:number` arguments (twilio.md T-7), parsed apart from the script so they can be tested.
// Original code.
import { parseArgs } from "node:util";
import { uuidSchema } from "@zs/contracts";

export const SMS_NUMBER_USAGE =
  "Usage: pnpm sms:number --tenant <uuid> (--number <E.164> [--help-reply <text>] | --remove)";

export interface SmsNumberArgs {
  readonly tenantId: string;
  /** Null removes the tenant's number. */
  readonly phoneNumber: string | null;
  readonly helpReply?: string;
}

const OPTIONS = {
  tenant: { type: "string" },
  number: { type: "string" },
  "help-reply": { type: "string" },
  remove: { type: "boolean", default: false },
} as const;

/** parseArgs throws on an unknown option or a positional; either is a usage error. */
function parseOptions(args: string[]) {
  try {
    return parseArgs({ args, options: OPTIONS });
  } catch {
    return null;
  }
}

/**
 * The script's arguments, or null when they do not form one assignment or removal. A leading
 * `--` (from `pnpm sms:number -- ...`, which pnpm passes through) is dropped, since parseArgs
 * would read everything after it as positionals.
 */
export function parseSmsNumberArgs(argv: readonly string[]): SmsNumberArgs | null {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const parsed = parseOptions(args);
  if (!parsed) return null;
  const { values } = parsed;
  const tenantId = uuidSchema.safeParse(values.tenant);
  if (!tenantId.success || values.remove === (values.number !== undefined)) return null;
  if (values.remove) return values["help-reply"] === undefined ? { tenantId: tenantId.data, phoneNumber: null } : null;
  return {
    tenantId: tenantId.data,
    phoneNumber: values.number!,
    ...(values["help-reply"] === undefined ? {} : { helpReply: values["help-reply"] }),
  };
}
