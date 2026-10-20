// The API function's Google variables (docs/requirements/google-calendar.md G-12), all or none.
// Parsed from an object an entry point passes in; this module never reads process.env. Errors
// name variables, never values: every one of them is a secret or names one.
import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { googleClientConfigSchema, parseSealPublicKey, secureUrlProblem, type GoogleClientConfig, type OAuthStateSecrets } from "@zs/core";

const REQUIRED = "is required when any of its GOOGLE_ variables is set";
/** A URL that is https, or plain http on loopback (local tests against the fake Google). */
export const secureUrlVariable = (name: string) => z.string({ error: REQUIRED }).superRefine((value, ctx) => {
  const problem = secureUrlProblem(name, value);
  if (problem) ctx.addIssue({ code: "custom", message: problem.replace(`${name} `, "") });
});
export const signingSecretVariable = () => z.string({ error: REQUIRED }).min(32, "must be at least 32 characters");
export const googleClientVariables = {
  GOOGLE_CLIENT_ID: z.string({ error: REQUIRED }).min(1, REQUIRED).max(512, "must be at most 512 characters"),
  GOOGLE_CLIENT_SECRET: z.string({ error: REQUIRED }).min(1, REQUIRED).max(512, "must be at most 512 characters"),
  GOOGLE_OAUTH_BASE_URL: secureUrlVariable("GOOGLE_OAUTH_BASE_URL").optional(),
  GOOGLE_TOKEN_BASE_URL: secureUrlVariable("GOOGLE_TOKEN_BASE_URL").optional(),
  GOOGLE_API_BASE_URL: secureUrlVariable("GOOGLE_API_BASE_URL").optional(),
};

/** The client config from the parsed variables; base URLs only when set, so the defaults apply. */
export function googleClientFromVariables(data: {
  GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string;
  GOOGLE_OAUTH_BASE_URL?: string | undefined; GOOGLE_TOKEN_BASE_URL?: string | undefined; GOOGLE_API_BASE_URL?: string | undefined;
}, redirectUrl?: string): GoogleClientConfig {
  const client: GoogleClientConfig = {
    clientId: data.GOOGLE_CLIENT_ID,
    clientSecret: data.GOOGLE_CLIENT_SECRET,
    ...(redirectUrl === undefined ? {} : { redirectUrl }),
    ...(data.GOOGLE_OAUTH_BASE_URL === undefined ? {} : { oauthBaseUrl: data.GOOGLE_OAUTH_BASE_URL }),
    ...(data.GOOGLE_TOKEN_BASE_URL === undefined ? {} : { tokenBaseUrl: data.GOOGLE_TOKEN_BASE_URL }),
    ...(data.GOOGLE_API_BASE_URL === undefined ? {} : { apiBaseUrl: data.GOOGLE_API_BASE_URL }),
  };
  // The variables above already hold the client schema's rules; this guards against drift.
  if (!googleClientConfigSchema.safeParse(client).success) throw new Error("Invalid environment: GOOGLE_*: the Google client config is invalid");
  return client;
}

export const formatIssues = (error: z.ZodError) =>
  `Invalid environment: ${error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`;

const apiSchema = z.object({
  ...googleClientVariables,
  // https://<dashboard host>/api/calendar/google/callback, registered in Google Cloud as well. The
  // dashboard's route adds the browser key and calls /oauth/google/callback here (G-2).
  GOOGLE_REDIRECT_URL: secureUrlVariable("GOOGLE_REDIRECT_URL"),
  // The dashboard page the callback sends the owner back to (https://<dashboard host>/account/connections).
  GOOGLE_RETURN_URL: secureUrlVariable("GOOGLE_RETURN_URL"),
  GOOGLE_STATE_SECRET: signingSecretVariable(),
  GOOGLE_STATE_PREVIOUS_SECRET: signingSecretVariable().optional(),
  // Base64 of the DER SPKI of the X25519 key whose private half only the calendar worker holds.
  GOOGLE_TOKEN_PUBLIC_KEY: z.string({ error: REQUIRED }).transform((value, ctx) => {
    try {
      return parseSealPublicKey(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "must be base64 of the DER SPKI of an X25519 public key" });
      return z.NEVER;
    }
  }),
  GOOGLE_CHANNEL_SECRET: signingSecretVariable(),
});
/** What sets the API's Google side; the worker's own variables (G-12) are not among them. */
export const GOOGLE_API_VARIABLES: readonly string[] = Object.freeze(Object.keys(apiSchema.shape));

export interface GoogleEnv {
  readonly client: GoogleClientConfig;
  readonly returnUrl: string;
  readonly stateSecrets: OAuthStateSecrets;
  readonly tokenPublicKey: KeyObject;
  readonly channelSecret: string;
}

/**
 * G-12: null when no API Google variable is set (connecting, the callback and the webhook are
 * off). Any one set requires the rest; an empty value counts as unset.
 */
export function parseGoogleEnv(env: Readonly<Record<string, string | undefined>>): GoogleEnv | null {
  const given = GOOGLE_API_VARIABLES.filter((name) => env[name] !== undefined && env[name] !== "");
  if (given.length === 0) return null;
  const parsed = apiSchema.safeParse(Object.fromEntries(given.map((name) => [name, env[name]])));
  if (!parsed.success) throw new Error(formatIssues(parsed.error));
  const data = parsed.data;
  return {
    client: googleClientFromVariables(data, data.GOOGLE_REDIRECT_URL),
    returnUrl: data.GOOGLE_RETURN_URL,
    stateSecrets: {
      current: data.GOOGLE_STATE_SECRET,
      ...(data.GOOGLE_STATE_PREVIOUS_SECRET === undefined ? {} : { previous: data.GOOGLE_STATE_PREVIOUS_SECRET }),
    },
    tokenPublicKey: data.GOOGLE_TOKEN_PUBLIC_KEY,
    channelSecret: data.GOOGLE_CHANNEL_SECRET,
  };
}
