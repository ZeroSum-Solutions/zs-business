import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// No DOM library in the repo: a tiny fake DOM is enough to see what booker.js hands to
// replaceChildren. A literal null there prints the word "null" on the public booking page.
const KEY = `zsb1_${"a".repeat(64)}`;
const source = readFileSync(new URL("../static/booker.js", import.meta.url), "utf8");

type FakeNode = { text?: string; children: unknown[] };

interface Options { resourceZone?: string; visitorZone?: string; startsAt?: string; search?: string; root?: RootRecord; embedded?: boolean }

interface Rgba { r: number; g: number; b: number; a: number }
const NAMED: Record<string, Rgba> = { white: { r: 255, g: 255, b: 255, a: 1 }, black: { r: 0, g: 0, b: 0, a: 1 }, red: { r: 255, g: 0, b: 0, a: 1 }, transparent: { r: 0, g: 0, b: 0, a: 0 } };

/** What Chromium's colour parser accepts for the forms the tests use; null where it rejects. */
function parseColour(value: string): Rgba | null {
  const v = value.trim().toLowerCase();
  if (NAMED[v]) return NAMED[v]!;
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (hex) {
    const d = hex[1]!.length <= 4 ? hex[1]!.replace(/./g, "$&$&") : hex[1]!;
    const n = (at: number) => Number.parseInt(d.slice(at, at + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: d.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^rgba?\((.*)\)$/.exec(v);
  if (!fn) return null;
  const body = fn[1]!.trim();
  const comma = /^(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d*\.?\d+))?$/.exec(body);
  const space = /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)(?:\s*\/\s*(\d*\.?\d+))?$/.exec(body);
  const m = comma ?? space;
  if (!m) return null;
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
}

/** CSS and getComputedStyle as the booker uses them to resolve a probe element's colour. */
const fakeCss = { supports: (property: string, value: string) => property === "color" ? parseColour(value) !== null : !/[;{}]/.test(value) };
const fakeComputedStyle = (node: { style?: { color?: string } }) => {
  const c = parseColour(node.style?.color ?? "") ?? { r: 0, g: 0, b: 0, a: 1 };
  return { color: c.a < 1 ? `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})` : `rgb(${c.r}, ${c.g}, ${c.b})` };
};

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
    remove() {},
    style: {} as Record<string, string>,
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
    body: { append() {}, getBoundingClientRect: () => ({ height: 0 }) },
  };
  const win: Record<string, unknown> = { addEventListener() {} };
  win.parent = options.embedded ? { postMessage() {} } : win;
  runInNewContext(source, {
    document, window: win, location: { pathname: `/book/${KEY}`, search: options.search ?? "" },
    URLSearchParams, CSS: fakeCss, getComputedStyle: fakeComputedStyle, Intl: intlIn(options.visitorZone ?? "UTC"), Date, Promise, String, Object, Array, Map, setInterval: () => 0,
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
  const themed = async (search: string, embedded = false) => {
    const root: RootRecord = { props: {}, attrs: {} };
    await renderBooker(1, { search, root, embedded });
    return root;
  };
  const q = (params: Record<string, string>) => `?${new URLSearchParams(params)}`;

  const DEFAULTS: Record<string, string> = {
    "--zs-bg": "#ffffff", "--zs-surface": "#ffffff", "--zs-ink": "#1d232a", "--zs-muted": "#5b6672",
    "--zs-accent": "#24577a", "--zs-accent-ink": "#ffffff", "--zs-danger": "#a3271f",
  };
  const lum = ({ r, g, b }: Rgba) => {
    const [lr, lg, lb] = [r, g, b].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
  };
  const ratio = (a: Rgba, b: Rgba) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };

  /** Every text colour the theme leaves in force, against everything it sits on: all opaque, all 4.5:1. */
  function expectReadable(props: Record<string, string>) {
    const value = (name: string) => props[name] ?? DEFAULTS[name] ?? props["--zs-accent"] ?? DEFAULTS["--zs-accent"]!;
    const colour = (name: string) => {
      const c = parseColour(value(name));
      expect(c, `${name}=${value(name)}`).not.toBeNull();
      expect(c!.a, `${name} is opaque`).toBe(1);
      return c!;
    };
    const bg = colour("--zs-bg");
    const surface = colour("--zs-surface");
    const accent = colour("--zs-accent");
    const selected = { r: accent.r * 0.08 + surface.r * 0.92, g: accent.g * 0.08 + surface.g * 0.92, b: accent.b * 0.08 + surface.b * 0.92, a: 1 };
    for (const fg of ["--zs-ink", "--zs-muted", "--zs-danger", "--zs-link"]) {
      for (const ground of [bg, surface, selected]) expect(ratio(colour(fg), ground), `${fg} ${value(fg)}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(colour("--zs-accent-ink"), accent)).toBeGreaterThanOrEqual(4.5);
    if (props["--zs-field-bg"]) expect(ratio(parseColour(props["--zs-field-ink"]!)!, parseColour(props["--zs-field-bg"]!)!)).toBeGreaterThanOrEqual(4.5);
  }

  it("sets nothing when the page passes no theme, so the default look is unchanged", async () => {
    expect(await themed("?embed=1&channel=widget")).toEqual({ props: {}, attrs: {} });
  });

  it.each([
    ["text", "#333333", "--zs-ink"],
    ["muted", "rgb(80, 80, 80)", "--zs-muted"],
    ["accent", "#5b4cff", "--zs-accent"],
    ["accent-text", "white", "--zs-accent-ink"],
    ["border", "rgb(42 42 48)", "--zs-line"],
    ["link", "#1a1a1a", "--zs-link"],
    ["error", "#8b0000", "--zs-danger"],
    ["radius", "12px", "--zs-radius"],
    ["font", `Geist, -apple-system, "Segoe UI", sans-serif`, "--zs-font"],
    ["font", `"caption"`, "--zs-font"],
  ])("applies %s=%s as %s", async (name, value, cssVar) => {
    const root = await themed(q({ [name]: value }));
    expect(root.props[cssVar]).toBe(value);
    expectReadable(root.props);
  });

  it("applies a full dark theme as given, with dark fields and colour scheme", async () => {
    const dark = { bg: "#111113", surface: "#000000", text: "#ffffff", muted: "#8a8a93", accent: "#5b4cff", "accent-text": "#ffffff", border: "#2a2a30", link: "#a99fff", error: "#ff6b5e" };
    const root = await themed(q(dark));
    expect(root.props).toMatchObject({
      "--zs-bg": "#111113", "--zs-surface": "#000000", "--zs-ink": "#ffffff", "--zs-muted": "#8a8a93", "--zs-accent": "#5b4cff",
      "--zs-line": "#2a2a30", "--zs-link": "#a99fff", "--zs-danger": "#ff6b5e",
      "--zs-field-bg": "#000000", "--zs-field-ink": "#ffffff", "--zs-check": "#5b4cff", "color-scheme": "dark",
    });
    expectReadable(root.props);
  });

  it.each(["transparent", "inherit", "initial", "unset", "revert", "currentcolor", "none", "notacolour", "banana", "rgb(1)", "rgb(1,2,3,)", "#ffffff00", "#0000", "rgba(0,0,0,0.5)"])(
    "never applies the colour %s to any token", async (value) => {
      for (const name of ["bg", "surface", "text", "muted", "accent", "accent-text", "border", "link", "error"]) {
        const root = await themed(q({ [name]: value }));
        expect(root.props, `${name}=${value}`).toEqual({});
      }
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
    ["font", "inherit"],
    ["font", "caption"],
    ["font", "Geist, revert"],
    ["link", "a".repeat(201)],
  ])("drops a hostile %s value", async (name, value) => {
    expect((await themed(q({ [name]: value }))).props).toEqual({});
  });

  it("keeps the good values when one is hostile", async () => {
    const root = await themed(q({ accent: "#5b4cff", bg: "red}" }));
    expect(root.props).toEqual({ "--zs-accent": "#5b4cff", "--zs-check": "#5b4cff" });
  });

  it.each([
    ["bg=#000 alone", { bg: "#000" }],
    ["surface=#000000 alone", { surface: "#000000" }],
    ["all tokens white", Object.fromEntries(["bg", "surface", "text", "muted", "accent", "accent-text", "border", "link", "error"].map((n) => [n, "#ffffff"]))],
    ["all tokens black", Object.fromEntries(["bg", "surface", "text", "muted", "accent", "accent-text", "border", "link", "error"].map((n) => [n, "#000000"]))],
    ["muted white on white", { muted: "#ffffff" }],
    ["text white on white", { text: "#ffffff" }],
    ["dark page, white buttons", { bg: "#000000", surface: "#ffffff" }],
    ["mid-grey page", { bg: "#767676" }],
    ["accent text unreadable", { accent: "#ffff00", "accent-text": "#ffffff" }],
    ["dark accent as link on dark page", { bg: "#111113", accent: "#5b4cff" }],
  ])("keeps every text readable: %s", async (_label, params) => {
    expectReadable((await themed(q(params as Record<string, string>))).props);
  });

  it("derives readable ink for a dark page set alone", async () => {
    const root = await themed(q({ bg: "#000" }));
    expect(root.props).toMatchObject({ "--zs-bg": "#000", "--zs-surface": "#000", "--zs-ink": "#ffffff", "color-scheme": "dark" });
    const surfaceOnly = await themed(q({ surface: "#000000" }));
    expect(surfaceOnly.props).toMatchObject({ "--zs-bg": "#000000", "--zs-surface": "#000000", "--zs-ink": "#ffffff" });
  });

  it("drops an unreadable text token and keeps the default", async () => {
    expect((await themed(q({ muted: "#ffffff" }))).props).toEqual({});
    expect((await themed(q({ text: "#ffffff" }))).props).toEqual({});
  });

  it("hides the header visually only inside a frame", async () => {
    expect((await themed("?embed=1&header=0", true)).attrs).toEqual({ "data-header": "hidden" });
    expect((await themed("?embed=1&header=1", true)).attrs).toEqual({});
    expect((await themed("?header=0")).attrs).toEqual({});
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
      contains: () => true,
    };
    const frame = { style: {} as Record<string, string>, set src(value: string) { src = value; }, title: "", isConnected: true };
    runInNewContext(embedSource, {
      document: { currentScript: { src: "https://book.example.test/embed.js" }, readyState: "complete", createElement: () => frame, querySelectorAll: () => [element] },
      window: { addEventListener() {} },
      getComputedStyle: () => ({ getPropertyValue: (name: string) => vars[name] ?? "" }),
      URL, URLSearchParams, Set, Map, WeakMap,
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

describe("embed.js mounting (public-intake.md P-14, P-16)", () => {
  const embedSource = readFileSync(new URL("../static/embed.js", import.meta.url), "utf8");
  const ORIGIN = "https://book.example.test";
  const OTHER_KEY = `zsb1_${"Z".repeat(64)}`;

  interface FakeFrame { src: string; title: string; style: Record<string, string>; contentWindow: object; parent: FakeElement | null; readonly isConnected: boolean }
  interface FakeElement { attrs: Record<string, string>; children: FakeFrame[]; attached: boolean }

  /** A host page with a few [data-zs-booking] elements, a MutationObserver and postMessage. */
  function host(...elements: Array<Record<string, string>>) {
    const nodes: FakeElement[] = elements.map((attrs) => ({ attrs: { ...attrs }, children: [], attached: true }));
    let observer: (() => void) | null = null;
    let onMessage: ((event: { origin: string; source: unknown; data: unknown }) => void) | null = null;
    const api = (node: FakeElement) => ({
      getAttribute: (name: string) => node.attrs[name] ?? null,
      setAttribute: (name: string, value: string) => { node.attrs[name] = value; },
      contains: (frame: FakeFrame) => node.children.includes(frame),
      replaceChildren: (frame: FakeFrame) => { for (const old of node.children) old.parent = null; frame.parent = node; node.children = [frame]; },
    });
    const handles = new Map(nodes.map((node) => [node, api(node)]));
    const window: Record<string, unknown> = {
      addEventListener: (type: string, fn: typeof onMessage) => { if (type === "message") onMessage = fn; },
    };
    runInNewContext(embedSource, {
      window,
      document: {
        currentScript: { src: `${ORIGIN}/embed.js` }, readyState: "complete", body: {},
        createElement: (): FakeFrame => ({
          src: "", title: "", style: {}, contentWindow: {}, parent: null,
          get isConnected() { return this.parent !== null && this.parent.attached; },
        }),
        querySelectorAll: () => nodes.filter((node) => node.attached && "data-zs-booking" in node.attrs).map((node) => handles.get(node)),
      },
      MutationObserver: class { constructor(fn: () => void) { observer = fn; } observe() {} },
      getComputedStyle: () => ({ getPropertyValue: () => "" }),
      URL, URLSearchParams, Map, WeakMap, Number, Math,
    });
    return {
      nodes,
      mutate: () => observer?.(),
      post: (origin: string, frame: FakeFrame | undefined, height: number) => onMessage?.({ origin, source: frame?.contentWindow, data: { type: "zs-booking:height", height } }),
    };
  }

  it("keeps the 480 px floor unless the host opts into a smaller one", () => {
    const page = host({ "data-zs-booking": KEY }, { "data-zs-booking": KEY, "data-zs-min-height": "200" }, { "data-zs-booking": KEY, "data-zs-min-height": "9000" }, { "data-zs-booking": KEY, "data-zs-min-height": "1" });
    expect(page.nodes.map((node) => node.children[0]?.style.minHeight)).toEqual(["480px", "200px", "480px", "160px"]);
    // A height report sets the height and leaves the floor in place.
    const frame = page.nodes[0]!.children[0]!;
    page.post(ORIGIN, frame, 300);
    expect(frame.style).toMatchObject({ height: "300px", minHeight: "480px" });
  });

  it("ignores height messages from another origin or another window, and clamps the height", () => {
    const page = host({ "data-zs-booking": KEY });
    const frame = page.nodes[0]!.children[0]!;
    page.post("https://evil.test", frame, 900);
    page.post(ORIGIN, undefined, 900);
    expect(frame.style.height).toBeUndefined();
    page.post(ORIGIN, frame, 99999);
    expect(frame.style.height).toBe("4000px");
  });

  it("mounts again after the host replaces the element's children", () => {
    const page = host({ "data-zs-booking": KEY });
    const node = page.nodes[0]!;
    const first = node.children[0]!;
    node.children = []; first.parent = null; // host: element.replaceChildren()
    page.mutate();
    expect(node.children).toHaveLength(1);
    expect(node.children[0]).not.toBe(first);
    expect(node.children[0]!.src).toContain(`/book/${KEY}?`);
    // The old frame is forgotten: its messages no longer resize anything.
    page.post(ORIGIN, first, 900);
    expect(first.style.height).toBeUndefined();
  });

  it("does not mount twice when nothing changed", () => {
    const page = host({ "data-zs-booking": KEY });
    const frame = page.nodes[0]!.children[0];
    page.mutate();
    page.mutate();
    expect(page.nodes[0]!.children[0]).toBe(frame);
  });

  it("mounts an element whose data-zs-booking attribute arrives later", () => {
    const page = host({ id: "late" });
    expect(page.nodes[0]!.children).toHaveLength(0);
    page.nodes[0]!.attrs["data-zs-booking"] = KEY;
    page.mutate();
    expect(page.nodes[0]!.children[0]!.src).toContain(`/book/${KEY}?`);
  });

  it("keeps the first key when the attribute of a mounted element is rewritten", () => {
    const page = host({ "data-zs-booking": KEY });
    const node = page.nodes[0]!;
    node.attrs["data-zs-booking"] = OTHER_KEY;
    page.mutate();
    expect(node.children[0]!.src).toContain(`/book/${KEY}?`);
    node.children[0]!.parent = null; node.children = [];
    page.mutate();
    expect(node.children[0]!.src).toContain(`/book/${KEY}?`);
  });

  it("ignores an invalid key", () => {
    const page = host({ "data-zs-booking": "zsb1_short" }, { "data-zs-booking": `${KEY}"><script>` });
    expect(page.nodes.every((node) => node.children.length === 0)).toBe(true);
  });
});
