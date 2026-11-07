import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// No DOM library in the repo: a tiny fake DOM is enough to see what booker.js hands to
// replaceChildren. A literal null there prints the word "null" on the public booking page.
const KEY = `zsb1_${"a".repeat(64)}`;
const source = readFileSync(new URL("../static/booker.js", import.meta.url), "utf8");

type FakeNode = { text?: string; children: unknown[] };

async function renderBooker(slotCount: number): Promise<unknown[][]> {
  const renders: unknown[][] = [];
  const el = (): Record<string, unknown> => ({
    children: [] as unknown[],
    setAttribute() {},
    addEventListener() {},
    append(...nodes: unknown[]) { (this.children as unknown[]).push(...nodes); },
    replaceChildren(...nodes: unknown[]) { renders.push(nodes); },
    querySelector: () => null,
    focus() {},
  });
  const root = el();
  const startsAt = "2026-11-09T17:00:00.000Z";
  const reply = (body: unknown) => Promise.resolve({
    status: 200, headers: { get: () => null }, json: () => Promise.resolve(body),
  });
  const document = {
    getElementById: () => root,
    createElement: () => el(),
    createTextNode: (text: string): FakeNode => ({ text, children: [] }),
    addEventListener() {},
    documentElement: { scrollHeight: 0 },
    visibilityState: "visible",
  };
  const win: Record<string, unknown> = { addEventListener() {} };
  win.parent = win;
  runInNewContext(source, {
    document, window: win, location: { pathname: `/book/${KEY}`, search: "" },
    URLSearchParams, Intl, Date, Promise, String, Object, Array, Map, setInterval: () => 0,
    fetch: (url: string) => reply(url.includes("/slots")
      ? { slots: Array.from({ length: slotCount }, () => ({ startsAt, endsAt: "2026-11-09T17:30:00.000Z" })) }
      : { businessName: "Test Co", title: "Book", description: "About", resources: [{ id: "r1", name: "Call", timeZone: "UTC", slotLengthMinutes: 30 }], disclosure: { version: "v1", text: "x" } }),
  });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return renders;
}

describe("hosted booker render", () => {
  it.each([0, 3])("never passes null to replaceChildren (%i slots, one resource)", async (slotCount) => {
    const renders = await renderBooker(slotCount);
    expect(renders.length).toBeGreaterThan(0);
    for (const nodes of renders) {
      expect(nodes.every((node) => typeof node === "object" && node !== null)).toBe(true);
    }
  });
});
