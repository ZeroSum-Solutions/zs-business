/**
 * Where sign-in may send the browser next: only a page on this site, as an absolute URL.
 * `next` is resolved the way the browser resolves a link, so "//x", "/\\x", "/\t/x",
 * "javascript:" and "https://x" all fall back to home. A same-origin result can still have
 * a path that starts with several slashes ("/.//x" and "/%2e//x" resolve to "//x"); that run
 * is collapsed to one "/", because "//x" names another site wherever it is read as a
 * relative link. The final string is checked once more before it is returned.
 *
 * Pure (no window, no Node APIs), so the browser and the server share the one check.
 */
export function safeNextUrl(next: string | null | undefined, origin: string): string {
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return "/";
  }
  const home = `${base.origin}/`;
  if (!next?.startsWith("/")) return home;
  try {
    const url = new URL(next, base.origin);
    if (url.origin !== base.origin) return home;
    const candidate = `${url.origin}${url.pathname.replace(/^[/\\]+/, "/")}${url.search}${url.hash}`;
    const final = new URL(candidate);
    if (final.origin !== base.origin || /^[/\\]{2}/.test(final.pathname)) return home;
    return final.href;
  } catch {
    return home;
  }
}
