import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Booking link page (docs/requirements/booking-self-service.md BS-10) in a tiny fake DOM, as booker-render.test.ts does for the
// booker: no literal null may reach replaceChildren, server text goes in as text, and an attempt whose outcome is unknown is
// resent with the same key and the same body.
const TOKEN = `zsm1_${"a".repeat(70)}`;
const source = readFileSync(new URL("../static/manage.js", import.meta.url), "utf8");

interface Fake {
  tag?: string;
  text?: string;
  attrs: Record<string, string>;
  listeners: Record<string, () => void>;
  children: Fake[];
}
type Reply = { status: number; body: unknown; headers?: Record<string, string> } | "offline";
interface Call { method: string; path: string; headers: Record<string, string>; body?: string }

const VIEW = {
  state: "confirmed", businessName: "Test <b>Co</b>", serviceName: "Fitting", startsAt: "2026-11-09T17:00:00.000Z", endsAt: "2026-11-09T18:00:00.000Z",
  timeZone: "UTC", slotLengthMinutes: 60, canChange: true, movedTo: null,
};
const textOf = (node: Fake): string => (node.text ?? "") + node.children.map(textOf).join(" ");
const walk = (node: Fake, found: Fake[] = []): Fake[] => { found.push(node); node.children.forEach((child) => walk(child, found)); return found; };

