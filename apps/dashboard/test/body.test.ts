import { describe, expect, it } from "vitest";
import { readBoundedBody } from "../src/lib/server/body";
import { chunkedBody, chunks, manualTimer, settle } from "./helpers/streams";

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("http://dashboard.test/api/x", { method: "POST", body, headers, duplex: "half" } as RequestInit);
const LIMIT = 1024;

describe("bounded body reader", () => {
  it("refuses a declared Content-Length over the limit without reading", async () => {
    const { stream, state } = chunkedBody(chunks(4, 512));
    const { timer, start } = manualTimer();
    const result = await readBoundedBody(post(stream, { "Content-Length": "2048" }), { maxBytes: LIMIT, deadlineMs: 1000, timer: start });
    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(state.pulls).toBe(0);
    expect(timer.started).toEqual([]);
  });

  it("refuses a malformed Content-Length without reading", async () => {
    for (const value of ["12abc", "-1", "1, 1", ""]) {
      const { stream, state } = chunkedBody(chunks(1, 10));
      expect(await readBoundedBody(post(stream, { "Content-Length": value }), { maxBytes: LIMIT, deadlineMs: 1000 }), value).toEqual({ ok: false, reason: "failed" });
      expect(state.pulls, value).toBe(0);
    }
  });

  it("cancels a chunked body without Content-Length as soon as it passes the limit", async () => {
    // 10 chunks of 300 bytes: the fourth takes it to 1200, past 1024.
    const { stream, state } = chunkedBody(chunks(10, 300));
    const { timer, start } = manualTimer();
    const result = await readBoundedBody(post(stream), { maxBytes: LIMIT, deadlineMs: 1000, timer: start });
    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(state.cancelled).toBe(true);
    expect(state.served).toBe(4);
    expect(timer.cleared).toBe(1);
  });

  it("does not trust a small Content-Length over a longer stream", async () => {
    const { stream, state } = chunkedBody(chunks(10, 300));
    expect(await readBoundedBody(post(stream, { "Content-Length": "10" }), { maxBytes: LIMIT, deadlineMs: 1000 })).toEqual({ ok: false, reason: "too_large" });
    expect(state.cancelled).toBe(true);
    expect(state.served).toBe(4);
  });

  it("accepts a body of exactly the limit, chunked or declared", async () => {
    const { stream, state } = chunkedBody(chunks(4, 256));
    const { timer, start } = manualTimer();
    const result = await readBoundedBody(post(stream), { maxBytes: LIMIT, deadlineMs: 1000, timer: start });
    expect(result.ok && result.bytes.byteLength).toBe(LIMIT);
    expect(result.ok && result.bytes.every((byte) => byte === 0x61)).toBe(true);
    expect(state.cancelled).toBe(false);
    expect(timer.started).toEqual([1000]);
    expect(timer.cleared).toBe(1);

    const declared = await readBoundedBody(post("a".repeat(LIMIT), { "Content-Length": String(LIMIT) }), { maxBytes: LIMIT, deadlineMs: 1000 });
    expect(declared.ok && declared.bytes.byteLength).toBe(LIMIT);
    expect(await readBoundedBody(post("a".repeat(LIMIT + 1)), { maxBytes: LIMIT, deadlineMs: 1000 })).toEqual({ ok: false, reason: "too_large" });
  });

  it("reads an empty or missing body as no bytes", async () => {
    const none = await readBoundedBody(post(null), { maxBytes: LIMIT, deadlineMs: 1000 });
    expect(none.ok && none.bytes.byteLength).toBe(0);
    const empty = await readBoundedBody(post(""), { maxBytes: LIMIT, deadlineMs: 1000 });
    expect(empty.ok && empty.bytes.byteLength).toBe(0);
  });

  it("gives up on a stalled stream at the deadline and cancels it", async () => {
    const { stream, state } = chunkedBody(chunks(2, 100), "stall");
    const { timer, start } = manualTimer();
    const pending = readBoundedBody(post(stream), { maxBytes: LIMIT, deadlineMs: 5000, timer: start });
    await settle();
    expect(state.served).toBe(2);
    expect(state.cancelled).toBe(false);
    timer.fire();
    expect(await pending).toEqual({ ok: false, reason: "timeout" });
    expect(state.cancelled).toBe(true);
    expect(timer.started).toEqual([5000]);
  });

  it("enforces the deadline with the real timer too", async () => {
    const { stream, state } = chunkedBody([], "stall");
    expect(await readBoundedBody(post(stream), { maxBytes: LIMIT, deadlineMs: 20 })).toEqual({ ok: false, reason: "timeout" });
    expect(state.cancelled).toBe(true);
  });

  it("reports an upload that breaks off as failed, without throwing", async () => {
    const { stream } = chunkedBody(chunks(2, 100), "fail");
    expect(await readBoundedBody(post(stream), { maxBytes: LIMIT, deadlineMs: 1000 })).toEqual({ ok: false, reason: "failed" });
  });

  it("stops and cancels when the caller goes away", async () => {
    const { stream, state } = chunkedBody(chunks(1, 100), "stall");
    const controller = new AbortController();
    const pending = readBoundedBody(post(stream), { maxBytes: LIMIT, deadlineMs: 1000, signal: controller.signal });
    await settle();
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: "failed" });
    expect(state.cancelled).toBe(true);

    const gone = chunkedBody(chunks(1, 100));
    expect(await readBoundedBody(post(gone.stream), { maxBytes: LIMIT, deadlineMs: 1000, signal: AbortSignal.abort() })).toEqual({ ok: false, reason: "failed" });
    expect(gone.state.cancelled).toBe(true);
  });
});
