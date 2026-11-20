// Runner heartbeats (plans.md PL-26): what the workers write so the plan page can tell a runner that is on from one
// that is off. A beat is written only by a run that did not fail, at most once a minute per runner, and a failed
// write never fails the run.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { asService, type Transaction } from "@zs/db";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import { createRunnerHeartbeats, followUpHeartbeatSeconds, withHeartbeats, type RunnerBeat } from "../src/runner-heartbeat.js";

let database: TestDatabase;
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database?.close(); });

const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(database.servicePool, work);
const stored = async () => (await service((tx) => tx.query<{ runner: string; beat_at: Date; fresh_for_seconds: number }>(
  "SELECT runner, beat_at, fresh_for_seconds FROM runner_heartbeats ORDER BY runner"))).rows;
const reset = async () => { await database.pool.query("TRUNCATE runner_heartbeats"); };
const BEATS: readonly RunnerBeat[] = [{ runner: "followup", freshForSeconds: 7200 }, { runner: "templated", freshForSeconds: 7200 }];
const manual = (start = Date.parse("2026-11-20T10:00:00.000Z")) => {
  let at = start;
  return { clock: { now: () => new Date(at) }, advance: (ms: number) => { at += ms; } };
};

describe("createRunnerHeartbeats", () => {
  it("writes one row per runner, stamped by the database, and moves it forward on the next beat", async () => {
    await reset();
    const time = manual();
    const beats = createRunnerHeartbeats({ service, clock: time.clock });
    const before = Date.now();
    await beats.beat(BEATS);
    const first = await stored();
    expect(first.map((row) => [row.runner, row.fresh_for_seconds])).toEqual([["followup", 7200], ["templated", 7200]]);
    // The injected clock only paces the writes; the beat time is the database's, so a skewed worker clock cannot fake a live runner.
    expect(first.every((row) => row.beat_at.getTime() >= before - 5_000)).toBe(true);
    time.advance(61_000);
    await beats.beat([{ runner: "followup", freshForSeconds: 3600 }]);
    const second = await stored();
    expect(second.find((row) => row.runner === "followup")).toMatchObject({ fresh_for_seconds: 3600 });
    expect(second.find((row) => row.runner === "followup")!.beat_at.getTime()).toBeGreaterThanOrEqual(first.find((row) => row.runner === "followup")!.beat_at.getTime());
  });

  it("writes a runner at most once a minute, and each runner on its own", async () => {
    await reset();
    const time = manual();
    const calls: number[] = [];
    const service2 = (async (work: (tx: Transaction) => Promise<unknown>) => { calls.push(1); return service(work); }) as typeof service;
    const beats = createRunnerHeartbeats({ service: service2, clock: time.clock });
    await beats.beat(BEATS);
    await beats.beat(BEATS);
    time.advance(59_999);
    await beats.beat(BEATS);
    expect(calls).toHaveLength(1);
    await beats.beat([{ runner: "delivery_email", freshForSeconds: 1800 }]);
    expect(calls).toHaveLength(2);
    time.advance(1);
    await beats.beat(BEATS);
    expect(calls).toHaveLength(3);
  });

  it("never throws: a failed write is reported and tried again at the next run", async () => {
    const time = manual();
    const report = vi.fn();
    let broken = true;
    const flaky = (async (work: (tx: Transaction) => Promise<unknown>) => { if (broken) throw new Error("connection refused"); return service(work); }) as typeof service;
    const beats = createRunnerHeartbeats({ service: flaky, clock: time.clock, report });
    await reset();
    await expect(beats.beat(BEATS)).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);
    expect(await stored()).toEqual([]);
    // A failed write does not start the minute: the next run writes.
    broken = false;
    await beats.beat(BEATS);
    expect(await stored()).toHaveLength(2);
  });

  it("keeps one write in flight per runner: a second call while the first is pending writes nothing", async () => {
    const time = manual();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const slow = (async (work: (tx: Transaction) => Promise<unknown>) => { calls += 1; await gate; return service(work); }) as typeof service;
    const beats = createRunnerHeartbeats({ service: slow, clock: time.clock });
    await reset();
    const first = beats.beat(BEATS);
    await beats.beat(BEATS);
    expect(calls).toBe(1);
    release();
    await first;
    expect(await stored()).toHaveLength(2);
  });

  it("gives up on a write that hangs, so the run is never held past its budget", async () => {
    const time = manual();
    const report = vi.fn();
    const hung = (() => new Promise(() => undefined)) as unknown as typeof service;
    const beats = createRunnerHeartbeats({ service: hung, clock: time.clock, report, capMs: 20 });
    await expect(beats.beat(BEATS)).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);
    // The write may still land, so the claim holds for the minute: a second call starts no second write.
    let calls = 0;
    const counted = (() => { calls += 1; return new Promise(() => undefined); }) as unknown as typeof service;
    const again = createRunnerHeartbeats({ service: counted, clock: time.clock, report, capMs: 20 });
    await again.beat(BEATS);
    await again.beat(BEATS);
    expect(calls).toBe(1);
    time.advance(60_000);
    await again.beat(BEATS);
    expect(calls).toBe(2);
  });

  it("sizes the follow-up window to two slots, or two loops of a slower worker", () => {
    expect(followUpHeartbeatSeconds(60, 300_000)).toBe(7200);
    expect(followUpHeartbeatSeconds(5, 300_000)).toBe(600);
    expect(followUpHeartbeatSeconds(5, 3_600_000)).toBe(7200);
  });
});

describe("withHeartbeats", () => {
  const wrap = (job: "followup" | "delivery", result: object | Error) => {
    const beat = vi.fn(async () => undefined);
    const run = vi.fn(async () => { if (result instanceof Error) throw result; return result; });
    return { beat, run, runner: withHeartbeats({ run, close: () => "kept" }, { job, heartbeats: { beat }, beats: BEATS }) };
  };

  it("beats after a run that finished, and returns the run's own summary and the runner's other members", async () => {
    const { beat, runner } = wrap("delivery", { passes: 1, claimed: 2, sent: 2, errors: 0 });
    expect(await runner.run()).toEqual({ passes: 1, claimed: 2, sent: 2, errors: 0 });
    expect(runner.close()).toBe("kept");
    expect(beat).toHaveBeenCalledWith(BEATS);
  });

  it("beats after a run that did nothing, because an idle runner is a live one", async () => {
    const { beat, runner } = wrap("delivery", { passes: 1, claimed: 0, sent: 0, errors: 0 });
    await runner.run();
    expect(beat).toHaveBeenCalledTimes(1);
  });

  it("does not beat after a run that threw, or one whose every work item failed", async () => {
    const threw = wrap("delivery", new Error("database down"));
    await expect(threw.runner.run()).rejects.toThrow("database down");
    expect(threw.beat).not.toHaveBeenCalled();
    const failed = wrap("delivery", { passes: 1, claimed: 3, sent: 0, retried: 0, blocked: 0, dead: 0, errors: 3 });
    await failed.runner.run();
    expect(failed.beat).not.toHaveBeenCalled();
  });
});
