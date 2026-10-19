// Entry point: mint one HS256 access token and write it to stdout with no newline, for a
// pipe into the secret store (never a terminal or a log). Pilot use: the dashboard's
// server-side ZS_API_TOKEN. Needs JWT_SECRET, ZS_TOKEN_TENANT_ID, ZS_TOKEN_SUBJECT and
// ZS_TOKEN_TTL_SECONDS (at most the API's JWT_MAX_TTL_SECONDS); JWT_ISSUER when the API sets it.
import process from "node:process";
import { z } from "zod";
import { jwtSecretSchema } from "../config.js";
import { signDevToken } from "../dev-token.js";

const env = z.object({
  JWT_SECRET: jwtSecretSchema,
  JWT_ISSUER: z.string().min(1).optional(),
  ZS_TOKEN_TENANT_ID: z.uuid(),
  ZS_TOKEN_SUBJECT: z.uuid(),
  ZS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(30 * 24 * 3600),
}).parse(process.env);
if (process.stdout.isTTY) throw new Error("Refusing to print a token to a terminal; pipe it into the secret store");

const token = await signDevToken(env.JWT_SECRET, { tenantId: env.ZS_TOKEN_TENANT_ID, actorId: env.ZS_TOKEN_SUBJECT },
  { now: () => new Date() }, env.ZS_TOKEN_TTL_SECONDS, env.JWT_ISSUER);
process.stdout.write(token);
