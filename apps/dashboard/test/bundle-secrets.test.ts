import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findBundleLeaks, secretValues } from "../scripts/bundle-secrets";

const dirs: string[] = [];
function build(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "zs-bundle-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJvd25lciIsInJvbGUiOiJhdXRoZW50aWNhdGVkIn0", "c2lnbmF0dXJlLXZhbHVlLWhlcmU"].join(".");
const secret = "0123456789abcdef0123456789abcdef";

describe("bundle secret check", () => {
  it("passes a clean build", () => {
    const dir = build({ "static/chunks/app.js": "console.log('hi')", "server/app/index.html": "<html></html>" });
    expect(findBundleLeaks(dir, [secret])).toEqual([]);
  });

  it("finds a token inlined into page JS, as NEXT_PUBLIC_API_TOKEN did", () => {
    const dir = build({ "static/chunks/app/layout.js": `let t="${jwt}";` });
    expect(findBundleLeaks(dir, [])).toEqual([{ file: path.join("static", "chunks", "app", "layout.js"), kind: "jwt" }]);
  });

  it("finds a secret value in prerendered HTML or RSC payloads", () => {
    const dir = build({ "static/chunks/a.js": "", "server/app/calendar.rsc": `0:${secret}`, "server/app/index.html": `<script>${secret}</script>` });
    expect(findBundleLeaks(dir, [secret]).map((leak) => leak.kind)).toEqual(["secret", "secret"]);
  });

  it("does not scan the server's own code, which never ships", () => {
    const dir = build({ "static/chunks/a.js": "", "server/app/api/[...path]/route.js": `process.env.ZS_API_TOKEN ?? "${secret}"` });
    expect(findBundleLeaks(dir, [secret])).toEqual([]);
  });

  it("refuses to pass an empty or missing build", () => {
    expect(() => findBundleLeaks(build({}), [])).toThrow(/build first/);
  });

  it("collects the token, the JWT secret and extra values, skipping short ones", () => {
    expect(secretValues({ ZS_API_TOKEN: jwt, JWT_SECRET: secret, ZS_BUNDLE_SECRETS: `short\n${secret}x` })).toEqual([jwt, secret, `${secret}x`]);
  });
});
