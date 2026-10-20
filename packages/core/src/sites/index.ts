import {
  activateSiteReleaseCommandSchema,
  createSiteCommandSchema,
  publishSiteReleaseCommandSchema,
  siteOutputSchema,
  siteReleaseOutputSchema,
  type ActionCommand,
  type ActionResult,
  type ActivateSiteReleaseCommand,
  type CreateSiteCommand,
  type PublishSiteReleaseCommand,
  type SiteOutput,
  type SiteReleaseOutput,
} from "@zs/contracts";
import { parseOrFail } from "../crm/rows.js";

export { siteHandlers } from "./handlers.js";
export { plainSiteCompiler, verifyCompiledSite, type CompiledSite, type CompiledSiteFile, type SiteCompiler, type VerifiedRelease } from "./compiler.js";
export { createMemorySiteStore, type MemorySiteStore } from "./memory-store.js";
export { storeReleaseFiles } from "./publish.js";
export { loadSiteEdgeState, projectSiteEdge, retractHostPointer, syncSiteEdge, type ProjectOptions, type SiteEdgeState } from "./sync.js";
export { attachSiteHost, detachSiteHost, type DetachedHost, type SiteHostInput } from "./hosts.js";
export { findSite, getRelease, getSite, listReleases, listSites } from "./reads.js";

interface SiteWriteContext {
  readonly dispatch: (command: ActionCommand) => Promise<ActionResult>;
}
// Parse once, dispatch once, validate the envelope: the same shape as the CRM wrappers.
export async function createSite(command: CreateSiteCommand, ctx: SiteWriteContext): Promise<SiteOutput> {
  return parseOrFail(siteOutputSchema, await ctx.dispatch(parseOrFail(createSiteCommandSchema, command)));
}
export async function publishSiteRelease(command: PublishSiteReleaseCommand, ctx: SiteWriteContext): Promise<SiteReleaseOutput> {
  // Parsed, an absent baseline is absent rather than undefined, so the payload is plain JSON.
  const parsed = parseOrFail(publishSiteReleaseCommandSchema, command) as ActionCommand;
  return parseOrFail(siteReleaseOutputSchema, await ctx.dispatch(parsed));
}
export async function activateSiteRelease(command: ActivateSiteReleaseCommand, ctx: SiteWriteContext): Promise<SiteReleaseOutput> {
  return parseOrFail(siteReleaseOutputSchema, await ctx.dispatch(parseOrFail(activateSiteReleaseCommandSchema, command)));
}
