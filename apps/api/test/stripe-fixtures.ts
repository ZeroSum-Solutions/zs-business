// Shared pieces for the M5 Stripe tests (docs/requirements/stripe.md): synthetic Stripe secrets,
// an in-process fake of the Checkout Sessions endpoint (an injected fetch, no network), and an
// app built over a harness's database with Stripe turned on. Fake pilot data only.
import { randomBytes, randomUUID } from "node:crypto";
import { createLocalStubSessionCheck, createStripeClient, type StripeClient, type StripeConfig } from "@zs/core";
import type { ScopedDatabase } from "@zs/db";
import { createApp, createHs256Verifier, type StripeWebhookConfig } from "../src/app.js";
import { ORIGIN, SECRET, type ApiHarness } from "./helpers.js";

/** Synthetic Stripe test-mode key and webhook secrets, built at runtime so scanners do not flag a literal. */
export const STRIPE_KEY = ["sk", "test", "x".repeat(24)].join("_");
export const STRIPE_LIVE_KEY = ["sk", "live", "y".repeat(24)].join("_");
export const STRIPE_WEBHOOK_SECRET = "whsec_" + randomBytes(24).toString("base64");
export const PREVIOUS_STRIPE_WEBHOOK_SECRET = "whsec_" + randomBytes(24).toString("base64");
export const SUCCESS_URL = "https://app.haldenrowe.example/billing/success";
export const CANCEL_URL = "https://app.haldenrowe.example/billing/cancel";

export const STRIPE_CONFIG: StripeConfig = {
  secretKey: STRIPE_KEY,
  baseUrl: "https://stripe.fake.test",
  successUrl: SUCCESS_URL,
  cancelUrl: CANCEL_URL,
  minTopUp: 500,
  maxTopUp: 50_000,
};

export interface StripeCall {
  url: string;
  headers: Record<string, string>;
  form: URLSearchParams;
  body: string;
}
type Answer = (call: StripeCall) => Response | Promise<Response>;

/** One Checkout Session per Idempotency-Key, as Stripe replays a key it has seen. */
export function fakeStripe() {
  const calls: StripeCall[] = [];
  const sessions = new Map<string, { id: string; url: string }>();
  const queue: Answer[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const body = String(init.body);
    const call: StripeCall = { url, headers: { ...(init.headers as Record<string, string>) }, form: new URLSearchParams(body), body };
    calls.push(call);
    const next = queue.shift();
    if (next) return next(call);
    const key = call.headers["Idempotency-Key"]!;
    let session = sessions.get(key);
    if (!session) {
      const id = `cs_test_${randomUUID().replaceAll("-", "")}`;
      session = { id, url: `https://checkout.stripe.fake.test/c/pay/${id}` };
      sessions.set(key, session);
    }
    return json(200, session);
  };
  return {
    calls,
    sessions,
    /** The next request gets this answer instead of a session. */
    answerNext: (answer: Answer) => { queue.push(answer); },
    client: (config: Partial<StripeConfig> = {}): StripeClient => createStripeClient({ config: { ...STRIPE_CONFIG, ...config }, fetch }),
  };
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** An app over the harness's database (or another one) with the Stripe routes on. */
export function stripeApp(h: ApiHarness, options: {
  clock: { now(): Date };
  stripe?: StripeClient;
  stripeWebhook?: StripeWebhookConfig;
  db?: ScopedDatabase;
  onError?: (error: unknown) => void;
}) {
  const db = options.db ?? h.database.db;
  return createApp({
    verifier: createHs256Verifier(SECRET, { clock: options.clock }),
    sessionCheck: createLocalStubSessionCheck(h.database.db, options.clock),
    clock: options.clock,
    db,
    generateId: randomUUID,
    config: { allowedOrigins: [ORIGIN] },
    ...(options.stripe ? { stripe: options.stripe } : {}),
    ...(options.stripeWebhook ? { stripeWebhook: options.stripeWebhook } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
}
