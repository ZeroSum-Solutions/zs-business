import { describe, expect, it } from "vitest";
import { addressBucket, canonicalIp, createClientAddress, trustedProxyList, UNKNOWN_ADDRESS } from "../src/public/client-ip.js";

const headers = (values: Record<string, string>) => (name: string) => values[name.toLowerCase()];

describe("client address (public-intake.md P-10)", () => {
  it("writes each address one way", () => {
    expect(canonicalIp(" 192.0.2.1 ")).toBe("192.0.2.1");
    expect(canonicalIp("192.0.2.1:8080")).toBe("192.0.2.1");
    expect(canonicalIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(canonicalIp("[::FFFF:c000:0201]:443")).toBe("192.0.2.1");
    expect(canonicalIp("2001:DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
    expect(canonicalIp("fe80::1%eth0")).toBe("fe80::1");
    for (const bad of ["", "unknown", "192.0.2", "192.0.2.256", "2001:db8::1::2", "example.com", "1.2.3.4, 5.6.7.8"])
      expect(canonicalIp(bad), bad).toBeNull();
  });

  it("uses the socket address unless the deployment names another source", () => {
    const address = createClientAddress();
    expect(address("192.0.2.9", headers({ "x-forwarded-for": "198.51.100.1", "x-real-ip": "198.51.100.2" }))).toBe("192.0.2.9");
    expect(address("::ffff:192.0.2.9", headers({}))).toBe("192.0.2.9");
    expect(address(undefined, headers({}))).toBe(UNKNOWN_ADDRESS);
  });

  it("reads a platform header, and falls back to the socket when it is missing or unreadable", () => {
    const address = createClientAddress({ header: "x-vercel-forwarded-for" });
    expect(address("10.1.1.1", headers({ "x-vercel-forwarded-for": "198.51.100.7" }))).toBe("198.51.100.7");
    for (const value of [undefined, "", "not-an-ip", "198.51.100.7, 198.51.100.8"]) {
      const read = headers(value === undefined ? {} : { "x-vercel-forwarded-for": value });
      expect(address("10.1.1.1", read)).toBe("10.1.1.1");
    }
    // X-Forwarded-For never counts in this mode.
    expect(address("10.1.1.1", headers({ "x-forwarded-for": "198.51.100.9" }))).toBe("10.1.1.1");
  });

  it("trusts X-Forwarded-For only from listed proxies, walking right to left", () => {
    const address = createClientAddress({ trustedProxies: ["10.0.0.0/8", "fd00::/8"] });
    const xff = (value: string) => headers({ "x-forwarded-for": value });
    // A peer that is not a proxy cannot pick its address with the header.
    expect(address("203.0.113.5", xff("192.0.2.1"))).toBe("203.0.113.5");
    expect(address("10.0.0.1", xff("spoofed, 192.0.2.1"))).toBe("192.0.2.1");
    expect(address("10.0.0.1", xff("192.0.2.66, 192.0.2.1, 10.2.3.4, fd00::5"))).toBe("192.0.2.1");
    // Every hop trusted: the left-most is the best the chain knows.
    expect(address("10.0.0.1", xff("10.9.9.9"))).toBe("10.9.9.9");
    // An unreadable entry stops the walk at the hop that forwarded it.
    expect(address("10.0.0.1", xff("192.0.2.1, garbage, 10.2.3.4"))).toBe("10.2.3.4");
    expect(address("10.0.0.1", xff(""))).toBe("10.0.0.1");
    expect(address("::ffff:10.0.0.1", xff("192.0.2.1"))).toBe("192.0.2.1");
  });

  it("refuses a malformed trusted proxy entry", () => {
    for (const entry of ["10.0.0.0/33", "fd00::/129", "10.0.0.0/8/8", "proxy.internal", "10.0.0.0/x"])
      expect(() => trustedProxyList([entry]), entry).toThrow(/Invalid trusted proxy/);
    expect(trustedProxyList(["10.0.0.0/8", "192.0.2.1", "fd00::/8"]).check("10.4.5.6")).toBe(true);
  });

  it("buckets IPv6 by /64 and IPv4 by address", () => {
    expect(addressBucket("192.0.2.1")).toBe("192.0.2.1");
    expect(addressBucket("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(addressBucket("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(addressBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressBucket("::1")).toBe("0:0:0:0::/64");
    expect(addressBucket(UNKNOWN_ADDRESS)).toBe(UNKNOWN_ADDRESS);
  });
});
