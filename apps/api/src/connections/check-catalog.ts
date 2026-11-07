// Connections A-8, C-6: `pnpm connections:check-catalog`, owner-run against the preview project:
//   zsvault run --env COMPOSIO_API_KEY=<vault id> -- pnpm connections:check-catalog
// Reads COMPOSIO_API_KEY (and an optional https COMPOSIO_BASE_URL) from the environment only, checks every
// catalog slug and pinned version, prints one JSON report of slugs, versions and problem codes (never the
// key), and exits 0 when all match, 1 on any mismatch and 2 when it cannot run.
import { checkComposioCatalog, COMPOSIO_BASE_URL, createComposioClient } from "@zs/core";

export async function runCatalogCheck(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly write: (line: string) => void;
}): Promise<0 | 1 | 2> {
  const apiKey = input.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) {
    input.write("COMPOSIO_API_KEY is required (run it through zsvault run --env)");
    return 2;
  }
  const baseUrl = input.env.COMPOSIO_BASE_URL?.trim() || COMPOSIO_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    input.write("COMPOSIO_BASE_URL is not a URL");
    return 2;
  }
  if (parsed.protocol !== "https:") {
    input.write("COMPOSIO_BASE_URL must be https");
    return 2;
  }
  const client = createComposioClient({ apiKey, baseUrl, ...(input.fetch ? { fetch: input.fetch } : {}) });
  const report = await checkComposioCatalog(client);
  input.write(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}
