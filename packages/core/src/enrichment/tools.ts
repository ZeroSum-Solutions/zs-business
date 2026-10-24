// enrichment.md E-2: the only Treg tools this code may call. The map is frozen and the adapter refuses
// any tool id that is not one of its values before it makes a network call.
import type { EnrichmentOp } from "@zs/contracts";

export const ENRICHMENT_TOOLS: Readonly<Record<EnrichmentOp, string>> = Object.freeze({
  "company.enrich": "treg.companies.enrich",
});

export function isAllowedTool(toolId: string): boolean {
  return Object.values(ENRICHMENT_TOOLS).includes(toolId);
}
