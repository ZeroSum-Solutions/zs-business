import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createR2SiteStore, EMPTY_PAYLOAD_SHA256, signS3Request, type R2SiteStoreConfig } from "../src/sites/r2-s3.js";

const ACCESS_KEY = "AKIDTESTONLY0000";
const SECRET = "test-only-secret-not-a-real-key-0123456789";
const NOW = new Date("2026-10-20T12:34:56.789Z");
const clock = { now: () => NOW };

describe("signS3Request", () => {
  it("reproduces the published SigV4 'GET Object' example", () => {
    const signed = signS3Request({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      headers: { Range: "bytes=0-9" },
      payloadHash: EMPTY_PAYLOAD_SHA256,
      date: new Date("2013-05-24T00:00:00Z"),
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });
    expect(signed.canonicalRequest).toBe([
      "GET", "/test.txt", "",
      "host:examplebucket.s3.amazonaws.com", "range:bytes=0-9",
      `x-amz-content-sha256:${EMPTY_PAYLOAD_SHA256}`, "x-amz-date:20130524T000000Z", "",
      "host;range;x-amz-content-sha256;x-amz-date", EMPTY_PAYLOAD_SHA256,
    ].join("\n"));
    expect(signed.signature).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(signed.headers.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
      + "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(signed.headers).not.toHaveProperty("host");
  });
});

// A local S3 lookalike: objects in a Map, conditional writes, and SigV4 checked against what arrived.
interface Seen { method: string; url: string; headers: IncomingHttpHeaders }
const objects = new Map<string, { body: Buffer; contentType: string; etag: string }>();
const seen: Seen[] = [];
let forceStatus: number | undefined;
let server: Server;
let endpoint: string;

function verifySignature(method: string, url: string, headers: IncomingHttpHeaders, body: Buffer): string | null {
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/
    .exec(String(headers.authorization ?? ""));
  if (!match) return "malformed authorization";
  const [, accessKey, day, region, signedList, signature] = match as unknown as string[];
  if (accessKey !== ACCESS_KEY) return "unknown access key";
  const names = signedList!.split(";");
  for (const name of ["host", "x-amz-date", "x-amz-content-sha256", "content-type", "if-match", "if-none-match"]) {
    if (headers[name] !== undefined && !names.includes(name)) return `${name} is not signed`;
  }
  const payloadHash = String(headers["x-amz-content-sha256"]);
  if (payloadHash !== createHash("sha256").update(body).digest("hex")) return "payload hash mismatch";
  const stamp = String(headers["x-amz-date"]);
  if (stamp.slice(0, 8) !== day) return "scope date mismatch";
  const date = new Date(stamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));
  const others = Object.fromEntries(names.filter((name) => !["host", "x-amz-date", "x-amz-content-sha256"].includes(name))
    .map((name) => [name, String(headers[name])]));
  const [path, query = ""] = url.split("?");
  const expected = signS3Request({
    method, host: String(headers.host), path: path!, query, headers: others, payloadHash, date, region: region!,
    accessKeyId: ACCESS_KEY, secretAccessKey: SECRET,
  });
  return expected.signature === signature ? null : "signature mismatch";
}

beforeAll(async () => {
  let writes = 0;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const method = req.method!;
      const url = req.url!;
      seen.push({ method, url, headers: req.headers });
      const problem = verifySignature(method, url, req.headers, body);
      if (problem) return res.writeHead(403, { "x-problem": problem }).end("<Error>SignatureDoesNotMatch</Error>");
      if (forceStatus) return res.writeHead(forceStatus).end("<Error/>");
      const key = decodeURIComponent(url.split("?")[0]!);
      const current = objects.get(key);
      if (method === "GET" || method === "HEAD") {
        if (!current) return res.writeHead(404).end();
        res.writeHead(200, { etag: current.etag, "content-type": current.contentType, "content-length": current.body.byteLength });
        return res.end(method === "GET" ? current.body : undefined);
      }
      if (method === "DELETE") {
        objects.delete(key);
        return res.writeHead(204).end();
      }
      if (method === "PUT") {
        const ifMatch = req.headers["if-match"];
        const ifNoneMatch = req.headers["if-none-match"];
        if ((ifNoneMatch === "*" && current) || (ifMatch !== undefined && current?.etag !== ifMatch)) {
          return res.writeHead(412).end("<Error>PreconditionFailed</Error>");
        }
        writes += 1;
        const etag = `"${createHash("md5").update(`${writes}`).update(body).digest("hex")}"`;
        objects.set(key, { body, contentType: String(req.headers["content-type"]), etag });
        return res.writeHead(200, { etag }).end();
      }
      res.writeHead(405).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  objects.clear();
  seen.length = 0;
  forceStatus = undefined;
});

const store = (overrides: Partial<R2SiteStoreConfig> = {}) => createR2SiteStore(
  { endpoint, bucket: "sites-test", accessKeyId: ACCESS_KEY, secretAccessKey: SECRET, ...overrides },
  { fetch, clock },
);
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);
const rejection = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a rejection"); }, (caught: unknown) => caught as Error);

