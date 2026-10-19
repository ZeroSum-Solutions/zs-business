/**
 * Body limits through a running Next server. The live build that global setup made
 * (.next-live, built with ZS_API_URL set) is started a second time on a free port, with an
 * in-process fake Supabase Auth and a stand-in API that only counts calls, so /api/sign-in and
 * the /api/v1 proxy reach their body reads. It has to be a live build: the hosting-mode guard
 * answers 500 to everything when a demo build runs with live settings. Requests go over raw
 * sockets: a chunked upload past the limit must get its 413 while the client is still sending,
 * a declared Content-Length over it must get its 413 before any body is sent, and a client
 * that hangs up mid-body must not hurt the server.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { connect, createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { childEnv } from "./child-env";
import { createFakeGoTrue, memoryAuthStore, serveFakeGoTrue, type FakeGoTrue } from "./fake-gotrue";
import { redactJwts } from "./redact";

const dashboardDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SIGN_IN_LIMIT = 2048;
const PROXY_LIMIT = 64 * 1024;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

interface Upload {
  /** Body bytes written before the server answered or hung up. */
  sent: number;
  /** What the server sent back, if anything. */
  response: string;
  /** The server closed or reset the connection. */
  hungUp: boolean;
}

/**
 * Write a request head, then body pieces with a pause after each, stopping as soon as the
 * server answers or hangs up. Then wait up to `waitMs` for the rest of its answer.
 */
async function upload(port: number, head: string, pieces: { bytes: Buffer; size: number }[], pauseMs = 5, waitMs = 3000): Promise<Upload> {
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
  const result: Upload = { sent: 0, response: "", hungUp: false };
  socket.on("data", (data: Buffer) => { result.response += data.toString("latin1"); });
  socket.on("end", () => { result.hungUp = true; });
  socket.on("close", () => { result.hungUp = true; });
  // EPIPE or ECONNRESET when the server cut the upload off: expected here.
  socket.on("error", () => { result.hungUp = true; });
  const answered = () => result.hungUp || result.response.includes("\r\n\r\n");
  socket.write(head);
  for (const piece of pieces) {
    if (answered()) break;
    socket.write(piece.bytes);
    result.sent += piece.size;
    await sleep(pauseMs);
  }
  for (let waited = 0; !result.hungUp && waited < waitMs; waited += 20) {
    if (/\r\n\r\n/.test(result.response) && !/^HTTP\/1\.1 1/.test(result.response) && completeBody(result.response)) break;
    await sleep(20);
  }
  socket.destroy();
  return result;
}

/** True once the response has all of its body, by Content-Length or the last chunk. */
function completeBody(response: string): boolean {
  const [head, ...rest] = response.split("\r\n\r\n");
  const body = rest.join("\r\n\r\n");
  if (/\r\ntransfer-encoding: *chunked/i.test(head ?? "")) return response.endsWith("\r\n0\r\n\r\n");
  const length = /\r\ncontent-length: *(\d+)/i.exec(head ?? "")?.[1];
  return length === undefined || body.length >= Number(length);
}

/** `count` chunked-encoding pieces of `size` bytes each. */
function chunkedPieces(count: number, size: number) {
  const frame = Buffer.concat([Buffer.from(`${size.toString(16)}\r\n`), Buffer.alloc(size, "a"), Buffer.from("\r\n")]);
  return Array.from({ length: count }, () => ({ bytes: frame, size }));
}

const statusOf = (upload: Upload) => Number(/^HTTP\/1\.1 (\d{3})/.exec(upload.response)?.[1] ?? 0);

