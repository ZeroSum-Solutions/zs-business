// In-process stand-in for the Stripe calls Hub plans make (docs/requirements/plans.md PL-5, PL-6,
// PL-10), written from Stripe's public behaviour in our own words: subscription Checkout Sessions
// with idempotency keys, Billing Portal sessions and GET /v1/subscriptions/<id>. Listens on
// 127.0.0.1 only, checks the Bearer key and keeps subscriptions the test edits. Nothing leaves the
// process. All data is synthetic.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakePlanRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly raw: string;
  readonly form: Readonly<Record<string, string>>;
}

/** A subscription as Stripe would answer it; tests change it between events. */
export interface FakeSubscription {
  id: string;
  object: "subscription";
  customer: string;
  status: string;
  metadata: Record<string, string>;
  items: { object: "list"; data: Array<{ id: string; quantity: number; price: { id: string; lookup_key: string | null }; current_period_end: number }> };
  start_date: number;
  created: number;
  trial_end: number | null;
  ended_at: number | null;
  canceled_at: number | null;
  cancel_at_period_end: boolean;
}

export interface FakeStripePlans {
  readonly url: string;
  readonly received: readonly FakePlanRequest[];
  readonly subscriptions: Map<string, FakeSubscription>;
  /** Answers the next requests with this status (Stripe's error envelope), in order. */
  fail(...statuses: number[]): void;
  close(): Promise<void>;
}

const alnum = (length: number) => randomBytes(length).toString("hex").slice(0, length);
const stripeError = (message: string) => ({ error: { type: "invalid_request_error", message } });

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function reply(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export async function startFakeStripePlans(options: { readonly secretKeys: readonly string[] }): Promise<FakeStripePlans> {
  const received: FakePlanRequest[] = [];
  const subscriptions = new Map<string, FakeSubscription>();
  const keys = new Map<string, { raw: string; body: unknown }>();
  const failures: number[] = [];

  function handle(request: FakePlanRequest, res: ServerResponse) {
    const auth = request.headers.authorization;
    if (!options.secretKeys.some((key) => auth === `Bearer ${key}`)) return reply(res, 401, stripeError("Invalid API Key provided."));
    const failure = failures.shift();
    if (failure !== undefined) return reply(res, failure, stripeError("Scripted failure."));
    if (request.method === "GET" && request.path.startsWith("/v1/subscriptions/")) {
      const found = subscriptions.get(decodeURIComponent(request.path.slice("/v1/subscriptions/".length)));
      return found ? reply(res, 200, found) : reply(res, 404, stripeError("No such subscription."));
    }
    if (request.method !== "POST") return reply(res, 404, stripeError("Unrecognized request URL."));
    if (request.path === "/v1/checkout/sessions") {
      const key = request.headers["idempotency-key"];
      if (typeof key === "string") {
        const seen = keys.get(key);
        if (seen && seen.raw === request.raw) return reply(res, 200, seen.body, { "idempotent-replayed": "true" });
        if (seen) return reply(res, 400, stripeError("Keys for idempotent requests can only be used with the same parameters."));
      }
      const form = request.form;
      if (form.mode !== "subscription" || !form["line_items[0][price]"]) return reply(res, 400, stripeError("Missing line_items."));
      const id = `cs_test_${alnum(24)}`;
      const body = { id, object: "checkout.session", mode: "subscription", url: `https://checkout.stripe.test/c/pay/${id}` };
      if (typeof key === "string") keys.set(key, { raw: request.raw, body });
      return reply(res, 200, body);
    }
    if (request.path === "/v1/billing_portal/sessions") {
      if (!/^cus_/.test(request.form.customer ?? "")) return reply(res, 400, stripeError("No such customer."));
      const id = `bps_test_${alnum(24)}`;
      return reply(res, 200, { id, object: "billing_portal.session", url: `https://billing.stripe.test/p/session/${id}`, return_url: request.form.return_url });
    }
    return reply(res, 404, stripeError("Unrecognized request URL."));
  }

  const server = createServer((req, res) => {
    res.on("error", () => {});
    void (async () => {
      const raw = await readBody(req);
      const request: FakePlanRequest = {
        method: req.method ?? "", path: (req.url ?? "/").split("?")[0] ?? "/", headers: req.headers, raw,
        form: Object.fromEntries(new URLSearchParams(raw).entries()),
      };
      received.push(request);
      handle(request, res);
    })().catch(() => { res.socket?.destroy(); });
  });
  server.on("connection", (socket) => socket.on("error", () => {}));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    subscriptions,
    fail(...statuses) { failures.push(...statuses); },
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
