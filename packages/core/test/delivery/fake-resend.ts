// In-process stand-in for Resend's POST /emails (docs/requirements/resend.md, "Provider
// behaviour"), written from the public behaviour in our own words. It listens on 127.0.0.1 only,
// keeps idempotency keys for 24 hours on an injected clock, and plays scripted answers so tests
// can force every outcome the adapter classifies. Nothing leaves the process.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_RESEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * What one request does, in script order; once the script is used up the fallback runs
 * (normally "accept").
 * - accept: what Resend does: auth, idempotency, deliver, answer 200 `{id}`;
 * - lose-reply: as accept, then destroy the socket instead of answering;
 * - drop: destroy the socket without processing anything;
 * - respond: answer this status and body (or raw text); nothing is delivered or remembered;
 * - huge: answer a JSON body of exactly `huge` bytes (with `id` when given); nothing is delivered;
 * - hold: call `reached`, then wait for the promise before acting as `then` (default accept).
 *   A held accept counts as "being processed" for its key from the moment it arrives;
 * - delay: wait `delay` real milliseconds, then act as `then` (default accept).
 */
export type FakeResendBehaviour =
  | "accept"
  | "lose-reply"
  | "drop"
  | { readonly respond: number; readonly body?: unknown; readonly raw?: string; readonly headers?: Readonly<Record<string, string>> }
  | { readonly huge: number; readonly status?: number; readonly id?: string }
  | { readonly hold: Promise<void>; readonly then?: FakeResendBehaviour; readonly reached?: () => void }
  | { readonly delay: number; readonly then?: FakeResendBehaviour };

export interface FakeResendRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly raw: string;
  /** The parsed JSON body, or null when it is not JSON. */
  readonly body: unknown;
  /** The injected clock when the request arrived. */
  readonly at: number;
}

export interface FakeResendDelivery {
  readonly id: string;
  readonly idempotencyKey: string | null;
  readonly raw: string;
  readonly body: unknown;
  readonly at: number;
}

export interface FakeResend {
  /** Base URL to give the adapter, `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** Every request, repeats and refusals included. */
  readonly received: readonly FakeResendRequest[];
  /** Emails a recipient would have got: one per accepted key (or per accepted keyless request). */
  readonly delivered: readonly FakeResendDelivery[];
  queue(...behaviours: FakeResendBehaviour[]): void;
  /** What a request does once the script is used up. */
  setFallback(behaviour: FakeResendBehaviour): void;
  close(): Promise<void>;
}

type KeyRecord =
  | { readonly state: "processing"; readonly raw: string; readonly at: number }
  | { readonly state: "done"; readonly raw: string; readonly at: number; readonly status: number; readonly response: unknown };

const error = (statusCode: number, name: string, message: string) => ({ statusCode, name, message });

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function reply(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (res.destroyed || res.writableEnded) return;
  const text = typeof body === "string" ? body : JSON.stringify(body ?? null);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(text);
}

/** A JSON object of exactly `bytes` bytes (at least the size of its frame). */
function hugeBody(bytes: number, id: string | undefined): string {
  const head = id === undefined ? `{"pad":"` : `{"id":${JSON.stringify(id)},"pad":"`;
  return `${head}${"a".repeat(Math.max(0, bytes - head.length - 2))}"}`;
}

