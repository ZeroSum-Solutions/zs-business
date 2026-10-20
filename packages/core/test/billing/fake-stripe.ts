// In-process stand-in for Stripe's POST /v1/checkout/sessions (docs/requirements/stripe.md,
// "Provider behaviour"), written from the public behaviour in our own words. It listens on
// 127.0.0.1 only, reads the form body, checks the Bearer key, remembers idempotency keys for 24
// hours on an injected clock and plays scripted answers so tests can force every outcome the
// client classifies. Nothing leaves the process.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_STRIPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * What one request does, in script order; once the script is used up the fallback runs
 * (normally "accept").
 * - accept: what Stripe does: auth, idempotency, validate, create a session, answer 200;
 * - lose-reply: as accept, then destroy the socket instead of answering;
 * - drop: destroy the socket without processing anything;
 * - respond: answer this status and JSON body (or raw text); nothing is created or remembered;
 * - error: shorthand for respond with Stripe's error envelope `{ error: { type, code?, message } }`;
 * - huge: answer a JSON body of exactly `huge` bytes (with a valid `id` and `url`); nothing is created;
 * - hold: call `reached`, then wait for the promise before acting as `then` (default accept).
 *   A held accept counts as "in flight" for its key from the moment it arrives, so a concurrent
 *   request with the same key answers 409 like Stripe does.
 */
export type FakeStripeBehaviour =
  | "accept"
  | "lose-reply"
  | "drop"
  | { readonly respond: number; readonly body?: unknown; readonly raw?: string; readonly headers?: Readonly<Record<string, string>> }
  | { readonly error: number; readonly type: string; readonly code?: string }
  | { readonly huge: number; readonly status?: number }
  | { readonly hold: Promise<void>; readonly then?: FakeStripeBehaviour; readonly reached?: () => void };

export interface FakeStripeRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly raw: string;
  /** The form body as ordered pairs, exactly as sent. */
  readonly entries: ReadonlyArray<readonly [string, string]>;
  /** The form body as a flat record (last value wins). */
  readonly form: Readonly<Record<string, string>>;
  /** The injected clock when the request arrived. */
  readonly at: number;
}

export interface FakeStripeSession {
  readonly id: string;
  readonly object: "checkout.session";
  readonly url: string;
  readonly livemode: boolean;
  readonly mode: string;
  readonly status: "open";
  readonly payment_status: "unpaid";
  readonly amount_total: number;
  readonly currency: string;
  readonly client_reference_id: string | null;
  readonly expires_at: number;
  readonly metadata: Readonly<Record<string, string>>;
  readonly success_url: string;
  readonly cancel_url: string;
}

export interface FakeStripe {
  /** Base URL to give the client, `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** Every request, repeats and refusals included. */
  readonly received: readonly FakeStripeRequest[];
  /** Sessions Stripe would have created: one per accepted key (or per accepted keyless request). */
  readonly sessions: readonly FakeStripeSession[];
  queue(...behaviours: FakeStripeBehaviour[]): void;
  /** What a request does once the script is used up. */
  setFallback(behaviour: FakeStripeBehaviour): void;
  close(): Promise<void>;
}

type KeyRecord =
  | { readonly state: "processing"; readonly raw: string; readonly at: number }
  | { readonly state: "done"; readonly raw: string; readonly at: number; readonly status: number; readonly response: unknown };

const stripeError = (type: string, message: string, extra: Readonly<Record<string, string>> = {}) =>
  ({ error: { type, message, ...extra } });

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

const alnum = (length: number) => randomBytes(length).toString("base64").replace(/[^A-Za-z0-9]/g, "").padEnd(length, "x").slice(0, length);

/** A session-shaped JSON object of exactly `bytes` bytes (at least the size of its frame). */
function hugeBody(bytes: number): string {
  const id = `cs_test_${alnum(24)}`;
  const head = `{"id":"${id}","url":"https://checkout.stripe.test/c/pay/${id}","pad":"`;
  return `${head}${"a".repeat(Math.max(0, bytes - head.length - 2))}"}`;
}

