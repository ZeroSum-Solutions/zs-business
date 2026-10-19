// The verifiers live in @zs/core (edge/auth.ts) so the API and the MCP server share one
// authentication path; this module keeps the API's existing imports working.
export {
  createHs256Verifier,
  createJwksVerifier,
  createVerifierFromConfig,
  DEFAULT_CLOCK_SKEW_SECONDS,
  DEFAULT_MAX_TOKEN_LIFETIME_SECONDS,
  Unauthenticated,
  type SupabaseTokenOptions,
  type TokenVerifier,
  type VerifiedToken,
} from "@zs/core";
