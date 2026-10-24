// Adapter choice and prices (image-port.md IM-6, IM-7). Injected at start-up, never read from a request.
import { imageAdapterSchema, ValidationFailed, type ImageAdapter, type ImagePreset } from "@zs/contracts";
import { z } from "zod";

export const IMAGE_ENVIRONMENTS = ["production", "development", "test"] as const;

/**
 * IM-7: the server's price for one job, in minor units of the tenant wallet's currency. These are
 * placeholders until the owner sets real prices (Known limits: per-job prices are an open question).
 */
const PLACEHOLDER_PRICES = Object.freeze({ background_remove: 8, studio_background_swap: 20, upscale_2k: 12 });
export const IMAGE_PRICES: Readonly<Record<ImageAdapter, Readonly<Record<ImagePreset, number>>>> = Object.freeze({
  kie: PLACEHOLDER_PRICES,
  fal: PLACEHOLDER_PRICES,
  higgsfield: PLACEHOLDER_PRICES,
  comfyui: PLACEHOLDER_PRICES,
  fake: PLACEHOLDER_PRICES,
});

const configSchema = z.strictObject({
  environment: z.enum(IMAGE_ENVIRONMENTS),
  adapter: imageAdapterSchema,
  /** The wallet currency the prices are in (lowercase ISO code, as wallets store it). */
  currency: z.string().regex(/^[a-z]{3}$/).default("usd"),
  /** IM-7: how long an unknown outcome waits for the vendor's answer before it fails `outcome_unknown`. */
  outcomeWaitMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1000).default(10 * 60 * 1000),
});
export type ImageConfig = z.infer<typeof configSchema>;

/** IM-6: production names only `kie` or `fal`, so Higgsfield credits and the fake never serve a tenant. */
export function parseImageConfig(raw: unknown): ImageConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationFailed(`Invalid image config: ${parsed.error.message}`);
  const config = parsed.data;
  if (config.environment === "production" && config.adapter !== "kie" && config.adapter !== "fal")
    throw new ValidationFailed(`The ${config.adapter} image adapter cannot run in production`);
  if (config.environment === "test" && config.adapter !== "fake")
    throw new ValidationFailed("Tests run the fake image adapter only");
  return Object.freeze(config);
}

export const imagePrice = (config: ImageConfig, preset: ImagePreset): { priceMinor: number; currency: string } =>
  ({ priceMinor: IMAGE_PRICES[config.adapter][preset], currency: config.currency });
