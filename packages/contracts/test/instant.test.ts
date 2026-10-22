import { describe, expect, it } from "vitest";
import {
  consentEvidenceSchema,
  contactRecordSchema,
  observeSourceInputSchema,
  sourceRecordSchema,
  storedInstantSchema,
  supportedInstantSchema,
} from "../src/index.js";

describe("supported instant range", () => {
  it("accepts UTC years 0001 through 9999 at millisecond precision, leap days included", () => {
    for (const instant of ["0001-01-01T00:00:00.000Z", "2024-02-29T12:34:56.789Z", "2000-02-29T00:00:00.000Z", "9999-12-31T23:59:59.999Z"])
      expect(supportedInstantSchema.safeParse(instant).success).toBe(true);
  });

  it("refuses year 0000, impossible dates, offsets and other precisions", () => {
    for (const instant of [
      "0000-01-01T00:00:00.000Z", "0000-02-29T12:34:56.789Z", "0000-12-31T23:59:59.999Z",
      "2023-02-29T00:00:00.000Z", "1900-02-29T00:00:00.000Z", "2024-01-01T00:00:00.000+01:00",
      "2024-01-01T00:00:00Z", "2024-01-01T00:00:00.000000Z", "+010000-01-01T00:00:00.000Z",
    ]) expect(supportedInstantSchema.safeParse(instant).success).toBe(false);
  });

  it("is the rule for CRM consent evidence and source observations", () => {
    expect(consentEvidenceSchema.safeParse({ status: "granted", source: "owner", recordedAt: "0000-01-01T00:00:00.000Z" }).success)
      .toBe(false);
    expect(observeSourceInputSchema.shape.observedAt.safeParse("0000-01-01T00:00:00.000Z").success).toBe(false);
  });

  it("is tolerant on output: records accept any stored UTC instant with milliseconds", () => {
    const legacy = "0000-12-31T23:59:02.000Z";
    expect(storedInstantSchema.safeParse(legacy).success).toBe(true);
    for (const malformed of ["2024-01-01T00:00:00Z", "2024-01-01T00:00:00.000+01:00", "not a time"])
      expect(storedInstantSchema.safeParse(malformed).success).toBe(false);
    const id = "00000000-0000-4000-8000-000000000001";
    expect(contactRecordSchema.safeParse({
      id, tenantId: id, displayName: null, email: "a@example.com", phone: null,
      consent: { email: { status: "granted", source: "owner", recordedAt: legacy }, sms: null }, createdAt: legacy, updatedAt: legacy,
    }).success).toBe(true);
    expect(sourceRecordSchema.safeParse({
      id, tenantId: id, subject: { type: "contact", id }, source: "website", sourceRef: null, observedAt: legacy,
      freshUntil: legacy, fresh: false, revision: 1, recordedBy: id, recordedAt: legacy, updatedAt: legacy,
    }).success).toBe(true);
  });
});
