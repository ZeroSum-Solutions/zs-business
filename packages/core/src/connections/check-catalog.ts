// Connections A-8, C-6: the owner-run catalog check. For every slug the catalog pins (identity tool and
// read tools) it asks Composio whether the tool exists, belongs to the catalog's toolkit and still offers
// the pinned version. It is read-only, makes no account call, and its report holds slugs, versions and
// our problem codes only: never the key and never provider text. CI never runs it (no network in tests);
// the owner runs `pnpm connections:check-catalog` with the preview key from the vault.
import { COMPOSIO_CATALOG, type CatalogToolkit } from "./catalog.js";
import { ComposioError, type ComposioClient } from "./composio.js";

export type CatalogCheckProblem = "slug_missing" | "slug_changed" | "wrong_toolkit" | "version_missing" | "key_refused" | "rate_limited" | "unavailable";
export interface CatalogCheckResult {
  readonly toolkit: string;
  /** Our tool name, or `identity` for the toolkit's identity tool. */
  readonly name: string;
  readonly slug: string;
  readonly version: string;
  readonly problem: CatalogCheckProblem | null;
}
export interface CatalogCheckReport { readonly ok: boolean; readonly results: readonly CatalogCheckResult[] }

export async function checkComposioCatalog(
  client: Pick<ComposioClient, "getTool">,
  catalog: readonly CatalogToolkit[] = COMPOSIO_CATALOG,
  signal?: AbortSignal,
): Promise<CatalogCheckReport> {
  const results: CatalogCheckResult[] = [];
  for (const toolkit of catalog) {
    const entries = [{ name: "identity", slug: toolkit.identity.slug, version: toolkit.identity.version }, ...toolkit.tools.map(({ name, slug, version }) => ({ name, slug, version }))];
    for (const entry of entries) {
      let problem: CatalogCheckProblem | null;
      try {
        const tool = await client.getTool(entry.slug, signal);
        problem = tool === null ? "slug_missing"
          : tool.slug !== entry.slug ? "slug_changed"
          : tool.toolkit !== toolkit.toolkit ? "wrong_toolkit"
          : !tool.versions.includes(entry.version) ? "version_missing"
          : null;
      } catch (error) {
        if (!(error instanceof ComposioError)) throw error;
        problem = error.kind === "key_refused" ? "key_refused" : error.kind === "rate_limited" ? "rate_limited" : "unavailable";
      }
      results.push({ toolkit: toolkit.toolkit, ...entry, problem });
    }
  }
  return { ok: results.every((result) => result.problem === null), results };
}