export async function startFakeResend(options: {
  readonly apiKey: string;
  readonly clock: { now(): Date };
  readonly windowMs?: number;
}): Promise<FakeResend> {
  const windowMs = options.windowMs ?? FAKE_RESEND_WINDOW_MS;
  const now = () => options.clock.now().getTime();
  const received: FakeResendRequest[] = [];
  const delivered: FakeResendDelivery[] = [];
  const keys = new Map<string, KeyRecord>();
  const script: FakeResendBehaviour[] = [];
  let fallback: FakeResendBehaviour = "accept";

  /** The refusal Resend gives before it looks at the key, or null. */
  function refusal(request: FakeResendRequest): { status: number; body: unknown } | null {
    if (request.path !== "/emails") return { status: 404, body: error(404, "not_found", "The requested endpoint does not exist.") };
    if (request.method !== "POST") return { status: 405, body: error(405, "method_not_allowed", "Method not allowed.") };
    const auth = request.headers.authorization;
    if (!auth) return { status: 401, body: error(401, "missing_api_key", "Missing API key in the authorization header.") };
    if (auth !== `Bearer ${options.apiKey}`) return { status: 403, body: error(403, "invalid_api_key", "API key is invalid.") };
    const body = request.body as { from?: unknown; to?: unknown; subject?: unknown } | null;
    if (!body || typeof body !== "object" || typeof body.from !== "string" || !Array.isArray(body.to) || typeof body.subject !== "string")
      return { status: 422, body: error(422, "validation_error", "The request body is missing a required field.") };
    return null;
  }

  async function accept(request: FakeResendRequest, res: ServerResponse, waits: Promise<void>[], loseReply: boolean): Promise<void> {
    const answer = async (status: number, body: unknown) => {
      await Promise.all(waits);
      if (loseReply) res.socket?.destroy();
      else reply(res, status, body);
    };
    const refused = refusal(request);
    if (refused) return answer(refused.status, refused.body);
    const header = request.headers["idempotency-key"];
    const key = typeof header === "string" ? header : null;
    if (key !== null) {
      const found = keys.get(key);
      if (found && now() - found.at > windowMs) keys.delete(key);
      const record = keys.get(key);
      if (record?.state === "processing")
        return answer(409, error(409, "concurrent_idempotent_requests", "Another request with this idempotency key is in progress."));
      if (record?.state === "done") {
        if (record.raw === request.raw) return answer(record.status, record.response);
        return answer(409, error(409, "invalid_idempotent_request", "This idempotency key was used with a different request body."));
      }
      keys.set(key, { state: "processing", raw: request.raw, at: request.at });
    }
    try {
      await Promise.all(waits);
    } catch (cause) {
      if (key !== null) keys.delete(key);
      throw cause;
    }
    const id = randomUUID();
    delivered.push({ id, idempotencyKey: key, raw: request.raw, body: request.body, at: now() });
    if (key !== null) keys.set(key, { state: "done", raw: request.raw, at: request.at, status: 200, response: { id } });
    if (loseReply) res.socket?.destroy();
    else reply(res, 200, { id });
  }

  async function act(behaviour: FakeResendBehaviour, request: FakeResendRequest, res: ServerResponse, waits: Promise<void>[]): Promise<void> {
    if (behaviour === "accept" || behaviour === "lose-reply") return accept(request, res, waits, behaviour === "lose-reply");
    if (behaviour === "drop") {
      await Promise.all(waits);
      res.socket?.destroy();
      return;
    }
    if ("hold" in behaviour) {
      behaviour.reached?.();
      return act(behaviour.then ?? "accept", request, res, [...waits, behaviour.hold]);
    }
    if ("delay" in behaviour) {
      const ms = behaviour.delay;
      return act(behaviour.then ?? "accept", request, res, [...waits, new Promise<void>((resolve) => setTimeout(resolve, ms))]);
    }
    await Promise.all(waits);
    if ("huge" in behaviour) return reply(res, behaviour.status ?? 200, hugeBody(behaviour.huge, behaviour.id));
    return reply(res, behaviour.respond, behaviour.raw ?? behaviour.body ?? "", behaviour.headers);
  }

  const server = createServer((req, res) => {
    res.on("error", () => {});
    void (async () => {
      const raw = await readBody(req);
      const request: FakeResendRequest = {
        method: req.method ?? "",
        path: (req.url ?? "/").split("?")[0] ?? "/",
        headers: req.headers,
        raw,
        body: parseJson(raw),
        at: now(),
      };
      received.push(request);
      await act(script.shift() ?? fallback, request, res, []);
    })().catch(() => { res.socket?.destroy(); });
  });
  // A client that gives up mid-answer resets its socket; that is the client's business.
  server.on("connection", (socket) => socket.on("error", () => {}));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    received,
    delivered,
    queue(...behaviours) { script.push(...behaviours); },
    setFallback(behaviour) { fallback = behaviour; },
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
