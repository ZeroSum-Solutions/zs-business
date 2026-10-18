import { describe, expect, it } from "vitest";
import { parseServerEnv, PLACEHOLDER_JWT_SECRET } from "../src/config.js";
import { SECRET } from "./helpers.js";

const base = { DATABASE_URL: "postgres://zs_runtime@127.0.0.1:55432/zs_dev", JWT_SECRET: SECRET };

describe("parseServerEnv", () => {
  it("refuses the .env.example placeholder secret", () => {
    expect(() => parseServerEnv({ ...base, JWT_SECRET: PLACEHOLDER_JWT_SECRET })).toThrow(/placeholder/);
  });

  it("defaults to a one-hour token lifetime and no issuer", () => {
    expect(parseServerEnv(base)).toMatchObject({ jwtMaxLifetimeSeconds: 3600, jwtIssuer: undefined, port: 8787 });
  });

  it("lets local dev raise the lifetime and set an issuer", () => {
    expect(parseServerEnv({ ...base, JWT_MAX_TTL_SECONDS: "604800", JWT_ISSUER: "https://example.supabase.co/auth/v1" }))
      .toMatchObject({ jwtMaxLifetimeSeconds: 604800, jwtIssuer: "https://example.supabase.co/auth/v1" });
  });

  it.each(["0", "abc", String(31 * 24 * 3600)])("refuses JWT_MAX_TTL_SECONDS=%s", (value) => {
    expect(() => parseServerEnv({ ...base, JWT_MAX_TTL_SECONDS: value })).toThrow(/JWT_MAX_TTL_SECONDS/);
  });
});
