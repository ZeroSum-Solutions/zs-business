/**
 * Reads a request body without ever holding more than a set number of bytes. A declared
 * Content-Length over the limit is refused before anything is read. Otherwise the stream is
 * read chunk by chunk and cancelled as soon as it runs past the limit, misses the deadline,
 * or the caller goes away (an aborted or broken upload is a result, never a thrown error).
 * Under `next start` the route's answer still reaches a client that is mid-upload
 * (e2e/live/body-limits.spec.ts).
 */

/** too_large: over maxBytes. timeout: not all there by the deadline. failed: a malformed Content-Length, or the upload broke off. */
export type BodyRead = { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; reason: "too_large" | "timeout" | "failed" };

/** Calls `fire` once after `ms` and returns what stops it; tests pass a fake. */
export type Timer = (ms: number, fire: () => void) => () => void;

export const realTimer: Timer = (ms, fire) => {
  const id = setTimeout(fire, ms);
  return () => clearTimeout(id);
};

/** What a route lets tests change: how long the body may take, and the timer that counts it. */
export interface BodyTiming {
  deadlineMs?: number;
  timer?: Timer;
}

export interface BodyLimits extends BodyTiming {
  maxBytes: number;
  deadlineMs: number;
  /** Ends the read when it aborts; defaults to request.signal, which Next aborts when the client goes away. */
  signal?: AbortSignal;
}

type Stop = { stop: "timeout" | "failed" };

export async function readBoundedBody(request: Request, limits: BodyLimits): Promise<BodyRead> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared.trim())) return { ok: false, reason: "failed" };
    if (Number(declared) > limits.maxBytes) return { ok: false, reason: "too_large" };
  }
  if (!request.body) return { ok: true, bytes: new Uint8Array(0) };

  const reader = request.body.getReader();
  let stop: (reason: Stop["stop"]) => void = () => {};
  const stopped = new Promise<Stop>((resolve) => { stop = (reason) => resolve({ stop: reason }); });
  const signal = limits.signal ?? request.signal;
  const onAbort = () => stop("failed");
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const clearTimer = (limits.timer ?? realTimer)(limits.deadlineMs, () => stop("timeout"));

  const refuse = (reason: Stop["stop"] | "too_large"): BodyRead => {
    // Stop the upload; a stream that already broke may refuse to cancel, which changes nothing.
    reader.cancel().catch(() => {});
    return { ok: false, reason };
  };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), stopped]);
      if ("stop" in next) return refuse(next.stop);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limits.maxBytes) return refuse("too_large");
      chunks.push(next.value);
    }
  } catch {
    return refuse("failed");
  } finally {
    clearTimer();
    signal.removeEventListener("abort", onAbort);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
