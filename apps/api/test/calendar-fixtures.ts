// Shared pieces for the M5 Google Calendar API tests (docs/requirements/google-calendar.md):
// synthetic secrets and keys built at runtime, and an app over a harness's database with the
// Google routes on, talking to the in-process fake Google server. Fake pilot data only.
import { randomUUID } from "node:crypto";
import {
  createGoogleClient,
  createLocalStubSessionCheck,
  generateSealKeyPair,
  parseSealPrivateKey,
  parseSealPublicKey,
  type GoogleClient,
} from "@zs/core";
import type { ScopedDatabase } from "@zs/db";
import { createApp, createHs256Verifier, type GoogleCalendarConfig } from "../src/app.js";
import { ORIGIN, SECRET, type ApiHarness } from "./helpers.js";
import type { FakeGoogle } from "../../../packages/core/test/calendar/fake-google.js";

export { createFakeGoogle, type FakeGoogle } from "../../../packages/core/test/calendar/fake-google.js";

/** Synthetic secrets, built at runtime so secret scanners do not flag a literal. */
export const STATE_SECRET = ["test", "oauth-state", "s".repeat(32)].join("-");
export const PREVIOUS_STATE_SECRET = ["test", "oauth-state", "p".repeat(32)].join("-");
export const CHANNEL_SECRET = ["test", "channel", "c".repeat(32)].join("-");
export const SEAL_KEYS = generateSealKeyPair();
export const TOKEN_PUBLIC_KEY = parseSealPublicKey(SEAL_KEYS.publicKey);
export const TOKEN_PRIVATE_KEY = parseSealPrivateKey(SEAL_KEYS.privateKey);
export const REDIRECT_URL = "http://127.0.0.1:8787/oauth/google/callback";
export const RETURN_URL = "https://app.haldenrowe.example/settings/calendar?tab=google";

/** A real Google client pointed at the fake. */
export const fakeClient = (google: FakeGoogle): GoogleClient =>
  createGoogleClient({ config: google.clientConfig({ redirectUrl: REDIRECT_URL }) });

export function googleConfig(google: GoogleClient, over: Partial<GoogleCalendarConfig> = {}): GoogleCalendarConfig {
  return {
    google,
    stateSecrets: { current: STATE_SECRET },
    tokenPublicKey: TOKEN_PUBLIC_KEY,
    returnUrl: RETURN_URL,
    channelSecret: CHANNEL_SECRET,
    ...over,
  };
}

/** An app over the harness's database (or another one), with the Google routes on when configured. */
export function calendarApp(h: ApiHarness, options: {
  clock: { now(): Date };
  googleCalendar?: GoogleCalendarConfig;
  db?: ScopedDatabase;
  onError?: (error: unknown) => void;
}) {
  return createApp({
    verifier: createHs256Verifier(SECRET, { clock: options.clock }),
    sessionCheck: createLocalStubSessionCheck(h.database.db, options.clock),
    clock: options.clock,
    db: options.db ?? h.database.db,
    generateId: randomUUID,
    config: { allowedOrigins: [ORIGIN] },
    ...(options.googleCalendar ? { googleCalendar: options.googleCalendar } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
}
