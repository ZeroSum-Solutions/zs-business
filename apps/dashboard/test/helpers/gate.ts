import { issueSessionValue, SESSION_COOKIE, type PilotGateConfig } from "../../src/lib/server/pilot-gate";

/** Synthetic gate settings, built at runtime so secret scanners do not flag a literal. */
export const GATE: PilotGateConfig = {
  accessCode: ["pilot", "code", "x".repeat(12)].join("-"),
  sessionSecret: ["session", "secret", "y".repeat(32)].join("-"),
  ttlSeconds: 12 * 60 * 60,
  trustProxy: false,
};

/** A Cookie header holding a session the gate signed at `now`. */
export function sessionCookieHeader(config: PilotGateConfig = GATE, now: Date = new Date()): string {
  return `${SESSION_COOKIE}=${issueSessionValue(config, now).value}`;
}