function page(replies: (call: Call) => Reply) {
  const renders: Fake[][] = [];
  const calls: Call[] = [];
  const element = (tag: string): Fake & Record<string, unknown> => {
    const self: Fake & Record<string, unknown> = {
      tag, attrs: {}, listeners: {}, children: [],
      setAttribute(name: string, value: string) { self.attrs[name] = value; },
      addEventListener(name: string, handler: () => void) { self.listeners[name] = handler; },
      append(...nodes: Fake[]) { self.children.push(...nodes); },
      replaceChildren(...nodes: Fake[]) { renders.push(nodes); },
      querySelector: () => null,
      focus() {},
    };
    return self;
  };
  const root = element("main");
  const document = { getElementById: () => root, createElement: element, createTextNode: (text: string): Fake => ({ text, attrs: {}, listeners: {}, children: [] }) };
  let uuid = 0;
  const fetch = async (path: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
    const call: Call = { method: init.method ?? "GET", path, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) };
    calls.push(call);
    const reply = replies(call);
    if (reply === "offline") throw new Error("offline");
    return { status: reply.status, headers: { get: (name: string) => reply.headers?.[name] ?? null }, json: () => Promise.resolve(reply.body) };
  };
  const history = { replaced: [] as string[], replaceState: (_s: unknown, _t: string, url: string) => { history.replaced.push(url); } };
  const settle = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
  runInNewContext(source, {
    document, location: { pathname: `/manage/${TOKEN}`, search: "" }, history, URLSearchParams, Intl, Date, Promise, String, Object, Array, Map, Number, JSON, Math,
    fetch, crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` },
  });
  const last = () => renders.at(-1)!;
  const click = async (label: string) => {
    const button = last().flatMap((node) => walk(node)).find((node) => node.tag === "button" && textOf(node).trim() === label);
    expect(button, `button ${label}`).toBeDefined();
    button!.listeners.click!();
    await settle();
  };
  return { renders, calls, last, click, settle, history };
}

describe("booking link page", () => {
  it("shows the booking as text and never passes null to replaceChildren", async () => {
    const p = page(() => ({ status: 200, body: VIEW }));
    await p.settle();
    expect(p.calls[0]).toMatchObject({ method: "GET", path: `/public/v1/manage/${TOKEN}` });
    for (const nodes of p.renders) expect(nodes.every((node) => typeof node === "object" && node !== null)).toBe(true);
    const text = p.last().map(textOf).join(" ");
    expect(text).toContain("Test <b>Co</b>");
    expect(p.last().flatMap((node) => walk(node)).some((node) => node.tag === "b")).toBe(false);
  });

  it("shows the time in the booking's zone, named in words", async () => {
    const p = page(() => ({ status: 200, body: { ...VIEW, timeZone: "America/Chicago" } }));
    await p.settle();
    const text = p.last().map(textOf).join(" ");
    // 17:00Z on Nov 9 is 11:00 AM in Chicago, whatever zone the test machine is in.
    expect(text).toContain("11:00 AM");
    expect(text).toContain("Times are in Central Time (Chicago), local time for Test <b>Co</b>.");
    expect(text).not.toContain("America/Chicago");
  });

  it.each([
    [{ ...VIEW, state: "cancelled", canChange: false }, "This appointment is cancelled"],
    [{ ...VIEW, state: "started", canChange: false }, "has started"],
    [{ ...VIEW, state: "moved", canChange: false, movedTo: { startsAt: "2026-11-10T17:00:00.000Z", endsAt: "2026-11-10T18:00:00.000Z", token: `zsm1_${"b".repeat(70)}` } }, "was moved"],
  ])("shows the %# state", async (view, expected) => {
    const p = page(() => ({ status: 200, body: view }));
    await p.settle();
    expect(p.last().map(textOf).join(" ")).toContain(expected);
    expect(p.last().flatMap((node) => walk(node)).some((node) => node.tag === "button")).toBe(false);
    const link = p.last().flatMap((node) => walk(node)).find((node) => node.tag === "a");
    if (view.state === "moved") expect(link!.attrs.href).toBe(`/manage/zsm1_${"b".repeat(70)}`);
  });

  it("says plainly when the link expired or is not there", async () => {
    const expired = page(() => ({ status: 409, body: { error: { code: "Conflict", details: { reason: "link_expired" } } } }));
    await expired.settle();
    expect(expired.last().map(textOf).join(" ")).toContain("This link has expired");
    const missing = page(() => ({ status: 404, body: { error: { code: "NotFound" } } }));
    await missing.settle();
    expect(missing.last().map(textOf).join(" ")).toContain("This link is not available");
  });

  it("offers a retry, not a dead link, when the first load fails or the service is busy", async () => {
    let attempts = 0;
    const flaky = page(() => {
      attempts += 1;
      if (attempts === 1) return "offline";
      if (attempts === 2) return { status: 503, body: null };
      if (attempts === 3) return { status: 429, body: { error: { code: "RateLimited" } }, headers: { "retry-after": "60" } };
      return { status: 200, body: VIEW };
    });
    await flaky.settle();
    expect(flaky.last().map(textOf).join(" ")).not.toContain("This link is not available");
    expect(flaky.last().map(textOf).join(" ")).toContain("could not reach");
    await flaky.click("Try again");
    expect(flaky.last().map(textOf).join(" ")).not.toContain("This link is not available");
    expect(flaky.last().map(textOf).join(" ")).toContain("did not answer");
    await flaky.click("Try again");
    expect(flaky.last().map(textOf).join(" ")).toContain("Too many requests");
    await flaky.click("Try again");
    expect(flaky.last().map(textOf).join(" ")).toContain("Cancel appointment");
  });

  it("cancels after a second step, sending one key and an empty body", async () => {
    const p = page((call) => call.method === "POST" ? { status: 200, body: { ...VIEW, state: "cancelled", canChange: false } } : { status: 200, body: VIEW });
    await p.settle();
    await p.click("Cancel appointment");
    expect(p.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    await p.click("Yes, cancel it");
    const post = p.calls.find((call) => call.method === "POST")!;
    expect(post.path).toBe(`/public/v1/manage/${TOKEN}/cancel`);
    expect(post.body).toBe("{}");
    expect(post.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.last().map(textOf).join(" ")).toContain("This appointment is cancelled");
  });

  it("resends the same key and body after an answer it could not read", async () => {
    let posts = 0;
    const p = page((call) => {
      if (call.method === "GET") return { status: 200, body: VIEW };
      posts += 1;
      return posts === 1 ? "offline" : { status: 200, body: { ...VIEW, state: "cancelled", canChange: false } };
    });
    await p.settle();
    await p.click("Cancel appointment");
    await p.click("Yes, cancel it");
    expect(p.last().map(textOf).join(" ")).toContain("We could not confirm your cancellation");
    await p.click("Try again");
    const sent = p.calls.filter((call) => call.method === "POST");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.headers["Idempotency-Key"]).toBe(sent[0]!.headers["Idempotency-Key"]);
    expect(sent[1]!.body).toBe(sent[0]!.body);
    expect(p.last().map(textOf).join(" ")).toContain("This appointment is cancelled");
  });

  it("moves to another time: day, time, confirm, and follows the new link", async () => {
    const startsAt = "2026-11-10T09:00:00.000Z";
    const newToken = `zsm1_${"c".repeat(70)}`;
    const p = page((call) => {
      if (call.path.includes("/slots")) return { status: 200, body: { slots: [{ startsAt, endsAt: "2026-11-10T10:00:00.000Z" }] } };
      if (call.method === "POST") return { status: 200, body: { view: { ...VIEW, startsAt, endsAt: "2026-11-10T10:00:00.000Z" }, token: newToken } };
      return { status: 200, body: VIEW };
    });
    await p.settle();
    await p.click("Pick another time");
    const buttons = () => p.last().flatMap((node) => walk(node)).filter((node) => node.tag === "button");
    buttons().find((node) => textOf(node).includes("1 time"))!.listeners.click!();
    await p.settle();
    buttons().find((node) => !/Back/.test(textOf(node)))!.listeners.click!();
    await p.settle();
    await p.click("Move my appointment");
    const post = p.calls.find((call) => call.method === "POST")!;
    expect(post.path).toBe(`/public/v1/manage/${TOKEN}/reschedule`);
    expect(JSON.parse(post.body!)).toEqual({ startsAt });
    expect(p.history.replaced).toEqual([`/manage/${newToken}`]);
    expect(p.last().map(textOf).join(" ")).toContain("Your appointment is moved");
  });

  it("goes back to the days with a plain message when the time was lost", async () => {
    const startsAt = "2026-11-10T09:00:00.000Z";
    const p = page((call) => {
      if (call.path.includes("/slots")) return { status: 200, body: { slots: [{ startsAt, endsAt: "2026-11-10T10:00:00.000Z" }] } };
      if (call.method === "POST") return { status: 409, body: { error: { code: "Conflict", details: { reason: "slot_unavailable" } } } };
      return { status: 200, body: VIEW };
    });
    await p.settle();
    await p.click("Pick another time");
    const buttons = () => p.last().flatMap((node) => walk(node)).filter((node) => node.tag === "button");
    buttons().find((node) => textOf(node).includes("1 time"))!.listeners.click!();
    await p.settle();
    // The only choice on the time step that is not a back link is the slot.
    buttons().find((node) => !/Back/.test(textOf(node)))!.listeners.click!();
    await p.settle();
    await p.click("Move my appointment");
    expect(p.last().map(textOf).join(" ")).toContain("That time was just taken");
    // The attempt is over: a new one would get a new key.
    expect(p.history.replaced).toEqual([]);
  });
});
