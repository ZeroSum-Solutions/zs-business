import type { Timer } from "../../src/lib/server/body";

/**
 * A request body that hands out one chunk per read and counts its reads (pulls) and
 * whether it was cancelled. With `stall` it hangs after the given chunks instead of
 * ending; with `fail` it breaks off, as a client that drops the connection mid-upload.
 */
export function chunkedBody(chunks: Uint8Array[], end: "close" | "stall" | "fail" = "close") {
  const queue = [...chunks];
  const state = { pulls: 0, cancelled: false, served: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      const chunk = queue.shift();
      if (chunk) {
        state.served += 1;
        controller.enqueue(chunk);
      } else if (end === "close") controller.close();
      else if (end === "fail") controller.error(new Error("aborted"));
      // "stall": enqueue nothing, so the read waits for good.
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, state };
}

/** `count` chunks of `size` bytes of "a". */
export const chunks = (count: number, size: number) => Array.from({ length: count }, () => new Uint8Array(size).fill(0x61));

/** A Timer that never fires on its own: call fire() to pass the deadline. */
export function manualTimer() {
  const timer = { started: [] as number[], cleared: 0, fire: () => {} };
  const start: Timer = (ms, fire) => {
    timer.started.push(ms);
    timer.fire = fire;
    return () => { timer.cleared += 1; };
  };
  return { timer, start };
}

/** Lets pending reads and microtasks run. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
