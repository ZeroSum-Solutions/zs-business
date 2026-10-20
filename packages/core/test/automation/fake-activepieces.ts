// In-process stand-in for an Activepieces instance's catch-webhook trigger, written in our own
// words from how such a trigger behaves: each flow has a URL `/api/v1/webhooks/<flowId>` that
// takes a POST and answers 200, and the flow then checks the Standard Webhooks signature with
// the secret the owner pasted into it. It listens on 127.0.0.1 only; nothing leaves the process.
// The signature check uses verifyResendWebhook, an implementation written apart from the
// signer, so a mismatch between the two shows up here.
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { verifyResendWebhook } from "../../src/index.js";

/**
 * What one request to a flow does, in script order; once the script is used up the flow accepts.
 * - accept: verify, record, answer 200;
 * - respond: answer this status without recording;
 * - drop: destroy the socket without answering;
 * - redirect: answer 307 to `location` (a receiver must never be followed there);
 * - delay: wait `delay` real milliseconds, then accept.
 */
export type FlowBehaviour =
  | "accept"
  | "drop"
  | { readonly respond: number }
  | { readonly redirect: string }
  | { readonly delay: number };

export interface FlowRequest {
  readonly flowId: string;
  readonly headers: IncomingHttpHeaders;
  readonly raw: string;
}
export interface FlowEvent {
  readonly webhookId: string;
  readonly type: string;
  readonly body: { id: string; type: string; tenantId: string; occurredAt: string; data: Record<string, unknown> };
}

export interface FakeActivepieces {
  readonly baseUrl: string;
  /** A flow's catch-webhook URL; the flow checks signatures with `secrets` (the pasted one, and a second during a rotation). */
  flow(flowId: string, secrets: { current: string; previous?: string }): string;
  setSecrets(flowId: string, secrets: { current: string; previous?: string }): void;
  queue(flowId: string, ...behaviours: FlowBehaviour[]): void;
  /** Every request a flow got, repeats and refusals included. */
  readonly received: readonly FlowRequest[];
  /** Events a flow accepted, once per webhook-id, as a receiver that drops repeats would. */
  events(flowId: string): readonly FlowEvent[];
  /** Requests whose signature no secret of the flow matched (answered 401). */
  readonly unsigned: readonly FlowRequest[];
  close(): Promise<void>;
}

export async function startFakeActivepieces(clock: { now(): Date }): Promise<FakeActivepieces> {
  const flows = new Map<string, { secrets: { current: string; previous?: string }; script: FlowBehaviour[]; seen: Map<string, FlowEvent> }>();
  const received: FlowRequest[] = [];
  const unsigned: FlowRequest[] = [];

  const readBody = (req: IncomingMessage) => new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const match = /^\/api\/v1\/webhooks\/([A-Za-z0-9_-]+)$/.exec(req.url ?? "");
    const raw = await readBody(req);
    const flow = match ? flows.get(match[1]!) : undefined;
    if (!match || !flow || req.method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" }).end('{"message":"flow not found"}');
      return;
    }
    const request: FlowRequest = { flowId: match[1]!, headers: req.headers, raw };
    received.push(request);
    const behaviour = flow.script.shift() ?? "accept";
    if (behaviour === "drop") return void req.socket.destroy();
    if (typeof behaviour === "object" && "respond" in behaviour) return void res.writeHead(behaviour.respond).end();
    if (typeof behaviour === "object" && "redirect" in behaviour)
      return void res.writeHead(307, { location: behaviour.redirect }).end();
    if (typeof behaviour === "object" && "delay" in behaviour) await new Promise((resolve) => setTimeout(resolve, behaviour.delay));
    const header = (name: string) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const verified = verifyResendWebhook({
      secrets: flow.secrets,
      headers: { id: header("webhook-id"), timestamp: header("webhook-timestamp"), signature: header("webhook-signature") },
      body: Buffer.from(raw),
      now: clock.now(),
    });
    if (!verified.ok) {
      unsigned.push(request);
      return void res.writeHead(401).end();
    }
    const body = verified.payload as FlowEvent["body"];
    if (!flow.seen.has(verified.id)) flow.seen.set(verified.id, { webhookId: verified.id, type: body.type, body });
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    flow(flowId, secrets) {
      flows.set(flowId, { secrets, script: [], seen: new Map() });
      return `${baseUrl}/api/v1/webhooks/${flowId}`;
    },
    setSecrets(flowId, secrets) { flows.get(flowId)!.secrets = secrets; },
    queue(flowId, ...behaviours) { flows.get(flowId)!.script.push(...behaviours); },
    received,
    unsigned,
    events: (flowId) => [...(flows.get(flowId)?.seen.values() ?? [])],
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
