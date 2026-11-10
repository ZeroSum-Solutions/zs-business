import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// No DOM library in the repo: a tiny fake DOM is enough to see what booker.js hands to
// replaceChildren. A literal null there prints the word "null" on the public booking page.
const KEY = `zsb1_${"a".repeat(64)}`;
const source = readFileSync(new URL("../static/booker.js", import.meta.url), "utf8");

type FakeNode = { text?: string; children: unknown[] };

interface Options { resourceZone?: string; visitorZone?: string; startsAt?: string }

/** Intl whose default zone is the given one, as a visitor's browser would report it. */
function intlIn(zone: string): typeof Intl {
  const Base = Intl.DateTimeFormat;
  const DateTimeFormat = function (locale?: string | string[], options?: Intl.DateTimeFormatOptions) {
    return new Base(locale, { timeZone: zone, ...options });
  } as unknown as typeof Intl.DateTimeFormat;
  return { ...Intl, DateTimeFormat } as typeof Intl;
}

async function renderBooker(slotCount: number, options: Options = {}): Promise<unknown[][]> {
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
  const startsAt = options.startsAt ?? "2026-11-09T17:00:00.000Z";
  const endsAt = new Date(Date.parse(startsAt) + 1_800_000).toISOString();
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
    URLSearchParams, Intl: intlIn(options.visitorZone ?? "UTC"), Date, Promise, String, Object, Array, Map, setInterval: () => 0,
    fetch: (url: string) => reply(url.includes("/slots")
      ? { slots: Array.from({ length: slotCount }, () => ({ startsAt, endsAt })) }
      : { businessName: "Test Co", title: "Book", description: "About", resources: [{ id: "r1", name: "Call", timeZone: options.resourceZone ?? "UTC", slotLengthMinutes: 30 }], disclosure: { version: "v1", text: "x" } }),
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

  it("labels days and the zone in the business's zone, not the visitor's", async () => {
    // 07:00Z on Nov 11 is 1:00 AM Wednesday in Chicago but 11:00 PM Tuesday in Los Angeles.
    const renders = await renderBooker(1, { resourceZone: "America/Chicago", visitorZone: "America/Los_Angeles", startsAt: "2026-11-11T07:00:00.000Z" });
    const text = textOf(renders.at(-1)!);
    expect(text).toContain("Wed, Nov 11");
    expect(text).not.toContain("Tue, Nov 10");
    expect(text).toContain("Times are in Central Time (Chicago), local time for Test Co. Your time is shown under each one.");
    expect(text).not.toContain("America/");
  });

  it("names the zone without the visitor note when both zones agree", async () => {
    const renders = await renderBooker(1, { resourceZone: "America/Los_Angeles", visitorZone: "America/Los_Angeles" });
    const text = textOf(renders.at(-1)!);
    expect(text).toContain("Times are in Pacific Time (Los Angeles), local time for Test Co.");
    expect(text).not.toContain("your time");
  });
});

function textOf(nodes: unknown[]): string {
  const parts: string[] = [];
  const walk = (node: unknown) => {
    const item = node as FakeNode;
    if (typeof item?.text === "string") parts.push(item.text);
    for (const child of item?.children ?? []) walk(child);
  };
  for (const node of nodes) walk(node);
  return parts.join(" ");
}
