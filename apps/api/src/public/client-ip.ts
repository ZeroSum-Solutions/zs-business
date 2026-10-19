// public-intake.md P-10: whose quota a public request spends. A forwarded header counts only
// when the deployment says who writes it; anything else would let a caller pick its own bucket.
import { BlockList, isIP } from "node:net";

export interface ClientIpConfig {
  /**
   * A header the hosting platform overwrites on every request, such as x-vercel-forwarded-for
   * or x-real-ip on Vercel. Only safe when the API is reachable through that platform alone.
   */
  readonly header?: string | undefined;
  /** Peers (CIDR or single address) whose X-Forwarded-For entries are trusted, right to left. */
  readonly trustedProxies?: readonly string[] | undefined;
}

/** Used when no address can be read; every such request shares one bucket. */
export const UNKNOWN_ADDRESS = "unknown";

const IPV4_MAPPED = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * One spelling per address, or null: brackets, an IPv4 port and an IPv6 zone are dropped,
 * IPv6 is compressed and lowercased, and IPv4-mapped IPv6 becomes plain IPv4.
 */
export function canonicalIp(raw: string): string | null {
  let value = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
  if (bracketed) value = bracketed[1]!;
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(value)) value = value.slice(0, value.lastIndexOf(":"));
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return null;
  // The URL parser prints the RFC 5952 form, and prints ::ffff:1.2.3.4 as ::ffff:102:304.
  const compressed = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = IPV4_MAPPED.exec(compressed);
  if (!mapped) return compressed;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/** Parse trusted proxy entries once; a bad entry is a configuration error, not a silent skip. */
export function trustedProxyList(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [address = "", prefix, extra] = entry.trim().split("/");
    const ip = canonicalIp(address);
    if (ip === null || extra !== undefined) throw new Error(`Invalid trusted proxy: ${entry}`);
    const type = isIP(ip) === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) {
      list.addAddress(ip, type);
      continue;
    }
    const bits = /^\d{1,3}$/.test(prefix) ? Number(prefix) : Number.NaN;
    if (!(bits >= 0 && bits <= (type === "ipv4" ? 32 : 128))) throw new Error(`Invalid trusted proxy: ${entry}`);
    list.addSubnet(ip, bits, type);
  }
  return list;
}

const trusted = (list: BlockList, ip: string) => list.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6");

export type HeaderReader = (name: string) => string | undefined;

/**
 * The caller's address. With a platform header: its single value, else the socket. With
 * trusted proxies and a trusted socket peer: walk X-Forwarded-For from the right past
 * trusted hops; the first untrusted entry is the caller, and an unreadable entry stops the
 * walk at the hop that forwarded it. Otherwise the socket address.
 */
export function createClientAddress(config: ClientIpConfig = {}) {
  const header = config.header?.toLowerCase();
  const proxies = config.trustedProxies?.length ? trustedProxyList(config.trustedProxies) : null;
  return (socketAddress: string | undefined, read: HeaderReader): string => {
    const socket = socketAddress === undefined ? null : canonicalIp(socketAddress);
    if (header !== undefined) {
      const value = read(header);
      const ip = value === undefined || value.includes(",") ? null : canonicalIp(value);
      return ip ?? socket ?? UNKNOWN_ADDRESS;
    }
    if (proxies === null || socket === null || !trusted(proxies, socket)) return socket ?? UNKNOWN_ADDRESS;
    const hops = (read("x-forwarded-for") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    let caller = socket;
    for (let index = hops.length - 1; index >= 0; index -= 1) {
      const ip = canonicalIp(hops[index]!);
      if (ip === null) break;
      caller = ip;
      if (!trusted(proxies, ip)) break;
    }
    return caller;
  };
}

/**
 * The rate-limit bucket for an address: IPv4 as is, IPv6 by its /64, since one subscriber
 * usually holds a whole /64 and could otherwise rotate through it for fresh quotas.
 */
export function addressBucket(address: string): string {
  if (isIP(address) !== 6) return address;
  const [head = "", tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = address.includes("::")
    ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return `${groups.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16)).join(":")}::/64`;
}
