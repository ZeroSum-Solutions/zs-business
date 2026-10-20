// G-3 sealed refresh tokens: only the worker's private key opens a token, and only for the row it
// was sealed for. Keys and tokens are generated at runtime.
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  generateSealKeyPair,
  openRefreshToken,
  parseSealPrivateKey,
  parseSealPublicKey,
  sealRefreshToken,
  type SealContext,
} from "../../src/index.js";

const pair = generateSealKeyPair();
const publicKey = parseSealPublicKey(pair.publicKey);
const privateKey = parseSealPrivateKey(pair.privateKey);
const row = (): SealContext => ({ tenantId: randomUUID(), connectionId: randomUUID() });
const token = (length = 103) => `fake-rt.${randomBytes(length).toString("base64url")}`.slice(0, length);

/** The CHECK on calendar_connections.refresh_token_sealed, read from the migration itself. */
const columnPattern = (() => {
  const sql = readFileSync(new URL("../../../../supabase/migrations/20261020630000_google_calendar.sql", import.meta.url), "utf8");
  const match = /refresh_token_sealed ~ '([^']+)'/.exec(sql);
  if (!match) throw new Error("sealed-shape CHECK not found in the migration");
  return new RegExp(match[1]!);
})();

describe("sealing and opening (G-3)", () => {
  it("round-trips and has the zsg1 shape", () => {
    const context = row();
    const value = token();
    const sealed = sealRefreshToken(publicKey, context, value);
    expect(sealed).toMatch(/^zsg1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain(value);
    expect(openRefreshToken(privateKey, context, sealed)).toBe(value);
  });

  it("seals the same token differently each time (fresh ephemeral key and IV)", () => {
    const context = row();
    const value = token();
    const first = sealRefreshToken(publicKey, context, value);
    const second = sealRefreshToken(publicKey, context, value);
    expect(first).not.toBe(second);
    expect(first.split(".")[1]).not.toBe(second.split(".")[1]);
    expect(openRefreshToken(privateKey, context, second)).toBe(value);
  });

  it("opens only for its own row (the tenant and connection are additional data)", () => {
    const context = row();
    const sealed = sealRefreshToken(publicKey, context, token());
    expect(openRefreshToken(privateKey, { ...context, connectionId: randomUUID() }, sealed)).toBeNull();
    expect(openRefreshToken(privateKey, { ...context, tenantId: randomUUID() }, sealed)).toBeNull();
    expect(openRefreshToken(privateKey, { tenantId: context.connectionId, connectionId: context.tenantId }, sealed)).toBeNull();
    // IDs compare case-insensitively, like the UUIDs they are.
    expect(openRefreshToken(privateKey, { tenantId: context.tenantId.toUpperCase(), connectionId: context.connectionId.toUpperCase() }, sealed))
      .not.toBeNull();
  });

  it("does not open with another key", () => {
    const context = row();
    const sealed = sealRefreshToken(publicKey, context, token());
    expect(openRefreshToken(parseSealPrivateKey(generateSealKeyPair().privateKey), context, sealed)).toBeNull();
  });

  it("refuses any tampered part", () => {
    const context = row();
    const sealed = sealRefreshToken(publicKey, context, token());
    const parts = sealed.split(".");
    const flip = (text: string, at: number) => `${text.slice(0, at)}${text[at] === "A" ? "B" : "A"}${text.slice(at + 1)}`;
    for (const index of [1, 2, 3]) {
      for (const at of [0, Math.floor(parts[index]!.length / 2), parts[index]!.length - 2]) {
        const tampered = parts.map((part, i) => (i === index ? flip(part, at) : part)).join(".");
        expect(openRefreshToken(privateKey, context, tampered), `part ${index} at ${at}`).toBeNull();
      }
    }
    // Dropping the tag's last bytes, or appending bytes, fails too.
    expect(openRefreshToken(privateKey, context, sealed.slice(0, -4))).toBeNull();
    expect(openRefreshToken(privateKey, context, `${sealed}AAAA`)).toBeNull();
  });

  it("returns null for malformed input instead of throwing", () => {
    const context = row();
    const good = sealRefreshToken(publicKey, context, token()).split(".");
    const malformed = [
      "",
      "zsg1",
      "zsg2." + good.slice(1).join("."),
      good.slice(0, 3).join("."),
      [...good, "extra"].join("."),
      [good[0], good[1]!.slice(1), good[2], good[3]].join("."),
      [good[0], good[1], `${good[2]}A`, good[3]].join("."),
      [good[0], good[1], good[2], "A".repeat(21)].join("."),
      [good[0], "+".repeat(43), good[2], good[3]].join("."),
      [good[0], "A".repeat(43), good[2], good[3]].join("."),
      `${good.join(".")} `,
      `zsg1.${"A".repeat(43)}.${"A".repeat(16)}.${"A".repeat(2801)}`,
    ];
    for (const value of malformed) expect(openRefreshToken(privateKey, context, value), value.slice(0, 40)).toBeNull();
  });

  it("accepts 1 to 2000 bytes of token and refuses the rest", () => {
    const context = row();
    expect(() => sealRefreshToken(publicKey, context, "")).toThrow(/1 to 2000/);
    expect(() => sealRefreshToken(publicKey, context, "a".repeat(2001))).toThrow(/1 to 2000/);
    // UTF-8 bytes count, not characters: this one would not fit the sealed shape.
    expect(() => sealRefreshToken(publicKey, context, "é".repeat(1001))).toThrow(/1 to 2000/);
    const one = sealRefreshToken(publicKey, context, "x");
    expect(openRefreshToken(privateKey, context, one)).toBe("x");
    const multi = "é".repeat(1000);
    expect(openRefreshToken(privateKey, context, sealRefreshToken(publicKey, context, multi))).toBe(multi);
  });

  it("fits the column's CHECK, from the shortest to a 2000-character token", () => {
    const context = row();
    for (const length of [1, 100, 512, 1999, 2000]) {
      const sealed = sealRefreshToken(publicKey, context, "t".repeat(length));
      expect(sealed, `length ${length}`).toMatch(columnPattern);
      expect(openRefreshToken(privateKey, context, sealed)).toBe("t".repeat(length));
    }
  });
});

describe("key parsing", () => {
  it("round-trips generated keys", () => {
    const keys = generateSealKeyPair();
    expect(parseSealPublicKey(keys.publicKey).asymmetricKeyType).toBe("x25519");
    expect(parseSealPrivateKey(keys.privateKey).asymmetricKeyType).toBe("x25519");
    expect(keys.publicKey).not.toBe(pair.publicKey);
  });

  it("refuses keys that are not X25519, swapped keys and junk", () => {
    const der = (type: "ed25519" | "x448" | "ec") => {
      const generated = type === "ec"
        ? generateKeyPairSync("ec", { namedCurve: "P-256" })
        : type === "ed25519" ? generateKeyPairSync("ed25519") : generateKeyPairSync("x448");
      return {
        publicKey: (generated.publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64"),
        privateKey: (generated.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64"),
      };
    };
    for (const type of ["ed25519", "x448", "ec"] as const) {
      const other = der(type);
      expect(() => parseSealPublicKey(other.publicKey), type).toThrow();
      expect(() => parseSealPrivateKey(other.privateKey), type).toThrow();
    }
    expect(() => parseSealPublicKey(pair.privateKey)).toThrow();
    expect(() => parseSealPrivateKey(pair.publicKey)).toThrow();
    for (const junk of ["", "not base64 at all", randomBytes(44).toString("base64")]) {
      expect(() => parseSealPublicKey(junk)).toThrow();
      expect(() => parseSealPrivateKey(junk)).toThrow();
    }
  });
});
