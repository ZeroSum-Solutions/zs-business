// The theme's colour names must not change what a Tailwind utility means. `inset` was a colour,
// so `ring-inset` also set the ring colour to it and, sorted last, painted over every
// `ring-border-strong`: the off switch lost its edge in dark mode (U3 A-8) and the selected
// segment its outline (U3 A-9).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

const app = fileURLToPath(new URL("../src/app/", import.meta.url));
const require = createRequire(import.meta.url);

async function build(classes: string[]): Promise<string> {
  const compiler = await compile(readFileSync(`${app}globals.css`, "utf8"), {
    base: app,
    loadStylesheet: async (id: string, base: string) => {
      const path = id === "tailwindcss" ? require.resolve("tailwindcss/index.css") : resolve(base, id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  return compiler.build(classes);
}

/** Every declaration block for `.name` in the built CSS. */
const rules = (css: string, name: string) =>
  [...css.matchAll(new RegExp(`\\.${name.replace(/[:[\]]/g, "\\\\$&")} \\{([^}]*)\\}`, "g"))].map((match) => match[1]!);

describe("Tailwind utilities", () => {
  it("ring-inset only moves the ring inside; the ring keeps its own colour", async () => {
    const css = await build(["ring-inset", "ring-border-strong", "bg-inset"]);
    expect(rules(css, "ring-inset").join("")).toContain("--tw-ring-inset: inset");
    expect(rules(css, "ring-inset").join("")).not.toContain("--tw-ring-color");
    // The recessed-panel fill still works.
    expect(rules(css, "bg-inset").join("")).toContain("background-color: var(--inset)");
  });
});
