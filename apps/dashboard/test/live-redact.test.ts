import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { afterAll, describe, expect, it } from "vitest";
import { redactJwts, redactingLog } from "../e2e/live/redact";

/** Synthetic JWT, built at runtime so secret scanners do not flag a literal. */
const b64 = (text: string) => Buffer.from(text).toString("base64url");
const JWT = [b64('{"alg":"HS256"}'), b64('{"sub":"owner","app_metadata":{}}'), b64("signature-value")].join(".");
const dir = mkdtempSync(path.join(tmpdir(), "zs-redact-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("live harness logs", () => {
  it("redacts JWT-shaped strings and keeps the rest", () => {
    expect(redactJwts(`Dev JWT (7 days):\n${JWT}\nBearer ${JWT}.`)).toBe("Dev JWT (7 days):\n[redacted JWT]\nBearer [redacted JWT].");
    expect(redactJwts("eyJ is not a token, nor is a.b.c")).toBe("eyJ is not a token, nor is a.b.c");
  });

  it("redacts a token split across chunks before it reaches the file", async () => {
    const file = path.join(dir, "seed.log");
    const log = redactingLog(file);
    log.write(`token: ${JWT.slice(0, 30)}`);
    log.write(`${JWT.slice(30)}\nlast line ${JWT}`);
    log.end();
    await finished(log);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("eyJ");
    expect(text).toBe("token: [redacted JWT]\nlast line [redacted JWT]");
  });
});
