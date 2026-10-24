// The image worker's environment (docs/requirements/image-port.md IM-7, IM-17, IM-21). Parsed from an
// object an entry point passes in; this module never reads process.env. IMAGE_WORKER is the kill
// switch: anything but `on` runs nothing and needs no other variable. The image config (adapter,
// prices, vendor costs and key) is the API's own parser, so both refuse the same deploys.
import { parse } from "pg-connection-string";
import { z } from "zod";
import { parseImageEnv, type ImageEnv } from "../config.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const onSchema = z.object({
  // The API's kind of login: unprivileged, under RLS. The worker's stage and fail actions run
  // through it as the tenant's image-worker principal (IM-10, IM-15).
  IMAGE_DATABASE_URL: z.string().min(1),
  // A login that may SET ROLE service_role: the claim, the wallet hold and the sweeps.
  IMAGE_SERVICE_DATABASE_URL: z.string().min(1),
  DATABASE_CA_CERT: z.string().includes("BEGIN CERTIFICATE").optional(),
  // The bucket the API's site store uses (SITES_STORE=r2): uploads, staging and assets live there.
  R2_ENDPOINT: z.url({ protocol: /^https$/ }),
  R2_BUCKET: z.string().min(3).max(63),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  IMAGE_INTERVAL_MS: int(1_000, 3_600_000).default(15_000),
});

export interface ImageRunnerEnv {
  readonly runtimeDatabaseUrl: string;
  readonly serviceDatabaseUrl: string;
  readonly databaseCaCert: string | undefined;
  readonly r2: { readonly endpoint: string; readonly bucket: string; readonly accessKeyId: string; readonly secretAccessKey: string };
  readonly intervalMs: number;
  readonly images: ImageEnv;
}

const problems = (error: z.ZodError) => error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");

/** Off loopback a login needs DATABASE_CA_CERT and no query string, as the API's does. */
function assertPinnedTls(name: string, url: string, caCert: string | undefined): void {
  let host: string;
  try {
    host = (parse(url).host ?? "").toLowerCase();
  } catch {
    throw new Error(`Invalid environment: ${name} is not a valid connection string`);
  }
  const loopback = LOOPBACK.has(host);
  if (!loopback && caCert === undefined) throw new Error(`Invalid environment: DATABASE_CA_CERT is required when ${name} is not a loopback host`);
  if ((!loopback || caCert !== undefined) && url.includes("?")) throw new Error(`Invalid environment: ${name} must not carry a query string`);
}

/** Null when IMAGE_WORKER is not `on`: nothing runs. */
export function parseImageRunnerEnv(env: Readonly<Record<string, string | undefined>>): ImageRunnerEnv | null {
  if (env.IMAGE_WORKER !== "on") return null;
  const parsed = onSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid environment: ${problems(parsed.error)}`);
  const data = parsed.data;
  assertPinnedTls("IMAGE_DATABASE_URL", data.IMAGE_DATABASE_URL, data.DATABASE_CA_CERT);
  assertPinnedTls("IMAGE_SERVICE_DATABASE_URL", data.IMAGE_SERVICE_DATABASE_URL, data.DATABASE_CA_CERT);
  const images = parseImageEnv(env, data.IMAGE_DATABASE_URL);
  if (images === null) throw new Error("Invalid environment: IMAGE_WORKER=on needs IMAGE_ADAPTER");
  return {
    runtimeDatabaseUrl: data.IMAGE_DATABASE_URL,
    serviceDatabaseUrl: data.IMAGE_SERVICE_DATABASE_URL,
    databaseCaCert: data.DATABASE_CA_CERT,
    r2: { endpoint: data.R2_ENDPOINT, bucket: data.R2_BUCKET, accessKeyId: data.R2_ACCESS_KEY_ID, secretAccessKey: data.R2_SECRET_ACCESS_KEY },
    intervalMs: data.IMAGE_INTERVAL_MS,
    images,
  };
}
