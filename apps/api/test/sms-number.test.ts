import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSmsNumberArgs } from "../src/sms-number.js";

const tenant = randomUUID();

describe("pnpm sms:number arguments (T-7)", () => {
  it("reads an assignment with or without the `--` pnpm passes through", () => {
    for (const lead of [[], ["--"]]) {
      expect(parseSmsNumberArgs([...lead, "--tenant", tenant, "--number", "+15555550100"]))
        .toEqual({ tenantId: tenant, phoneNumber: "+15555550100" });
      expect(parseSmsNumberArgs([...lead, "--tenant", tenant, "--number", "+15555550100", "--help-reply", "Halden & Rowe: call 555-0100"]))
        .toEqual({ tenantId: tenant, phoneNumber: "+15555550100", helpReply: "Halden & Rowe: call 555-0100" });
      expect(parseSmsNumberArgs([...lead, "--tenant", tenant, "--remove"])).toEqual({ tenantId: tenant, phoneNumber: null });
    }
  });

  it("refuses anything that is not one assignment or one removal", () => {
    for (const argv of [
      [],
      ["--tenant", "not-a-uuid", "--number", "+15555550100"],
      ["--number", "+15555550100"],
      ["--tenant", tenant],
      ["--tenant", tenant, "--number", "+15555550100", "--remove"],
      ["--tenant", tenant, "--remove", "--help-reply", "Hi"],
      ["--tenant", tenant, "--number", "+15555550100", "extra"],
      ["--tenant", tenant, "--numbr", "+15555550100"],
      ["--tenant", tenant, "--", "--number", "+15555550100"],
    ]) expect(parseSmsNumberArgs(argv), argv.join(" ")).toBeNull();
  });
});
