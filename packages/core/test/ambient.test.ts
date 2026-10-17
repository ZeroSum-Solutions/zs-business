import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";

it("keeps ambient clocks and environment access out of all core source", async () => {
  const violations: string[] = [];
  async function visitDirectory(path: string): Promise<void> {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const file = join(path, item.name);
      if (item.isDirectory()) await visitDirectory(file);
      else if (file.endsWith(".ts")) {
        const source = await readFile(file, "utf8");
        for (const pattern of [
          /\bDate\s*\.\s*now\b/,
          /\bnew\s+Date\s*\(\s*\)/,
          /\bprocess\s*\.\s*env\b/,
          /\bDate\s*\[\s*['"]now['"]\s*\]/,
          /\bprocess\s*\[\s*['"]env['"]\s*\]/,
        ]) {
          if (pattern.test(source))
            violations.push(file + ": " + pattern.source);
        }
      }
    }
  }
  await visitDirectory(fileURLToPath(new URL("../src", import.meta.url)));
  expect(violations).toEqual([]);
});
