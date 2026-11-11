import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// No DOM library in the repo: a tiny fake DOM is enough to see what booker.js hands to
// replaceChildren. A literal null there prints the word "null" on the public booking page.
const KEY = `zsb1_${"a".repeat(64)}`;
const source = readFileSync(new URL("../static/booker.js", import.meta.url), "utf8");

type FakeNode = { text?: string; children: unknown[] };

interface Options { resourceZone?: string; visitorZone?: string; startsAt?: string; search?: string; root?: RootRecord }

/** What booker.js set on <html>: custom properties through the CSSOM, and attributes. */
interface RootRecord { props: Record<string, string>; attrs: Record<string, string> }

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
    documentElement: {
      scrollHeight: 0,
      style: { setProperty(name: string, value: string) { if (options.root) options.root.props[name] = value; } },
      setAttribute(name: string, value: string) { if (options.root) options.root.attrs[name] = value; },
    },
    visibilityState: "visible",
  };
  const win: Record<string, unknown> = { addEventListener() {} };
  win.parent = win;
  runInNewContext(source, {
    document, window: win, location: { pathname: `/book/${KEY}`, search: options.search ?? "" },
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
    // The day buttons show counts, not times, so the day step names the zone only.
    expect(text).toContain("Times are in Central Time (Chicago), local time for Test Co.");
    expect(text).not.toContain("shown under each one");
    expect(text).not.toContain("America/");
  });

  it("names the zone without the visitor note when both zones agree", async () => {
    const renders = await renderBooker(1, { resourceZone: "America/Los_Angeles", visitorZone: "America/Los_Angeles" });
    const text = textOf(renders.at(-1)!);
    expect(text).toContain("Times are in Pacific Time (Los Angeles), local time for Test Co.");
    expect(text).not.toContain("your time");
  });

  it("names a fixed-offset zone by its real offset (Etc/GMT+8 is eight hours behind UTC)", async () => {
    const renders = await renderBooker(1, { resourceZone: "Etc/GMT+8", visitorZone: "Etc/GMT+8" });
    const text = textOf(renders.at(-1)!);
    expect(text).toContain("Times are in GMT-08:00, local time for Test Co.");
    expect(text).not.toContain("GMT+8");
  });
});

describe("booker theme (public-intake.md P-16)", () => {
  const themed = async (search: string) => {
    const root: RootRecord = { props: {}, attrs: {} };
    await renderBooker(1, { search, root });
    return root;
  };

  it("sets nothing when the page passes no theme, so the default look is unchanged", async () => {
    expect(await themed("?embed=1&channel=widget")).toEqual({ props: {}, attrs: {} });
  });

  it.each([
    ["bg", "#000", "--zs-bg"],
    ["surface", "#111113", "--zs-surface"],
    ["text", "#ffffff", "--zs-ink"],
    ["muted", "rgb(138 138 147)", "--zs-muted"],
    ["accent", "#5b4cff", "--zs-accent"],
    ["accent-text", "white", "--zs-accent-ink"],
    ["border", "hsl(240 7% 18%)", "--zs-line"],
    ["link", "#a99fffcc", "--zs-link"],
    ["error", "#ff6b5e", "--zs-danger"],
    ["radius", "12px", "--zs-radius"],
    ["font", `Geist, -apple-system, "Segoe UI", sans-serif`, "--zs-font"],
  ])("applies %s=%s as %s", async (name, value, cssVar) => {
    const root = await themed(`?${new URLSearchParams({ [name]: value })}`);
    expect(root.props[cssVar]).toBe(value);
  });

  it("themes form fields, checkboxes and the colour scheme only from validated values", async () => {
    const root = await themed("?bg=%23111113&surface=%23000&text=%23fff&accent=%235b4cff");
    expect(root.props).toMatchObject({ "--zs-field-bg": "#000", "--zs-field-ink": "#fff", "--zs-check": "#5b4cff", "color-scheme": "dark" });
    expect((await themed("?bg=%23ffffff")).props["color-scheme"]).toBeUndefined();
  });

  it.each([
    ["bg", "red;}body{background:url(https://evil.test/x)}"],
    ["accent", "url(https://evil.test/x)"],
    ["text", "expression(alert(1))"],
    ["border", "var(--zs-ink)"],
    ["muted", "#12345"],
    ["surface", "rgb(1,2,3);color:red"],
    ["radius", "9999px"],
    ["radius", "calc(100vh)"],
    ["font", `x";}*{color:red}`],
    ["font", "Geist, url(https://evil.test/font.woff)"],
    ["font", `"</style><script>alert(1)</script>"`],
    ["link", "a".repeat(201)],
  ])("drops a hostile %s value", async (name, value) => {
    const root = await themed(`?${new URLSearchParams({ [name]: value })}`);
    expect(root.props).toEqual({});
  });

  it("keeps the good values when one is hostile", async () => {
    const root = await themed(`?${new URLSearchParams({ accent: "#5b4cff", bg: "red}" })}`);
    expect(root.props).toEqual({ "--zs-accent": "#5b4cff", "--zs-check": "#5b4cff" });
  });

  it("hides the header visually only when asked", async () => {
    expect((await themed("?header=0")).attrs).toEqual({ "data-header": "hidden" });
    expect((await themed("?header=1")).attrs).toEqual({});
  });
});

