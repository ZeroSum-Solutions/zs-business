import { describe, expect, it } from "vitest";
import { parseVoiceNumberArgs } from "../src/voice-number.js";

const TENANT = "11111111-1111-4111-8111-111111111111";

describe("parseVoiceNumberArgs", () => {
  it("reads a full change", () => {
    expect(parseVoiceNumberArgs([
      "--tenant", TENANT, "--forward-to", "+15555550199", "--ring-seconds", "25",
      "--booking-url", "https://book.example/x", "--disclosure-version", "v2", "--enable",
    ])).toEqual({
      tenantId: TENANT, forwardTo: "+15555550199", ringSeconds: 25, textbackEnabled: true,
      bookingUrl: "https://book.example/x", disclosureVersion: "v2",
    });
  });

  it("reads a removal and refuses extra options with it", () => {
    expect(parseVoiceNumberArgs(["--tenant", TENANT, "--remove"])).toEqual({ tenantId: TENANT, forwardTo: null });
    expect(parseVoiceNumberArgs(["--tenant", TENANT, "--remove", "--forward-to", "+15555550199"])).toBeNull();
  });

  it("refuses bad input", () => {
    expect(parseVoiceNumberArgs(["--tenant", "nope", "--forward-to", "+15555550199"])).toBeNull();
    expect(parseVoiceNumberArgs(["--tenant", TENANT])).toBeNull();
    expect(parseVoiceNumberArgs(["--tenant", TENANT, "--forward-to", "+1", "--enable", "--disable"])).toBeNull();
    expect(parseVoiceNumberArgs(["--tenant", TENANT, "--forward-to", "+1", "--disclosure", "words"])).toBeNull();
    expect(parseVoiceNumberArgs(["--tenant", TENANT, "--forward-to", "+1", "--ring-seconds", "x"])).toBeNull();
  });
});
