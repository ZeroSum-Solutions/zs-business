/**
 * Fails when the browser-facing build output holds a bearer token or a secret value.
 * Scans <distDir>/static and the prerendered pages and RSC payloads under
 * <distDir>/server/app, which are sent to browsers as they are. Looks for anything shaped
 * like a JWT, and for the exact values of ZS_API_TOKEN, JWT_SECRET and every
 * newline-separated value in ZS_BUNDLE_SECRETS. Reports file names only, never the value.
 *
 * Run: node scripts/bundle-secrets.ts [distDir]   (the build script runs it on .next)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const STATIC_FILES = /\.(?:js|mjs|css|map|json|html|txt)$/;
/** Server-rendered output that is sent to browsers as is; the server's own code is not. */
const PAGE_FILES = /\.(?:html|rsc|body)$/;

export interface BundleLeak {
  file: string;
  kind: "jwt" | "secret";
}

function walk(dir: string, pattern: RegExp, out: string[]) {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, pattern, out);
    else if (pattern.test(name)) out.push(full);
  }
}

/** Files the browser can download from this build. */
export function publicBuildFiles(distDir: string): string[] {
  const files: string[] = [];
  walk(path.join(distDir, "static"), STATIC_FILES, files);
  walk(path.join(distDir, "server", "app"), PAGE_FILES, files);
  return files;
}

export function secretValues(env: Record<string, string | undefined> = process.env): string[] {
  const values = [env.ZS_API_TOKEN, env.JWT_SECRET, ...(env.ZS_BUNDLE_SECRETS ?? "").split("\n")];
  // Very short values would match by chance; real tokens and secrets are long.
  return values.map((value) => value?.trim() ?? "").filter((value) => value.length >= 16);
}

export function findBundleLeaks(distDir: string, secrets: readonly string[]): BundleLeak[] {
  const files = publicBuildFiles(distDir);
  if (files.length === 0) throw new Error(`No build output under ${distDir}; build first`);
  const leaks: BundleLeak[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const relative = path.relative(distDir, file);
    if (JWT.test(text)) leaks.push({ file: relative, kind: "jwt" });
    if (secrets.some((secret) => text.includes(secret))) leaks.push({ file: relative, kind: "secret" });
  }
  return leaks;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const distDir = path.resolve(process.argv[2] ?? process.env.NEXT_DIST_DIR ?? ".next");
  const leaks = findBundleLeaks(distDir, secretValues());
  if (leaks.length > 0) {
    for (const leak of leaks) console.error(`bundle-secrets: ${leak.kind} in ${leak.file}`);
    process.exit(1);
  }
  console.log(`bundle-secrets: no tokens or secrets in ${path.relative(process.cwd(), distDir) || "."}`);
}
