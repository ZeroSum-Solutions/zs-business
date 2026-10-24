// Browser task configuration, injected (no ambient process.env in core). The step price is an open
// question of the contract (browser-tasks.md Known limits): it is a required input, not a default.
import { ValidationFailed } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ModelPrices } from "../agents/cost.js";

export interface BrowserConfig {
  /** BT-9: wallet minor units one step costs; a claim reserves `maxSteps` times this. */
  readonly stepPrice: number;
  /** The wallet currency the step price is in. */
  readonly currency: string;
  /** BT-7: how long a claim lasts without a control or event call. */
  readonly leaseMs: number;
  /** BT-12: how long past its deadline a `running` run waits before it is closed `stalled`. */
  readonly stallGraceMs: number;
  /** BT-3: accept `http://` loopback origins. Only the fixture site and local tests turn this on. */
  readonly allowLoopback: boolean;
  /** G-15: the price table the planner's model usage is priced from. */
  readonly modelPrices: ModelPrices;
  /**
   * BT-9: the model cost, in micros, one step reserves when it is admitted (at least one planner
   * call at its maximum tokens under `modelPrices`). A step whose call costs more is still recorded
   * and closes the run `cost_cap`, so this bounds the overshoot to the excess of one call.
   */
  readonly stepModelReserveMicros: number;
}

export function browserConfig(input: Partial<BrowserConfig> & Pick<BrowserConfig, "stepPrice" | "modelPrices" | "stepModelReserveMicros">): BrowserConfig {
  const config: BrowserConfig = {
    currency: "usd", leaseMs: 120_000, stallGraceMs: 300_000, allowLoopback: false, ...input,
  };
  if (!Number.isSafeInteger(config.stepPrice) || config.stepPrice < 1) throw new ValidationFailed("stepPrice must be a positive integer");
  if (!Number.isSafeInteger(config.stepModelReserveMicros) || config.stepModelReserveMicros < 1)
    throw new ValidationFailed("stepModelReserveMicros must be a positive integer");
  if (!Number.isSafeInteger(config.leaseMs) || config.leaseMs < 1000) throw new ValidationFailed("leaseMs must be at least 1000");
  if (!Number.isSafeInteger(config.stallGraceMs) || config.stallGraceMs < 0) throw new ValidationFailed("stallGraceMs must not be negative");
  return Object.freeze(config);
}

/** BT-8: the credentials a run signs in with. The values live only in the claim response and the runner's memory. */
export interface BrowserCredentials {
  readonly username: string;
  readonly password: string;
}
export interface BrowserCredentialResolver {
  resolve(tx: Transaction, input: { tenantId: string; targetId: string; secretRef: string }): Promise<BrowserCredentials | null>;
}

/** A reference names a secret under the tenant's own prefix; any other name is refused before a lookup. */
export const secretPrefix = (tenantId: string) => `browser/${tenantId.toLowerCase()}/`;

/**
 * BT-8: reads a Supabase Vault secret by name. The secret is a JSON object `{"username","password"}`.
 * Runs in the service-role claim transaction, so the Vault view is readable. A name outside the
 * tenant's prefix yields nothing.
 */
export function createVaultCredentialResolver(): BrowserCredentialResolver {
  return {
    async resolve(tx, { tenantId, secretRef }) {
      if (!secretRef.startsWith(secretPrefix(tenantId))) return null;
      const row = (await tx.query<{ decrypted_secret: string }>(
        "SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=$1", [secretRef])).rows[0];
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.decrypted_secret) as Record<string, unknown>;
        return typeof parsed.username === "string" && typeof parsed.password === "string"
          ? { username: parsed.username, password: parsed.password } : null;
      } catch { return null; }
    },
  };
}

/** Tests and the fixture: a fixed map of `<secretRef>` to credentials. */
export function createStaticCredentialResolver(secrets: Readonly<Record<string, BrowserCredentials>>): BrowserCredentialResolver {
  return {
    async resolve(_tx, { tenantId, secretRef }) {
      return secretRef.startsWith(secretPrefix(tenantId)) ? secrets[secretRef] ?? null : null;
    },
  };
}