export async function startFakeStripe(options: {
  readonly secretKey: string;
  readonly clock: { now(): Date };
  readonly windowMs?: number;
}): Promise<FakeStripe> {
  const windowMs = options.windowMs ?? FAKE_STRIPE_WINDOW_MS;
  const livemode = /^(sk|rk)_live_/.test(options.secretKey);
  const now = () => options.clock.now().getTime();
  const received: FakeStripeRequest[] = [];
  const sessions: FakeStripeSession[] = [];
  const keys = new Map<string, KeyRecord>();
  const script: FakeStripeBehaviour[] = [];
  let fallback: FakeStripeBehaviour = "accept";

  /** The refusal Stripe gives before it looks at the key, or null. */
  function refusal(request: FakeStripeRequest): { status: number; body: unknown } | null {
    if (request.path !== "/v1/checkout/sessions")
      return { status: 404, body: stripeError("invalid_request_error", "Unrecognized request URL.") };
    if (request.method !== "POST")
      return { status: 404, body: stripeError("invalid_request_error", "Unrecognized request URL (method).") };
    const auth = request.headers.authorization;
    if (!auth) return { status: 401, body: stripeError("invalid_request_error", "You did not provide an API key.") };
    if (auth !== `Bearer ${options.secretKey}`)
      return { status: 401, body: stripeError("invalid_request_error", "Invalid API Key provided.") };
    if (!String(request.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded"))
      return { status: 400, body: stripeError("invalid_request_error", "Invalid request body encoding.") };
    return null;
  }

  /** Parameter checks after the key: what a fresh request with bad parameters is told. */
  function invalid(request: FakeStripeRequest): { status: number; body: unknown } | null {
    const form = request.form;
    for (const required of ["mode", "success_url", "line_items[0][price_data][currency]", "line_items[0][price_data][unit_amount]"])
      if (!(required in form))
        return { status: 400, body: stripeError("invalid_request_error", `Missing required param: ${required}.`, { code: "parameter_missing", param: required }) };
    if (!/^\d+$/.test(form["line_items[0][price_data][unit_amount]"]!))
      return { status: 400, body: stripeError("invalid_request_error", "Invalid integer.", { code: "parameter_invalid_integer", param: "unit_amount" }) };
    if ("expires_at" in form) {
      const ahead = Number(form.expires_at) * 1000 - now();
      if (!/^\d+$/.test(form.expires_at!) || ahead < 30 * 60 * 1000 || ahead > 24 * 60 * 60 * 1000)
        return { status: 400, body: stripeError("invalid_request_error", "expires_at must be 30 minutes to 24 hours ahead.", { param: "expires_at" }) };
    }
    return null;
  }

  function createSession(request: FakeStripeRequest): FakeStripeSession {
    const form = request.form;
    const id = `cs_${livemode ? "live" : "test"}_${alnum(24)}`;
    const metadata: Record<string, string> = {};
    for (const [key, value] of request.entries) {
      const match = /^metadata\[([^\]]+)\]$/.exec(key);
      if (match) metadata[match[1]!] = value;
    }
    const quantity = Number(form["line_items[0][quantity]"] ?? "1");
    const session: FakeStripeSession = {
      id,
      object: "checkout.session",
      url: `https://checkout.stripe.test/c/pay/${id}`,
      livemode,
      mode: form.mode!,
      status: "open",
      payment_status: "unpaid",
      amount_total: Number(form["line_items[0][price_data][unit_amount]"]) * quantity,
      currency: form["line_items[0][price_data][currency]"]!,
      client_reference_id: form.client_reference_id ?? null,
      expires_at: form.expires_at === undefined ? Math.floor(now() / 1000) + 24 * 3600 : Number(form.expires_at),
      metadata,
      success_url: form.success_url!,
      cancel_url: form.cancel_url ?? "",
    };
    sessions.push(session);
    return session;
  }

  async function accept(request: FakeStripeRequest, res: ServerResponse, waits: Promise<void>[], loseReply: boolean): Promise<void> {
    const answer = async (status: number, body: unknown, headers: Readonly<Record<string, string>> = {}) => {
      await Promise.all(waits);
      if (loseReply) res.socket?.destroy();
      else reply(res, status, body, headers);
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
        return answer(409, stripeError("idempotency_error", "There is currently another in-progress request using this Idempotency Key.", { code: "idempotency_key_in_use" }));
      if (record?.state === "done") {
        if (record.raw === request.raw) return answer(record.status, record.response, { "idempotent-replayed": "true" });
        return answer(400, stripeError("idempotency_error", "Keys for idempotent requests can only be used with the same parameters they were first used with."));
      }
      keys.set(key, { state: "processing", raw: request.raw, at: request.at });
    }
    try {
      await Promise.all(waits);
    } catch (cause) {
      if (key !== null) keys.delete(key);
      throw cause;
    }
    // Like Stripe, a validation failure is also remembered for its key and replayed.
    const bad = invalid(request);
    const status = bad ? bad.status : 200;
    const response = bad ? bad.body : createSession(request);
    if (key !== null) keys.set(key, { state: "done", raw: request.raw, at: request.at, status, response });
    if (loseReply) res.socket?.destroy();
    else reply(res, status, response);
  }

  async function act(behaviour: FakeStripeBehaviour, request: FakeStripeRequest, res: ServerResponse, waits: Promise<void>[]): Promise<void> {
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
    await Promise.all(waits);
    if ("huge" in behaviour) return reply(res, behaviour.status ?? 200, hugeBody(behaviour.huge));
    if ("error" in behaviour)
      return reply(res, behaviour.error, stripeError(behaviour.type, "Scripted failure.", behaviour.code === undefined ? {} : { code: behaviour.code }));
    return reply(res, behaviour.respond, behaviour.raw ?? behaviour.body ?? "", behaviour.headers);
  }

  const server = createServer((req, res) => {
    res.on("error", () => {});
    void (async () => {
      const raw = await readBody(req);
      const entries = [...new URLSearchParams(raw).entries()] as Array<[string, string]>;
      const request: FakeStripeRequest = {
        method: req.method ?? "",
        path: (req.url ?? "/").split("?")[0] ?? "/",
        headers: req.headers,
        raw,
        entries,
        form: Object.fromEntries(entries),
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
    sessions,
    queue(...behaviours) { script.push(...behaviours); },
    setFallback(behaviour) { fallback = behaviour; },
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