describe("booker contrast (public-intake.md P-16)", () => {
  const css = readFileSync(new URL("../static/booker.css", import.meta.url), "utf8");
  const token = (name: string) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i").exec(css)?.[1] ?? "";
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => {
      const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  type Tokens = Record<"text" | "muted" | "bg" | "surface" | "link" | "error" | "accent" | "accentText", string>;
  const pairs = (t: Tokens) => [
    [t.text, t.bg], [t.text, t.surface], [t.muted, t.bg], [t.muted, t.surface],
    [t.link, t.bg], [t.error, t.bg], [t.accentText, t.accent],
  ] as const;

  it("every default text colour reaches 4.5:1", () => {
    const defaults = {
      text: token("--zs-ink"), muted: token("--zs-muted"), bg: token("--zs-bg"), surface: token("--zs-surface"),
      link: token("--zs-accent"), error: token("--zs-danger"), accent: token("--zs-accent"), accentText: token("--zs-accent-ink"),
    };
    expect(Object.values(defaults).every((hex) => /^#[0-9a-f]{6}$/i.test(hex))).toBe(true);
    for (const [fg, bg] of pairs(defaults)) expect(ratio(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it("the documented dark example reaches 4.5:1", () => {
    const dark = { text: "#ffffff", muted: "#8a8a93", bg: "#111113", surface: "#000000", link: "#a99fff", error: "#ff6b5e", accent: "#5b4cff", accentText: "#ffffff" };
    for (const [fg, bg] of pairs(dark)) expect(ratio(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
});

describe("embed.js theme forwarding (public-intake.md P-16)", () => {
  const embedSource = readFileSync(new URL("../static/embed.js", import.meta.url), "utf8");

  function mountWith(vars: Record<string, string>, attrs: Record<string, string> = {}): string {
    let src = "";
    const element = {
      getAttribute: (name: string) => ({ "data-zs-booking": KEY, ...attrs })[name] ?? null,
      setAttribute() {},
      replaceChildren() {},
    };
    const frame = { style: {} as Record<string, string>, set src(value: string) { src = value; }, title: "" };
    runInNewContext(embedSource, {
      document: { currentScript: { src: "https://book.example.test/embed.js" }, readyState: "complete", createElement: () => frame, querySelectorAll: () => [element] },
      window: { addEventListener() {} },
      getComputedStyle: () => ({ getPropertyValue: (name: string) => vars[name] ?? "" }),
      URL, URLSearchParams, Set,
    });
    return src;
  }

  it("builds today's URL when the host sets no property", () => {
    expect(mountWith({})).toBe(`https://book.example.test/book/${KEY}?embed=1&channel=widget`);
  });

  it("forwards each --zs-booking-* property and the header switch", () => {
    const url = new URL(mountWith({ "--zs-booking-bg": " #111113", "--zs-booking-font": `Geist, "Segoe UI"`, "--zs-booking-accent-text": "#fff" }, { "data-zs-header": "hidden" }));
    expect(Object.fromEntries(url.searchParams)).toEqual({ embed: "1", channel: "widget", bg: "#111113", font: `Geist, "Segoe UI"`, "accent-text": "#fff", header: "0" });
  });

  it("encodes a hostile value so it stays one parameter, and drops an oversized one", () => {
    const url = new URL(mountWith({ "--zs-booking-bg": "red&embed=0#x", "--zs-booking-text": "a".repeat(201) }));
    expect(url.searchParams.get("embed")).toBe("1");
    expect(url.searchParams.get("bg")).toBe("red&embed=0#x");
    expect(url.searchParams.has("text")).toBe(false);
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
