// Adapter choice and prices (image-port.md IM-6, IM-7). Injected at start-up, never read from a request.
import { imageAdapterSchema, ValidationFailed, type ImagePreset } from "@zs/contracts";
import { z } from "zod";

export const IMAGE_ENVIRONMENTS = ["production", "development", "test"] as const;

/**
 * IM-7, IM-20: the test double's price for one job, in minor units. Only the fake adapter in the
 * test environment may fall back to it; every other deploy names its prices in config.
 */
export const FAKE_TEST_PRICES: Readonly<Record<ImagePreset, number>> = Object.freeze({
  background_remove: 8, studio_background_swap: 20, upscale_2k: 12,
});

const pricesSchema = z.strictObject({
  background_remove: z.number().int().min(1).max(100_000),
  studio_background_swap: z.number().int().min(1).max(100_000),
  upscale_2k: z.number().int().min(1).max(100_000),
});

const configSchema = z.strictObject({
  environment: z.enum(IMAGE_ENVIRONMENTS),
  adapter: imageAdapterSchema,
  /** The wallet currency the prices are in (lowercase ISO code, as wallets store it). */
  currency: z.string().regex(/^[a-z]{3}$/).default("usd"),
  /** IM-7: how long an unknown outcome waits for the vendor's answer before it fails `outcome_unknown`. */
  outcomeWaitMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1000).default(10 * 60 * 1000),
  /** IM-20: the server's price per preset, in minor units of `currency`. Read from config, never from code. */
  prices: pricesSchema.optional(),
});
export type ImageConfig = Omit<z.infer<typeof configSchema>, "prices"> & { readonly prices: Readonly<Record<ImagePreset, number>> };

/** IM-6: production names only `kie` or `fal`, so Higgsfield credits and the fake never serve a tenant. */
export function parseImageConfig(raw: unknown): ImageConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationFailed(`Invalid image config: ${parsed.error.message}`);
  const config = parsed.data;
  if (config.environment === "production" && config.adapter !== "kie" && config.adapter !== "fal")
    throw new ValidationFailed(`The ${config.adapter} image adapter cannot run in production`);
  if (config.environment === "test" && config.adapter !== "fake")
    throw new ValidationFailed("Tests run the fake image adapter only");
  const fallback = config.environment === "test" && config.adapter === "fake" ? FAKE_TEST_PRICES : undefined;
  const prices = config.prices ?? fallback;
  if (!prices) throw new ValidationFailed(`The ${config.adapter} image adapter needs its prices in config`);
  return Object.freeze({ ...config, prices: Object.freeze({ ...prices }) });
}

export const imagePrice = (config: ImageConfig, preset: ImagePreset): { priceMinor: number; currency: string } =>
  ({ priceMinor: config.prices[preset], currency: config.currency });
