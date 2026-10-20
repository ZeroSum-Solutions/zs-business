// In-process stand-in for Twilio's Messages endpoint (docs/requirements/twilio.md, "Provider
// behaviour"), written from the public behaviour in our own words. It listens on 127.0.0.1 only,
// checks HTTP Basic auth and the account in the path, reads the form body and plays scripted
// answers so tests can force every outcome the adapter classifies. Like Twilio it keeps no
// idempotency: two identical requests are two messages. Nothing leaves the process.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * What one request does, in script order; once the script is used up the fallback runs
 * (normally "accept").
 * - accept: what Twilio does: auth, account, checks, deliver, answer 201 with the message;
 * - lose-reply: as accept, then destroy the socket instead of answering;
 * - drop: destroy the socket without processing anything;
 * - respond: answer this status and body (or raw text); nothing is delivered;
 * - huge: answer a JSON body of exactly `huge` bytes (with `sid` when given); nothing is delivered;
 * - hold: call `reached`, then wait for the promise before acting as `then` (default accept);
 * - delay: wait `delay` real milliseconds, then act as `then` (default accept).
 */
export type FakeTwilioBehaviour =
  | "accept"
  | "lose-reply"
  | "drop"
  | { readonly respond: number; readonly body?: unknown; readonly raw?: string; readonly headers?: Readonly<Record<string, string>> }
  | { readonly huge: number; readonly status?: number; readonly sid?: string }
  | { readonly hold: Promise<void>; readonly then?: FakeTwilioBehaviour; readonly reached?: () => void }
  | { readonly delay: number; readonly then?: FakeTwilioBehaviour };

export interface FakeTwilioRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly raw: string;
  /** The form fields in the order they arrived. */
  readonly fields: readonly (readonly [string, string])[];
  /** The form fields by name (the last value wins). */
  readonly form: Readonly<Record<string, string>>;
}

export interface FakeTwilioDelivery {
  readonly sid: string;
  readonly to: string;
  readonly from: string;
  readonly body: string;
  readonly statusCallback: string | null;
  readonly raw: string;
}

export interface FakeTwilio {
  /** Base URL to give the adapter, `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** Every request, repeats and refusals included. */
  readonly received: readonly FakeTwilioRequest[];
  /** Texts a recipient would have got: one per accepted request, repeats included. */
  readonly delivered: readonly FakeTwilioDelivery[];
  queue(...behaviours: FakeTwilioBehaviour[]): void;
  /** What a request does once the script is used up. */
  setFallback(behaviour: FakeTwilioBehaviour): void;
  /** Marks a number as opted out (it texted STOP): later sends to it are refused with 21610. */
  optOut(number: string): void;
  close(): Promise<void>;
}

const E164 = /^\+[1-9][0-9]{1,14}$/;
const PATH = /^\/2010-04-01\/Accounts\/([^/]+)\/Messages\.json$/;

const error = (status: number, code: number, message: string) =>
  ({ code, message, more_info: `https://errors.example.test/${code}`, status });

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
function hugeBody(bytes: number, sid: string | undefined): string {
  const head = sid === undefined ? `{"pad":"` : `{"sid":${JSON.stringify(sid)},"pad":"`;
  return `${head}${"a".repeat(Math.max(0, bytes - head.length - 2))}"}`;
}

export const fakeMessageSid = () => `SM${randomBytes(16).toString("hex")}`;

export async function startFakeTwilio(options: {
  readonly accountSid: string;
  /** Accepted as `accountSid:authToken`. */
  readonly authToken?: string;
  /** Accepted as `sid:secret`. */
  readonly apiKey?: { readonly sid: string; readonly secret: string };
}): Promise<FakeTwilio> {
  const received: FakeTwilioRequest[] = [];
  const delivered: FakeTwilioDelivery[] = [];
  const optedOut = new Set<string>();
  const script: FakeTwilioBehaviour[] = [];
  let fallback: FakeTwilioBehaviour = "accept";
  const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const allowed = new Set<string>([
    ...(options.authToken === undefined ? [] : [basic(options.accountSid, options.authToken)]),
    ...(options.apiKey === undefined ? [] : [basic(options.apiKey.sid, options.apiKey.secret)]),
  ]);

  /** The refusal Twilio would give this request, or null when it would create a message. */
  function refusal(request: FakeTwilioRequest): { status: number; body: unknown } | null {
    const auth = request.headers.authorization;
    if (!auth || !allowed.has(auth)) return { status: 401, body: error(401, 20003, "Authentication failed.") };
    const match = PATH.exec(request.path);
    if (!match || match[1] !== options.accountSid) return { status: 404, body: error(404, 20404, "No such resource.") };
    if (request.method !== "POST") return { status: 405, body: error(405, 20004, "Method not allowed.") };
    const { To: to, From: from, Body: body } = request.form;
    if (!to || !E164.test(to)) return { status: 400, body: error(400, 21211, "The To number is not valid.") };
    if (!from || !E164.test(from)) return { status: 400, body: error(400, 21212, "The From number is not valid.") };
    if (!body) return { status: 400, body: error(400, 21602, "A message body is required.") };
    if (body.length > 1600) return { status: 400, body: error(400, 21617, "The message body is too long.") };
    if (optedOut.has(to)) return { status: 400, body: error(400, 21610, "The recipient has opted out of messages from this sender.") };
    return null;
  }

  async function accept(request: FakeTwilioRequest, res: ServerResponse, waits: Promise<void>[], loseReply: boolean): Promise<void> {
    await Promise.all(waits);
    const refused = refusal(request);
    if (refused) {
      if (loseReply) res.socket?.destroy();
      else reply(res, refused.status, refused.body);
      return;
    }
    const sid = fakeMessageSid();
    const { To: to = "", From: from = "", Body: body = "", StatusCallback: statusCallback } = request.form;
    delivered.push({ sid, to, from, body, statusCallback: statusCallback ?? null, raw: request.raw });
    if (loseReply) {
      res.socket?.destroy();
      return;
    }
    reply(res, 201, {
      sid,
      account_sid: options.accountSid,
      to,
      from,
      body,
      status: "queued",
      direction: "outbound-api",
      num_segments: "1",
      error_code: null,
      error_message: null,
      api_version: "2010-04-01",
      uri: `/2010-04-01/Accounts/${options.accountSid}/Messages/${sid}.json`,
    });
  }

  async function act(behaviour: FakeTwilioBehaviour, request: FakeTwilioRequest, res: ServerResponse, waits: Promise<void>[]): Promise<void> {
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
    if ("huge" in behaviour) return reply(res, behaviour.status ?? 201, hugeBody(behaviour.huge, behaviour.sid));
    return reply(res, behaviour.respond, behaviour.raw ?? behaviour.body ?? "", behaviour.headers);
  }

  const server = createServer((req, res) => {
    res.on("error", () => {});
    void (async () => {
      const raw = await readBody(req);
      const fields = [...new URLSearchParams(raw)].map(([name, value]) => [name, value] as const);
      const request: FakeTwilioRequest = {
        method: req.method ?? "",
        path: (req.url ?? "/").split("?")[0] ?? "/",
        headers: req.headers,
        raw,
        fields,
        form: Object.fromEntries(fields),
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
    optOut(number) { optedOut.add(number); },
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