describe("createR2SiteStore against a local S3 server", () => {
  it("round-trips put, head, get and delete", async () => {
    const r2 = store();
    expect(await r2.get("t/a/blobs/x")).toBeNull();
    expect(await r2.head("t/a/blobs/x")).toBeNull();
    const put = await r2.put("t/a/blobs/x", bytes("<h1>hi</h1>"), { contentType: "text/html; charset=utf-8" });
    expect(put?.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(await r2.head("t/a/blobs/x")).toEqual({ etag: put!.etag, size: 11 });
    const got = await r2.get("t/a/blobs/x");
    expect(got && { ...got, body: text(got.body) }).toEqual({ body: "<h1>hi</h1>", contentType: "text/html; charset=utf-8", etag: put!.etag });
    await r2.delete("t/a/blobs/x");
    expect(await r2.get("t/a/blobs/x")).toBeNull();
    await r2.delete("t/a/blobs/x"); // a missing object deletes fine
    expect(seen.every((request) => request.url.startsWith("/sites-test/t/a/blobs/x"))).toBe(true);
  });

  it("honours absent and etag conditions, answering null when they fail", async () => {
    const r2 = store();
    const first = await r2.put("hosts/example.com", bytes("1"), { contentType: "application/json", onlyIf: { absent: true } });
    expect(first).not.toBeNull();
    expect(await r2.put("hosts/example.com", bytes("2"), { contentType: "application/json", onlyIf: { absent: true } })).toBeNull();
    expect(await r2.put("hosts/example.com", bytes("2"), { contentType: "application/json", onlyIf: { etagMatches: '"stale"' } })).toBeNull();
    const second = await r2.put("hosts/example.com", bytes("3"), { contentType: "application/json", onlyIf: { etagMatches: first!.etag } });
    expect(second?.etag).not.toBe(first!.etag);
    expect(text((await r2.get("hosts/example.com"))!.body)).toBe("3");
    const puts = seen.filter((request) => request.method === "PUT").map((request) => [request.headers["if-none-match"], request.headers["if-match"]]);
    expect(puts).toEqual([["*", undefined], ["*", undefined], [undefined, '"stale"'], [undefined, first!.etag]]);
  });

  it("treats R2's 409 ConditionalRequestConflict on a conditional put as a lost race", async () => {
    forceStatus = 409;
    expect(await store().put("k", bytes("x"), { contentType: "text/plain", onlyIf: { absent: true } })).toBeNull();
    await expect(store().put("k", bytes("x"), { contentType: "text/plain" })).rejects.toThrow("R2 put failed with status 409");
  });

  it("encodes keys with spaces, unicode, reserved characters and slashes", async () => {
    const r2 = store();
    const key = "t/ü ñ/a b+c(1)!*'~.txt/日本";
    await r2.put(key, bytes("u"), { contentType: "text/plain" });
    expect(seen.at(-1)!.url).toBe("/sites-test/t/%C3%BC%20%C3%B1/a%20b%2Bc%281%29%21%2A%27~.txt/%E6%97%A5%E6%9C%AC");
    expect(text((await r2.get(key))!.body)).toBe("u");
    expect([...objects.keys()]).toEqual([`/sites-test/${key}`]);
  });

  it("prepends keyPrefix to every key", async () => {
    const r2 = store({ keyPrefix: "staging/" });
    await r2.put("hosts/a.example", bytes("p"), { contentType: "text/plain" });
    await r2.head("hosts/a.example");
    await r2.get("hosts/a.example");
    await r2.delete("hosts/a.example");
    expect(seen.map((request) => request.url)).toEqual(Array(4).fill("/sites-test/staging/hosts/a.example"));
  });

  it("signs with the injected clock and the auto region", async () => {
    await store().head("k");
    const headers = seen[0]!.headers;
    expect(headers["x-amz-date"]).toBe("20261020T123456Z");
    expect(headers.authorization).toContain(`Credential=${ACCESS_KEY}/20261020/auto/s3/aws4_request`);
    expect(headers["x-amz-content-sha256"]).toBe(EMPTY_PAYLOAD_SHA256);
  });

  it("throws on other statuses without leaking the secret or signature", async () => {
    const bad = store({ secretAccessKey: "wrong-secret-value-that-must-not-leak" });
    const error = await rejection(bad.get("k"));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("R2 get failed with status 403");
    expect(seen[0]!.headers.authorization).toBeDefined();
    const signature = /Signature=([0-9a-f]+)/.exec(String(seen[0]!.headers.authorization))![1]!;
    expect(error.message).not.toContain(signature);
    forceStatus = 500;
    for (const call of [() => store().head("k"), () => store().put("k", bytes("x"), { contentType: "text/plain" }), () => store().delete("k")]) {
      const failure = await rejection(call());
      expect(failure.message).toMatch(/^R2 (head|put|delete) failed with status 500$/);
      expect(failure.message).not.toContain(SECRET);
    }
  });

  it("reports a network failure by operation only", async () => {
    const failing: typeof fetch = async () => { throw new TypeError(`fetch failed ${SECRET}`); };
    const r2 = createR2SiteStore({ endpoint, bucket: "sites-test", accessKeyId: ACCESS_KEY, secretAccessKey: SECRET }, { fetch: failing, clock });
    await expect(r2.get("k")).rejects.toThrow(/^R2 get request failed$/);
  });

  it("refuses unsafe configuration and dot-segment keys", () => {
    const deps = { fetch, clock };
    const base = { bucket: "sites-test", accessKeyId: ACCESS_KEY, secretAccessKey: SECRET };
    expect(() => createR2SiteStore({ ...base, endpoint: "http://r2.example.com" }, deps)).toThrow("https");
    expect(() => createR2SiteStore({ ...base, endpoint: "https://user:pw@r2.example.com" }, deps)).toThrow("credentials");
    expect(() => createR2SiteStore({ ...base, endpoint: "https://r2.example.com/bucket" }, deps)).toThrow("path");
    expect(() => createR2SiteStore({ ...base, endpoint, bucket: "Bad_Bucket" }, deps)).toThrow("bucket");
    expect(() => createR2SiteStore({ ...base, endpoint, secretAccessKey: "" }, deps)).toThrow("credentials");
    expect(() => createR2SiteStore({ ...base, endpoint: "https://acct.r2.cloudflarestorage.com/" }, deps)).not.toThrow();
    return expect(store().get("t/../other")).rejects.toThrow("key is not valid");
  });
});
