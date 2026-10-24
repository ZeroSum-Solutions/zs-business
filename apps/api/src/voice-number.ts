// The `pnpm voice:number` arguments (twilio.md T-10), parsed apart from the script so they can be
// tested. Original code.
import { parseArgs } from "node:util";
import { uuidSchema } from "@zs/contracts";

export const VOICE_NUMBER_USAGE =
  "Usage: pnpm voice:number --tenant <uuid> (--forward-to <E.164> [--ring-seconds <5..45>] [--booking-url <https URL>] "
  + "[--disclosure-version <v> [--disclosure <text>]] [--enable | --disable] | --remove)";

export interface VoiceNumberArgs {
  readonly tenantId: string;
  /** Null removes the tenant's voice number. */
  readonly forwardTo: string | null;
  readonly ringSeconds?: number;
  readonly textbackEnabled?: boolean;
  readonly bookingUrl?: string;
  /** With text: record this wording as the version. Without: use a version already recorded. */
  readonly disclosureVersion?: string;
  readonly disclosureText?: string;
}

const OPTIONS = {
  tenant: { type: "string" },
  "forward-to": { type: "string" },
  "ring-seconds": { type: "string" },
  "booking-url": { type: "string" },
  "disclosure-version": { type: "string" },
  disclosure: { type: "string" },
  enable: { type: "boolean", default: false },
  disable: { type: "boolean", default: false },
  remove: { type: "boolean", default: false },
} as const;

function parseOptions(args: string[]) {
  try {
    return parseArgs({ args, options: OPTIONS });
  } catch {
    return null;
  }
}

/** The script's arguments, or null when they do not form one change or removal. A leading `--` is dropped. */
export function parseVoiceNumberArgs(argv: readonly string[]): VoiceNumberArgs | null {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const parsed = parseOptions(args);
  if (!parsed) return null;
  const { values } = parsed;
  const tenantId = uuidSchema.safeParse(values.tenant);
  if (!tenantId.success) return null;
  if (values.remove) {
    const others = Object.entries(values).some(([name, value]) => name !== "tenant" && name !== "remove" && value !== undefined && value !== false);
    return others ? null : { tenantId: tenantId.data, forwardTo: null };
  }
  const forwardTo = values["forward-to"];
  if (forwardTo === undefined || (values.enable && values.disable)) return null;
  let ringSeconds: number | undefined;
  if (values["ring-seconds"] !== undefined) {
    if (!/^[0-9]{1,3}$/.test(values["ring-seconds"])) return null;
    ringSeconds = Number(values["ring-seconds"]);
  }
  // New wording needs a version name to live under.
  if (values.disclosure !== undefined && values["disclosure-version"] === undefined) return null;
  return {
    tenantId: tenantId.data,
    forwardTo,
    ...(ringSeconds === undefined ? {} : { ringSeconds }),
    ...(values.enable ? { textbackEnabled: true } : values.disable ? { textbackEnabled: false } : {}),
    ...(values["booking-url"] === undefined ? {} : { bookingUrl: values["booking-url"] }),
    ...(values["disclosure-version"] === undefined ? {} : { disclosureVersion: values["disclosure-version"] }),
    ...(values.disclosure === undefined ? {} : { disclosureText: values.disclosure }),
  };
}
