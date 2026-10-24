// enrichment.md E-5, E-8, E-9: injected configuration. Core never reads process.env; the API builds
// this from its environment with parseEnrichmentEnv.
import { z } from "zod";

export const enrichmentConfigSchema = z.strictObject({
  /** `ENRICHMENT_PROVIDER`: `treg` or `fake`; anything else (or nothing) is off. */
  provider: z.enum(["treg", "fake"]).optional(),
  /** `TREG_ARCHIVE_CONFIRMED_OFF` is exactly `true`: the owner turned Treg's public archive off. */
  archiveConfirmedOff: z.boolean().default(false),
  /** `ENRICHMENT_DISABLED` set: the kill switch. */
  disabled: z.boolean().default(false),
  /** E-8: whole USD cents per op. */
  prices: z.strictObject({ "company.enrich": z.number().int().positive().max(10_000).default(5) }).default({ "company.enrich": 5 }),
  tenantDailyCap: z.number().int().positive().default(50),
  globalDailyCap: z.number().int().positive().default(200),
});
export type EnrichmentConfig = z.infer<typeof enrichmentConfigSchema>;
export type EnrichmentConfigInput = z.input<typeof enrichmentConfigSchema>;

/** E-5: the service gates. `false` means every request and attempt is refused `enrichment_unavailable`. */
export const enrichmentEnabled = (config: Pick<EnrichmentConfig, "provider" | "archiveConfirmedOff" | "disabled">): boolean =>
  (config.provider === "treg" || config.provider === "fake") && config.archiveConfirmedOff && !config.disabled;

const positive = (raw: string | undefined) => (raw !== undefined && /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : undefined);

/** Builds the config from environment-style values: exact-match flags, unknown providers are off. */
export function parseEnrichmentEnv(env: Readonly<Record<string, string | undefined>>): EnrichmentConfig {
  const provider = env.ENRICHMENT_PROVIDER === "treg" || env.ENRICHMENT_PROVIDER === "fake" ? env.ENRICHMENT_PROVIDER : undefined;
  const price = positive(env.ENRICHMENT_PRICE_COMPANY_CENTS);
  return enrichmentConfigSchema.parse({
    provider,
    archiveConfirmedOff: env.TREG_ARCHIVE_CONFIRMED_OFF === "true",
    disabled: env.ENRICHMENT_DISABLED !== undefined,
    ...(price ? { prices: { "company.enrich": price } } : {}),
    ...(positive(env.ENRICHMENT_TENANT_DAILY_CAP) ? { tenantDailyCap: positive(env.ENRICHMENT_TENANT_DAILY_CAP) } : {}),
    ...(positive(env.ENRICHMENT_GLOBAL_DAILY_CAP) ? { globalDailyCap: positive(env.ENRICHMENT_GLOBAL_DAILY_CAP) } : {}),
  });
}
