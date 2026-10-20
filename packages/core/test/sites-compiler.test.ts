import { describe, expect, it } from "vitest";
import { siteReleaseDigest } from "@zs/contracts";
import { plainSiteCompiler, verifyCompiledSite } from "../src/sites/index.js";

const encode = (text: string) => new TextEncoder().encode(text);

describe("the plain site compiler", () => {
  it("escapes every text field and is deterministic", async () => {
    const spec = { kind: "plain", title: "<script>alert(1)</script>", tagline: "A & B", sections: [{ heading: "\"Hi\"", body: "One\n\nTwo <b>" }] };
    const first = await verifyCompiledSite(await plainSiteCompiler.compile(spec));
    const second = await verifyCompiledSite(await plainSiteCompiler.compile(structuredClone(spec)));
    expect(second.digest).toBe(first.digest);
    const html = new TextDecoder().decode(first.bytes.get("index.html"));
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("<p>One</p><p>Two &lt;b&gt;</p>");
    expect(first.files.map((file) => file.path)).toEqual(["404.html", "index.html"]);
  });

  it("refuses a spec it does not know", async () => {
    await expect(plainSiteCompiler.compile({ kind: "recipe" })).rejects.toMatchObject({ code: "ValidationFailed" });
  });
});

describe("verifyCompiledSite", () => {
  const file = (path: string, text: string) => ({ path, mediaType: "text/plain", bytes: encode(text) });

  it("recomputes digests and sorts files, as @mish/publisher does", async () => {
    const release = await verifyCompiledSite({ entry: "index.html", files: [file("z.txt", "z"), file("index.html", "hi")] });
    expect(release.files.map((f) => f.path)).toEqual(["index.html", "z.txt"]);
    expect(release.digest).toBe(await siteReleaseDigest(release.files));
  });

  it("refuses wrong claims, unsafe paths, duplicates and a missing entry", async () => {
    await expect(verifyCompiledSite({ entry: "index.html", files: [{ ...file("index.html", "hi"), sha256: "0".repeat(64) }] }))
      .rejects.toThrow(/wrong SHA-256/);
    await expect(verifyCompiledSite({ entry: "index.html", files: [file("index.html", "hi")], digest: "0".repeat(64) }))
      .rejects.toThrow(/wrong release digest/);
    for (const path of ["../x", "/abs", "a//b", "a/./b", "a b"])
      await expect(verifyCompiledSite({ entry: "index.html", files: [file("index.html", "hi"), file(path, "x")] }), path)
        .rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(verifyCompiledSite({ entry: "index.html", files: [file("index.html", "a"), file("index.html", "b")] }))
      .rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(verifyCompiledSite({ entry: "home.html", files: [file("index.html", "hi")] }))
      .rejects.toMatchObject({ code: "ValidationFailed" });
  });
});
