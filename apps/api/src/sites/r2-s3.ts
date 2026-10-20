import { createHash, createHmac } from "node:crypto";
import type { SiteObjectStore, SiteStoredObject } from "@zs/contracts";

// The site object store over R2's S3-compatible API: plain fetch, path-style URLs and AWS
// Signature Version 4 header auth. Clock, fetch and credentials are injected.

export interface R2SiteStoreConfig {
  /** `https://<account>.r2.cloudflarestorage.com`; plain http only for a loopback test server. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** SigV4 region; R2 takes "auto" (the default). */
  readonly region?: string;
  /** Prepended to every key, as given (e.g. `staging/`). */
  readonly keyPrefix?: string;
  /** Per-request timeout; default 10 s. */
  readonly timeoutMs?: number;
}
export interface R2SiteStoreDeps {
  readonly fetch: typeof fetch;
  readonly clock: { now(): Date };
}

/** SHA-256 of the empty body, signed for GET, HEAD and DELETE. */
export const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface S3SignInput {
  readonly method: string;
  /** The Host header as sent (with a port when it is not the default). */
  readonly host: string;
  /** The URI path exactly as sent, already encoded. */
  readonly path: string;
  /** The canonical query string, already encoded and sorted; empty for none. */
  readonly query?: string;
  /** Further headers to sign and send, such as content-type or range. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the body. */
  readonly payloadHash: string;
  readonly date: Date;
  readonly region: string;
  readonly service?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}
export interface S3SignedRequest {
  /** Every header to send except host (fetch sets it from the URL), names lowercased. */
  readonly headers: Record<string, string>;
  readonly canonicalRequest: string;
  readonly signature: string;
}

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** `20130524T000000Z`. */
export const amzDate = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** SigV4 header auth for one S3 request: a pure function of its input. */
export function signS3Request(input: S3SignInput): S3SignedRequest {
  const stamp = amzDate(input.date);
  const day = stamp.slice(0, 8);
  const scope = `${day}/${input.region}/${input.service ?? "s3"}/aws4_request`;
  const sent: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) sent[name.toLowerCase()] = value;
  sent["x-amz-content-sha256"] = input.payloadHash;
  sent["x-amz-date"] = stamp;
  const signed = Object.entries({ ...sent, host: input.host })
    .map(([name, value]) => [name, value.trim().replace(/ +/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = signed.map(([name]) => name).join(";");
  const canonicalRequest = [
    input.method,
    input.path,
    input.query ?? "",
    ...signed.map(([name, value]) => `${name}:${value}`),
    "",
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  let key = hmac(`AWS4${input.secretAccessKey}`, day);
  for (const part of scope.split("/").slice(1)) key = hmac(key, part);
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  sent.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: sent, canonicalRequest, signature };
}

/** One key segment, encoded as SigV4 wants: everything but A-Za-z0-9-._~ as UTF-8 %XX. */
const encodeSegment = (segment: string) =>
  encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

function parseEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("R2 endpoint is not a URL");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("R2 endpoint must use https");
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, "") !== "") {
    throw new Error("R2 endpoint must be an origin without path, query or credentials");
  }
  return url;
}

/** A SiteObjectStore over R2's S3 API. Any status the port does not name throws `R2 <op> failed with status <n>`. */
export function createR2SiteStore(config: R2SiteStoreConfig, deps: R2SiteStoreDeps): SiteObjectStore {
  const origin = parseEndpoint(config.endpoint);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) throw new Error("R2 bucket name is not valid");
  if (!config.accessKeyId || !config.secretAccessKey) throw new Error("R2 credentials are missing");
  const region = config.region ?? "auto";
  const prefix = config.keyPrefix ?? "";
  const timeoutMs = config.timeoutMs ?? 10_000;

  async function send(op: string, method: string, key: string, body?: Uint8Array, headers?: Record<string, string>) {
    const full = prefix + key;
    const segments = full.split("/");
    // fetch would resolve dot segments, so the object written would not be the one named.
    if (!full || segments.some((segment) => segment === "." || segment === "..")) throw new Error(`R2 ${op}: key is not valid`);
    const path = `/${config.bucket}/${segments.map(encodeSegment).join("/")}`;
    const { headers: signed } = signS3Request({
      method,
      host: origin.host,
      path,
      ...(headers ? { headers } : {}),
      payloadHash: body ? sha256Hex(body) : EMPTY_PAYLOAD_SHA256,
      date: deps.clock.now(),
      region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    });
    try {
      return await deps.fetch(`${origin.origin}${path}`, {
        method,
        headers: signed,
        ...(body ? { body: body as Uint8Array<ArrayBuffer> } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new Error(timedOut ? `R2 ${op} timed out` : `R2 ${op} request failed`, { cause: error });
    }
  }
  const fail = async (op: string, response: Response): Promise<never> => {
    await miss(response);
    throw new Error(`R2 ${op} failed with status ${response.status}`);
  };
  const etagOf = (op: string, response: Response) => {
    const etag = response.headers.get("etag");
    if (!etag) throw new Error(`R2 ${op} answered without an ETag`);
    return etag;
  };

  return {
    async get(key): Promise<SiteStoredObject | null> {
      const response = await send("get", "GET", key);
      if (response.status === 404) return miss(response);
      if (response.status !== 200) return fail("get", response);
      const etag = etagOf("get", response);
      return { body: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type"), etag };
    },
    async head(key) {
      const response = await send("head", "HEAD", key);
      if (response.status === 404) return miss(response);
      if (response.status !== 200) return fail("head", response);
      const size = Number(response.headers.get("content-length"));
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("R2 head answered without a content length");
      return { etag: etagOf("head", response), size };
    },
    async put(key, body, options) {
      const headers: Record<string, string> = { "content-type": options.contentType };
      if (options.onlyIf) {
        if ("absent" in options.onlyIf) headers["if-none-match"] = "*";
        else headers["if-match"] = options.onlyIf.etagMatches;
      }
      const response = await send("put", "PUT", key, body, headers);
      // 409 is R2's ConditionalRequestConflict: a concurrent conditional write to the key won.
      if (options.onlyIf && (response.status === 412 || response.status === 409)) return miss(response);
      if (response.status !== 200) return fail("put", response);
      await miss(response);
      return { etag: etagOf("put", response) };
    },
    async delete(key) {
      const response = await send("delete", "DELETE", key);
      if (![200, 204, 404].includes(response.status)) return fail("delete", response);
      await miss(response);
    },
  };
}

/** Drops a response body nobody reads and answers null (a miss: 404 or a failed condition). */
async function miss(response: Response): Promise<null> {
  await response.body?.cancel().catch(() => undefined);
  return null;
}
