import { createHash } from "node:crypto";
import {
  plainSiteSpecSchema,
  siteFilesSchema,
  siteReleaseDigest,
  sitePathSchema,
  ValidationFailed,
  type SiteFile,
  type SiteSpec,
} from "@zs/contracts";
import { validationError } from "../edge/errors.js";

/** One compiled file. `sha256` and the result's `digest` are optional claims the publisher checks. */
export interface CompiledSiteFile {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly sha256?: string;
}
/** Structurally the result of @mish/publisher `compile` (entry, files, digest). */
export interface CompiledSite {
  readonly entry: string;
  readonly files: readonly CompiledSiteFile[];
  readonly digest?: string;
}
/**
 * The compiler port: a spec in, deterministic static files out. Same spec, same bytes, so a
 * publish retried with its idempotency key rebuilds the release it already recorded. Throw
 * `ValidationFailed` for a spec the compiler refuses; anything else is a server fault.
 */
export interface SiteCompiler {
  compile(spec: SiteSpec): Promise<CompiledSite>;
}

/** A compiled release, checked: every digest recomputed from the bytes, files sorted by path. */
export interface VerifiedRelease {
  readonly entry: string;
  readonly digest: string;
  readonly files: readonly SiteFile[];
  readonly bytes: ReadonlyMap<string, Uint8Array>;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Recompute what the compiler claims; a mismatch is a compiler fault, never trusted. */
export async function verifyCompiledSite(compiled: CompiledSite): Promise<VerifiedRelease> {
  const bytes = new Map<string, Uint8Array>();
  const files: SiteFile[] = [];
  for (const file of compiled.files) {
    const copy = new Uint8Array(file.bytes);
    const digest = sha256(copy);
    if (file.sha256 !== undefined && file.sha256 !== digest) throw new Error(`Compiler reported a wrong SHA-256 for ${file.path}`);
    bytes.set(file.path, copy);
    files.push({ path: file.path, mediaType: file.mediaType, sha256: digest, bytes: copy.byteLength });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const parsed = siteFilesSchema.safeParse(files);
  if (!parsed.success) throw validationError("The compiled site breaks the release limits", parsed.error.issues);
  const entry = sitePathSchema.safeParse(compiled.entry);
  if (!entry.success || !bytes.has(entry.data)) throw new ValidationFailed("The compiled site has no entry page");
  const digest = await siteReleaseDigest(parsed.data);
  if (compiled.digest !== undefined && compiled.digest !== digest) throw new Error("Compiler reported a wrong release digest");
  return { entry: entry.data, digest, files: parsed.data, bytes };
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const encoder = new TextEncoder();
const STYLE = "body{font-family:system-ui,sans-serif;max-width:40rem;margin:0 auto;padding:2rem 1rem;line-height:1.5;color:#1f2933}h1{margin-bottom:.25rem}header p{margin-top:0;color:#52606d}section{margin-top:2rem}";
const page = (title: string, body: string) =>
  `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">` +
  `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>\n`;

/** The built-in compiler for `{ kind: "plain" }` specs: an index page and a 404 page, all text escaped. */
export const plainSiteCompiler: SiteCompiler = {
  async compile(spec) {
    const parsed = plainSiteSpecSchema.safeParse(spec);
    if (!parsed.success) throw validationError("Invalid site spec", parsed.error.issues);
    const { title, tagline, sections } = parsed.data;
    const header = `<header><h1>${escapeHtml(title)}</h1>${tagline ? `<p>${escapeHtml(tagline)}</p>` : ""}</header>`;
    const main = sections.map((section) =>
      `<section><h2>${escapeHtml(section.heading)}</h2>${section.body.split(/\n{2,}/).map((para) => `<p>${escapeHtml(para)}</p>`).join("")}</section>`).join("");
    const html = "text/html; charset=utf-8";
    return {
      entry: "index.html",
      files: [
        { path: "404.html", mediaType: html, bytes: encoder.encode(page(`Not found · ${title}`, `${header}<main><p>This page does not exist.</p><p><a href="/">Home</a></p></main>`)) },
        { path: "index.html", mediaType: html, bytes: encoder.encode(page(title, `${header}<main>${main}</main>`)) },
      ],
    };
  },
};