test.describe("request body limits on a running server", () => {
  test.describe.configure({ mode: "serial" });

  let web: ChildProcess | undefined;
  let log = "";
  let port = 0;
  let origin = "";
  let gotrue: FakeGoTrue;
  let closeAuth: (() => Promise<void>) | undefined;
  let api: Server | undefined;
  let apiCalls = 0;
  let cookie = "";
  const owner = { id: randomUUID(), email: "owner@example.com", appMetadata: { tenant_id: randomUUID() } };

  const head = (path: string, headers: Record<string, string>) =>
    [`POST ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, `Origin: ${origin}`, "Sec-Fetch-Site: same-origin", "Content-Type: application/json",
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), "", ""].join("\r\n");

  /** A real sign-in request, which must still get 204 after the abuse. */
  const askForLink = () => fetch(`${origin}/api/sign-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({ email: owner.email }),
  });

  test.beforeAll(async ({}, info) => {
    test.skip(info.project.name !== "desktop", "HTTP-only checks against one extra server; one project is enough");
    test.setTimeout(120_000);
    const anonKey = randomBytes(24).toString("base64url");
    gotrue = createFakeGoTrue({ jwtSecret: randomBytes(32).toString("hex"), issuer: "http://127.0.0.1/auth/v1", anonKey, store: memoryAuthStore([owner]) });
    const auth = await serveFakeGoTrue(gotrue);
    closeAuth = auth.close;
    // Stands in for apps/api: an oversize body must never get this far.
    api = createHttpServer((req, res) => {
      apiCalls += 1;
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ items: [] }));
    });
    await new Promise<void>((resolve) => api!.listen(0, "127.0.0.1", resolve));
    const apiPort = (api.address() as { port: number }).port;

    port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    // The live build global setup made; the server reads these per request.
    web = spawn("pnpm", ["exec", "next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: dashboardDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv({
        NEXT_DIST_DIR: ".next-live",
        ZS_API_URL: `http://127.0.0.1:${apiPort}`,
        SUPABASE_URL: auth.url,
        SUPABASE_ANON_KEY: anonKey,
        DASHBOARD_SIGN_IN_PER_ADDRESS: "10000",
        DASHBOARD_SIGN_IN_GLOBAL: "10000",
        NEXT_TELEMETRY_DISABLED: "1",
      }) as NodeJS.ProcessEnv,
    });
    web.stdout!.on("data", (chunk: Buffer) => { log += chunk; });
    web.stderr!.on("data", (chunk: Buffer) => { log += chunk; });
    for (let tries = 0; ; tries += 1) {
      if (web.exitCode !== null) throw new Error(`next start exited: ${redactJwts(log)}`);
      if (tries > 240) throw new Error(`next start did not answer: ${redactJwts(log)}`);
      if (await fetch(`${origin}/api/session`).then((response) => response.status < 500, () => false)) break;
      await sleep(250);
    }

    // Sign in through the server, as the browser would, for the proxy's session cookies.
    expect((await askForLink()).status).toBe(204);
    const link = new URL(gotrue.lastLink(owner.email)!);
    const confirmed = await fetch(`${origin}${link.pathname}${link.search}`, { redirect: "manual" });
    expect(confirmed.status).toBe(303);
    cookie = confirmed.headers.getSetCookie().map((header) => header.split(";")[0]).join("; ");
    expect(cookie).toContain("zs-auth");
  });

  test.afterAll(async () => {
    if (web?.pid !== undefined && web.exitCode === null) {
      const exited = new Promise((resolve) => web!.once("exit", resolve));
      try { process.kill(-web.pid, "SIGTERM"); } catch { /* already gone */ }
      await exited;
    }
    await closeAuth?.();
    await new Promise((resolve) => (api ? api.close(resolve) : resolve(undefined)));
  });

  test.afterEach(() => {
    // Whatever a test sent, the server is still up and logged no crash.
    expect(web?.exitCode ?? null, redactJwts(log)).toBeNull();
    expect(redactJwts(log)).not.toMatch(/uncaught|unhandled/i);
  });

  test("sign-in: a declared Content-Length over 2 KiB gets 413 before any body is sent", async () => {
    const result = await upload(port, head("/api/sign-in", { "Content-Length": "1000000" }), []);
    expect(statusOf(result)).toBe(413);
    expect(result.response).toContain('{"error":"too_large"}');
    expect(result.sent).toBe(0);
  });

  test("sign-in: a chunked upload past 2 KiB gets 413 while the client is still sending", async () => {
    const otpCalls = gotrue.calls.filter((call) => call.path === "/auth/v1/otp").length;
    // 128 pieces of 512 bytes, 64 KiB in all, a few milliseconds apart.
    const pieces = chunkedPieces(128, 512);
    const result = await upload(port, head("/api/sign-in", { "Transfer-Encoding": "chunked" }), pieces);
    // The 413 arrived while the client was still sending, a few pieces past the limit.
    expect(statusOf(result), result.response).toBe(413);
    expect(result.response).toContain('{"error":"too_large"}');
    expect(result.sent).toBeGreaterThan(SIGN_IN_LIMIT);
    expect(result.sent).toBeLessThan(16 * 1024);
    expect(gotrue.calls.filter((call) => call.path === "/auth/v1/otp")).toHaveLength(otpCalls);
  });

  test("proxy: a declared Content-Length over 64 KiB gets 413 before any body is sent", async () => {
    const result = await upload(port, head("/api/v1/crm/contacts", { Cookie: cookie, "Content-Length": "10000000" }), []);
    expect(statusOf(result)).toBe(413);
    expect(result.response).toContain('"code":"ValidationFailed"');
    expect(apiCalls).toBe(0);
  });

  test("proxy: a chunked upload past 64 KiB gets 413 while the client is still sending", async () => {
    // 256 pieces of 4 KiB, 1 MiB in all.
    const result = await upload(port, head("/api/v1/crm/contacts", { Cookie: cookie, "Transfer-Encoding": "chunked" }), chunkedPieces(256, 4096));
    expect(statusOf(result), result.response).toBe(413);
    expect(result.response).toContain('"code":"ValidationFailed"');
    expect(result.sent).toBeGreaterThan(PROXY_LIMIT);
    expect(result.sent).toBeLessThan(256 * 1024);
    expect(apiCalls).toBe(0);
  });

  test("a client that hangs up mid-body does not hurt the server", async () => {
    const callsBefore = apiCalls;
    for (const [target, headers] of [
      ["/api/sign-in", { "Content-Length": "1000" }],
      ["/api/sign-in", { "Transfer-Encoding": "chunked" }],
      ["/api/v1/crm/contacts", { Cookie: cookie, "Content-Length": "20000" }],
      ["/api/v1/crm/contacts", { Cookie: cookie, "Transfer-Encoding": "chunked" }],
    ] as const) {
      const socket = connect(port, "127.0.0.1");
      await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
      socket.on("error", () => {});
      socket.write(head(target, headers));
      socket.write("Transfer-Encoding" in headers ? "64\r\n" + "a".repeat(50) : "a".repeat(100));
      await sleep(200);
      socket.destroy();
    }
    await sleep(500);
    // The next requests are served as usual.
    expect((await askForLink()).status).toBe(204);
    const proxied = await fetch(`${origin}/api/v1/crm/contacts`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: origin, "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ name: "Ada" }),
    });
    expect(proxied.status).toBe(200);
    expect(apiCalls).toBe(callsBefore + 1);
  });
});
