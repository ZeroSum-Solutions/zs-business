// Pieces the runners' env parsers share. A leaf module (imports only zod), so a config that takes
// them bundles nothing else.
import { z } from "zod";

/** Hosts a database URL may name when a runner is allowed to use a fake or local-only dependency. */
export const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);

/** An integer env variable (strings coerce) within [min, max]. */
export const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

/** An `on`/`off` deploy switch that defaults to off. */
export const switchSchema = z.enum(["on", "off"]).default("off");

/** Every issue of a failed parse as `path: message`, joined for one error line. */
export const problems = (error: z.ZodError) => error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
