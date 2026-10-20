// M5 Activepieces webhook transport (activepieces.md W-2, W-8). Original code. The receiver URL
// is an owner's text, so the worker must not become a way to reach private networks: the URL
// policy refuses private, loopback and link-local hosts when the endpoint is saved, and the
// transport checks every address DNS returns at connect time, so a name that later resolves
// inward (DNS rebinding) is refused too. Redirects are never followed.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(network, prefix, "ipv6");
const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  let text = address.toLowerCase().split("%")[0]!;
  // A dotted IPv4 tail is two groups.
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.includes("::") ? text.split("::") as [string, string] : [text, null];
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const fill = rest === null ? [] : Array<string>(8 - left.length - right.length).fill("0");
  const groups = [...left, ...fill, ...right].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/**
 * An IPv4 address carried inside IPv6 is judged as IPv4, in every spelling `new URL` or DNS may
 * produce (`[::7f00:1]` for `[::127.0.0.1]`): IPv4-compatible `::/96`, IPv4-mapped
 * `::ffff:0:0/96`, SIIT `::ffff:0:0:0/96`, and the 6to4 prefix `2002::/16`.
 */
function embeddedIpv4(address: string): string | null {
  const groups = ipv6Groups(address);
  if (!groups) return null;
  const v4 = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  const zero = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  // `::` and `::1` are IPv6's own unspecified and loopback addresses, judged as IPv6.
  if (zero(0, 6) && groups[6] === 0 && groups[7]! <= 1) return null;
  if (zero(0, 5) && (groups[5] === 0 || groups[5] === 0xffff)) return v4(groups[6]!, groups[7]!);
  if (zero(0, 4) && groups[4] === 0xffff && groups[5] === 0) return v4(groups[6]!, groups[7]!);
  if (groups[0] === 0x2002) return v4(groups[1]!, groups[2]!);
  return null;
}

export interface UrlPolicy {
  /** Tests and local development only: allow http and https to 127.0.0.1, ::1 and localhost. */
  readonly allowLoopback?: boolean;
}

/** True when a connection to this address is refused under the policy. */
export function addressRefused(address: string, policy: UrlPolicy = {}): boolean {
  const v4 = embeddedIpv4(address);
  const family = v4 ? 4 : isIP(address);
  const value = v4 ?? address;
  if (family === 0) return true;
  const type = family === 4 ? "ipv4" : "ipv6";
  if (policy.allowLoopback && loopback.check(value, type)) return false;
  return blocked.check(value, type);
}

/**
 * W-2: the reason a receiver URL is refused, or null. https only (http to loopback when the
 * policy allows it), no credentials in the URL, and no host that is or names a private address.
 */
export function webhookUrlProblem(raw: string, policy: UrlPolicy = {}): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not_a_url";
  }
  const host = url.hostname.toLowerCase();
  // A fully qualified name's trailing dot (`localhost.`) names the same host.
  const bare = host.startsWith("[") ? host.slice(1, -1) : host.replace(/\.$/, "");
  const literal = isIP(bare) !== 0;
  const loopbackHost = bare === "localhost" || (literal && !addressRefused(bare, { allowLoopback: true }) && addressRefused(bare));
  if (url.username || url.password) return "credentials_in_url";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHost && policy.allowLoopback)) return "https_required";
  if (literal) return addressRefused(bare, policy) ? "private_address" : null;
  if (bare === "localhost") return policy.allowLoopback ? null : "private_address";
  if (!bare.includes(".") || [".localhost", ".local", ".internal", ".home.arpa"].some((suffix) => bare.endsWith(suffix)))
    return "private_address";
  return null;
}

export interface WebhookPost {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}
/** The receiver's answer, or a code for a request that got none. */
export type WebhookResponse = { readonly status: number } | { readonly error: string };
export interface WebhookTransport {
  post(request: WebhookPost): Promise<WebhookResponse>;
}

type Lookup = (hostname: string, options: { all: true }, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/** Reads at most this much of a receiver's answer, then hangs up; nothing reads the body. */
const RESPONSE_LIMIT = 4096;

/**
 * The production transport over node:http(s). `lookup` is injectable for tests; every address
 * it returns is checked before the socket connects.
 */
export function createNodeWebhookTransport(options: UrlPolicy & { readonly lookup?: Lookup } = {}): WebhookTransport {
  const resolve: Lookup = options.lookup ?? ((hostname, opts, callback) => dnsLookup(hostname, opts, callback));
  const guardedLookup = (hostname: string, opts: object, callback: (...args: any[]) => void) => {
    resolve(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error);
      const refused = addresses.find((entry) => addressRefused(entry.address, options));
      if (refused || addresses.length === 0) {
        const denied = Object.assign(new Error("Address refused by the webhook URL policy"), { code: "EADDRREFUSED" });
        return callback(denied);
      }
      if ((opts as { all?: boolean }).all) return callback(null, addresses);
      return callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
  return {
    post: (input) => new Promise<WebhookResponse>((settle) => {
      const problem = webhookUrlProblem(input.url, options);
      if (problem) return settle({ error: `url_${problem}` });
      const url = new URL(input.url);
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const literal = isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0;
      let done = false;
      const finish = (result: WebhookResponse) => {
        if (done) return;
        done = true;
        settle(result);
      };
      const req = send(url, {
        method: "POST",
        headers: { ...input.headers, "content-length": Buffer.byteLength(input.body).toString() },
        // An IP literal never goes through lookup; the URL policy already judged it.
        ...(literal ? {} : { lookup: guardedLookup as never }),
        signal: input.signal,
      }, (res) => {
        let read = 0;
        res.on("data", (chunk: Buffer) => {
          read += chunk.length;
          if (read > RESPONSE_LIMIT) res.destroy();
        });
        res.on("close", () => finish({ status: res.statusCode ?? 0 }));
        res.on("error", () => finish({ status: res.statusCode ?? 0 }));
      });
      req.on("error", (error: NodeJS.ErrnoException) => {
        if (input.signal.aborted) return finish({ error: "timeout" });
        finish({ error: error.code === "EADDRREFUSED" ? "address_refused" : `network_${(error.code ?? "error").toLowerCase()}` });
      });
      req.end(input.body);
    }),
  };
}
