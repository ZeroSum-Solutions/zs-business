// activepieces.md W-2, W-8: the receiver URL policy and the HTTP transport. No test leaves 127.0.0.1.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addressRefused, createNodeWebhookTransport, webhookUrlProblem } from "../../src/index.js";

describe("receiver URL policy (W-2)", () => {
  it("accepts public https URLs", () => {
    for (const url of ["https://cloud.activepieces.com/api/v1/webhooks/abc", "https://automations.haldenrowe.example:8443/hook?x=1",
      "https://93.184.216.34/hook", "https://[2606:4700::1111]/hook"])
      expect(webhookUrlProblem(url), url).toBeNull();
  });

  it("refuses http, credentials, private names and private or reserved addresses", () => {
    const cases: Record<string, string> = {
      "http://cloud.activepieces.com/hook": "https_required",
      "https://user:pass@cloud.activepieces.com/hook": "credentials_in_url",
      "https://localhost/hook": "private_address",
      "https://intranet/hook": "private_address",
      "https://box.local/hook": "private_address",
      "https://api.internal/hook": "private_address",
      "https://127.0.0.1/hook": "private_address",
      "https://10.1.2.3/hook": "private_address",
      "https://172.20.0.1/hook": "private_address",
      "https://192.168.1.10/hook": "private_address",
      "https://169.254.169.254/latest/meta-data": "private_address",
      "https://100.64.0.1/hook": "private_address",
      "https://0.0.0.0/hook": "private_address",
      "https://[::1]/hook": "private_address",
      "https://[fd00::1]/hook": "private_address",
      "https://[fe80::1]/hook": "private_address",
      "https://[::ffff:127.0.0.1]/hook": "private_address",
      "https://[::ffff:a9fe:a9fe]/hook": "private_address",
      "not a url": "not_a_url",
    };
    for (const [url, problem] of Object.entries(cases)) expect(webhookUrlProblem(url), url).toBe(problem);
  });

  it("allows loopback, over http too, only when the policy says so (tests, local development)", () => {
    expect(webhookUrlProblem("http://127.0.0.1:9999/hook", { allowLoopback: true })).toBeNull();
    expect(webhookUrlProblem("http://localhost:9999/hook", { allowLoopback: true })).toBeNull();
    expect(webhookUrlProblem("http://10.0.0.1/hook", { allowLoopback: true })).toBe("https_required");
    expect(webhookUrlProblem("https://10.0.0.1/hook", { allowLoopback: true })).toBe("private_address");
  });

  it("judges an IPv4 address carried in IPv6 as IPv4", () => {
    expect(addressRefused("::ffff:10.0.0.1")).toBe(true);
    expect(addressRefused("::ffff:93.184.216.34")).toBe(false);
    expect(addressRefused("93.184.216.34")).toBe(false);
    expect(addressRefused("not-an-ip")).toBe(true);
  });
});

describe("node transport (W-8)", () => {
  let port = 0;
  const seen: { headers: Record<string, unknown>; body: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url === "/redirect") return void res.writeHead(307, { location: "http://127.0.0.1:1/elsewhere" }).end();
      if (req.url === "/slow") return void setTimeout(() => res.writeHead(200).end(), 2_000);
      if (req.url === "/big") return void res.writeHead(200).end("x".repeat(100_000));
      res.writeHead(req.url === "/gone" ? 410 : 204).end();
    });
  });
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const post = (path: string, transport = createNodeWebhookTransport({ allowLoopback: true }), signal = new AbortController().signal) =>
    transport.post({ url: `http://127.0.0.1:${port}${path}`, headers: { "webhook-id": "evt_1", "content-type": "application/json" }, body: '{"a":1}', signal });

  it("posts the exact body and headers and returns the status", async () => {
    expect(await post("/ok")).toEqual({ status: 204 });
    expect(seen.at(-1)).toMatchObject({ body: '{"a":1}', headers: { "webhook-id": "evt_1", "content-length": "7" } });
    expect(await post("/gone")).toEqual({ status: 410 });
    expect(await post("/big")).toEqual({ status: 200 });
  });

  it("never follows a redirect", async () => {
    const before = seen.length;
    expect(await post("/redirect")).toEqual({ status: 307 });
    expect(seen.length).toBe(before + 1);
  });

  it("refuses loopback unless the policy allows it, before connecting", async () => {
    const before = seen.length;
    expect(await post("/ok", createNodeWebhookTransport())).toEqual({ error: "url_https_required" });
    expect(seen.length).toBe(before);
  });

  it("refuses a name whose DNS answer is private (rebinding), before connecting", async () => {
    const before = seen.length;
    const transport = createNodeWebhookTransport({
      lookup: (_host, _options, callback) => callback(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }]),
    });
    expect(await transport.post({ url: "https://hooks.haldenrowe.example/x", headers: {}, body: "{}", signal: new AbortController().signal }))
      .toEqual({ error: "address_refused" });
    const loopbackAnswer = createNodeWebhookTransport({
      lookup: (_host, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]),
    });
    expect(await loopbackAnswer.post({ url: "https://rebind.haldenrowe.example/x", headers: {}, body: "{}", signal: new AbortController().signal }))
      .toEqual({ error: "address_refused" });
    expect(seen.length).toBe(before);
  });

  it("reports an aborted request as a timeout", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    expect(await post("/slow", undefined, controller.signal)).toEqual({ error: "timeout" });
  });

  it("reports a refused connection as a network error", async () => {
    const transport = createNodeWebhookTransport({ allowLoopback: true });
    const result = await transport.post({ url: "http://127.0.0.1:1/x", headers: {}, body: "{}", signal: new AbortController().signal });
    expect(result).toEqual({ error: "network_econnrefused" });
  });
});
