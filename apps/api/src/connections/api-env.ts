// The API function's connections variables (docs/requirements/connections.md C-3, C-4, C-5), all or none.
// Parsed from an object an entry point passes in; this module never reads process.env. The API holds the
// worker's address, the signing secret and environment (a different value per environment; the API signs
// CONNECTIONS_ENV into every internal request, so a request made for one environment never verifies in the
// other even if a secret were shared), the state
// secrets that sign the attempt and grant tokens, and the dashboard page the callback returns to. It never
// holds the Composio key, an auth config ID or the service database login. Errors name variables, never values.
import { secureUrlProblem } from "@zs/core";
import { z } from "zod";

const REQUIRED = "is required when any of its CONNECTIONS_ variables is set";
/** A URL that is https, or plain http on loopback (local tests against a fake worker). */
const secureUrlVariable = (name: string) => z.string({ error: REQUIRED }).superRefine((value, ctx) => {
  const problem = secureUrlProblem(name, value);
  if (problem) ctx.addIssue({ code: "custom", message: problem.replace(`${name} `, "") });
});
const signingSecretVariable = () => z.string({ error: REQUIRED }).min(32, "must be at least 32 characters");
const formatIssues = (error: z.ZodError) =>
  `Invalid environment: ${error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`;

const apiSchema = z.object({
  // The workers project's origin: https://<workers host>, no path.
  CONNECTIONS_WORKER_URL: secureUrlVariable("CONNECTIONS_WORKER_URL").refine((value) => {
    try {
      const url = new URL(value);
      return url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "";
    } catch {
      return false;
    }
  }, "must be an origin with no path, query, fragment or credentials"),
  CONNECTIONS_ENV: z.enum(["production", "preview"], { error: "must be production or preview" }),
  CONNECTIONS_INTERNAL_SECRET: signingSecretVariable(),
  // C-6: accepted so the API and worker can carry one rotation set; the API always signs with the current one.
  CONNECTIONS_INTERNAL_PREVIOUS_SECRET: signingSecretVariable().optional(),
  // Signs the attempt and grant tokens (C-4, C-5); domain-separated from the internal secret.
  CONNECTIONS_STATE_SECRET: signingSecretVariable(),
  CONNECTIONS_STATE_PREVIOUS_SECRET: signingSecretVariable().optional(),
  // The dashboard page the callback sends the owner back to (https://<dashboard host>/account/connections).
  CONNECTIONS_RETURN_URL: secureUrlVariable("CONNECTIONS_RETURN_URL"),
  // C-30: verifies the dashboard proxy's signed note of the browser's address for the embedded app's limits. The
  // dashboard holds the same value. Unset: those limits count the address the host gives (on Vercel, the dashboard's).
  CONNECTIONS_EMBEDDED_ADDRESS_SECRET: signingSecretVariable().optional(),
});
const SECRET_VARIABLES = [
  "CONNECTIONS_INTERNAL_SECRET", "CONNECTIONS_INTERNAL_PREVIOUS_SECRET", "CONNECTIONS_STATE_SECRET", "CONNECTIONS_STATE_PREVIOUS_SECRET",
  "CONNECTIONS_EMBEDDED_ADDRESS_SECRET",
] as const;
/** What sets the API's connections side. The worker project's own variables (C-3) are not among them. */
export const CONNECTIONS_API_VARIABLES: readonly string[] = Object.freeze(Object.keys(apiSchema.shape));

export interface ConnectionsApiEnv {
  readonly workerUrl: string;
  readonly env: "production" | "preview";
  readonly internalSecret: string;
  readonly stateSecrets: { readonly current: string; readonly previous?: string };
  readonly returnUrl: string;
  /** C-30: null when CONNECTIONS_EMBEDDED_ADDRESS_SECRET is unset. */
  readonly embeddedAddressSecret: string | null;
}

/** C-3: null when no API connections variable is set (every connections route is 404). Any one set requires the rest. */
export function parseConnectionsApiEnv(env: Readonly<Record<string, string | undefined>>): ConnectionsApiEnv | null {
  const given = CONNECTIONS_API_VARIABLES.filter((name) => env[name] !== undefined && env[name] !== "");
  if (given.length === 0) return null;
  const parsed = apiSchema.safeParse(Object.fromEntries(given.map((name) => [name, env[name]])));
  if (!parsed.success) throw new Error(formatIssues(parsed.error));
  const data = parsed.data;
  // C-6: no secret may sign in two roles or two rotation slots, previous ones included.
  const secrets = SECRET_VARIABLES.filter((name) => data[name] !== undefined);
  for (const [i, first] of secrets.entries())
    for (const second of secrets.slice(i + 1))
      if (data[first] === data[second]) throw new Error(`Invalid environment: ${second} must differ from ${first}`);
  return {
    workerUrl: data.CONNECTIONS_WORKER_URL,
    env: data.CONNECTIONS_ENV,
    internalSecret: data.CONNECTIONS_INTERNAL_SECRET,
    stateSecrets: {
      current: data.CONNECTIONS_STATE_SECRET,
      ...(data.CONNECTIONS_STATE_PREVIOUS_SECRET === undefined ? {} : { previous: data.CONNECTIONS_STATE_PREVIOUS_SECRET }),
    },
    returnUrl: data.CONNECTIONS_RETURN_URL,
    embeddedAddressSecret: data.CONNECTIONS_EMBEDDED_ADDRESS_SECRET ?? null,
  };
}
