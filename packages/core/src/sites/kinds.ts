// hub-access.md H-17: one compiler per server, dispatching on the spec's top-level `kind`. Original code.
import type { SiteSpec } from "@zs/contracts";
import { validationError } from "../edge/errors.js";
import type { SiteCompiler } from "./compiler.js";

/** The kinds a spec may name. An untagged spec belongs to the publisher slot (a Mish recipe carries no `kind`). */
export const SITE_KINDS = Object.freeze(["plain", "linkpage"] as const);

export interface SiteKindCompilers {
  /** `{ kind: "plain" }`. */
  readonly plain?: SiteCompiler;
  /** A spec with no `kind`: today's publisher recipes. */
  readonly publisher?: SiteCompiler;
  /** `{ kind: "linkpage" }`. Not wired yet: the `@mish/linkpage` adapter is a later change, and until then this kind is a 400. */
  readonly linkpage?: SiteCompiler;
}

const refuse = (message: string, detail: string) => validationError(message, [{ path: ["spec", "kind"], message: detail }]);

export function createKindSiteCompiler(compilers: SiteKindCompilers): SiteCompiler {
  const known = SITE_KINDS.join(", ");
  return {
    async compile(spec: SiteSpec, context) {
      const kind = Object.hasOwn(spec, "kind") ? spec.kind : undefined;
      if (kind === undefined) {
        if (!compilers.publisher) throw refuse("Invalid site spec", `Required: one of ${known}`);
        return compilers.publisher.compile(spec, context);
      }
      if (kind === "plain" || kind === "linkpage") {
        const compiler = compilers[kind];
        if (!compiler) throw refuse("Invalid site spec", `The ${kind} site kind is not available`);
        return compiler.compile(spec, context);
      }
      throw refuse("Unknown site kind", `Must be one of ${known}`);
    },
  };
}
