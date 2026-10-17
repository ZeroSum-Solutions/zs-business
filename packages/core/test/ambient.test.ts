import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";

function ambientAccess(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const patterns = [
    /\bnew\s+Date\s*(?:\(\s*\)|(?=$|[;\n]))/,
    /\bDate\s*\.\s*now\b/,
    /\bDate\s*\[\s*['"]now['"]\s*\]/,
    /\{[^}]*\bnow\b[^}]*\}\s*=\s*Date\b/,
    /\bprocess\b/,
    /\bperformance\b/,
    /\brandomUUID\b/,
  ];
  const violations = patterns.filter((pattern) => pattern.test(code)).map((pattern) => pattern.source);
  // Date() is an ambient string-producing clock even when passed arguments.
  if (/\bDate\s*\(/.test(code.replace(/\bnew\s+Date\b/g, "InjectedDate"))) violations.push("Date() call");
  return violations;
}

it.each([
  "Date.now()", "new Date()", "Date()", "Date('2026-10-17')", "performance.now()",
  "process.env", "const { env } = process", "import runtime from 'node:process'; runtime.env",
  "import { env } from 'process'", "crypto.randomUUID()", "crypto['randomUUID']()",
  "import { randomUUID as mint } from 'node:crypto'; mint()", "Date['now']()",
  "const { now: clock } = Date; clock()",
])("detects ambient state in source: %s", (source) => {
  expect(ambientAccess(source).length).toBeGreaterThan(0);
});

it("allows injected dates and ignores comments", () => {
  expect(ambientAccess("const now = new Date(clock.now().getTime()); // process.env\n")).toEqual([]);
});

it("keeps ambient clocks, randomness and environment out of all core source", async () => {
  const violations: string[] = [];
  async function visitDirectory(path: string): Promise<void> {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const file = join(path, item.name);
      if (item.isDirectory()) await visitDirectory(file);
      else if (/\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/.test(file)) {
        const source = await readFile(file, "utf8");
        violations.push(...ambientAccess(source).map((item) => file + ": " + item));
      }
    }
  }
  await visitDirectory(fileURLToPath(new URL("../src", import.meta.url)));
  expect(violations).toEqual([]);
});
