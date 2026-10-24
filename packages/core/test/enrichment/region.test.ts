// enrichment.md E-7, E-13: the refused region is one list; every prefix, ccTLD and country is checked
// from it, and the signal order is fixed.
import { describe, expect, it } from "vitest";
import {
  domainInRefusedRegion,
  ENRICHMENT_REFUSED_REGION,
  phoneInRefusedRegion,
  refusedCountryInLocation,
  regionVerdict,
} from "../../src/index.js";

const none = { phone: null, country: null, companyDomain: null, emailDomain: null, attested: false };

describe("the refused region list", () => {
  it("covers the EU 27, Iceland, Liechtenstein, Norway and the UK with its dependencies", () => {
    const codes = new Set(ENRICHMENT_REFUSED_REGION.map((country) => country.code));
    for (const code of ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"])
      expect(codes.has(code), code).toBe(true);
    for (const code of ["IS", "LI", "NO", "GB", "GG", "JE", "IM", "GI"]) expect(codes.has(code), code).toBe(true);
    expect(ENRICHMENT_REFUSED_REGION.filter((country) => ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"].includes(country.code))).toHaveLength(27);
  });

  it("refuses every listed calling prefix and every listed ccTLD", () => {
    for (const country of ENRICHMENT_REFUSED_REGION) {
      for (const prefix of country.prefixes) expect(phoneInRefusedRegion(`${prefix}1234567`), `${country.code} ${prefix}`).toBe(true);
      for (const tld of country.tlds) expect(domainInRefusedRegion(`firma.${tld}`), `${country.code} .${tld}`).toBe(true);
    }
    expect(domainInRefusedRegion("firma.eu")).toBe(true);
    expect(domainInRefusedRegion("FIRMA.DE")).toBe(true);
  });

  it("does not refuse outside numbers or domains, nor a label that only looks like a ccTLD", () => {
    for (const phone of ["+14155550123", "+12125550123", "+61412345678", "+81312345678", "+5215512345678", "+919812345678"])
      expect(phoneInRefusedRegion(phone), phone).toBe(false);
    for (const domain of ["acme.com", "acme.example", "acme.io", "de.acme.com", "acme.co.jp", "acme.com.au"]) expect(domainInRefusedRegion(domain), domain).toBe(false);
    expect(domainInRefusedRegion("localhost")).toBe(false);
    expect(domainInRefusedRegion(null)).toBe(false);
    expect(phoneInRefusedRegion(null)).toBe(false);
  });
});

describe("signal order (E-7)", () => {
  it("a refused phone, country or domain blocks even when the owner attested", () => {
    expect(regionVerdict({ ...none, phone: "+447700900123", attested: true })).toBe("blocked");
    expect(regionVerdict({ ...none, country: "FR", attested: true })).toBe("blocked");
    expect(regionVerdict({ ...none, companyDomain: "firma.de", attested: true, phone: "+14155550123" })).toBe("blocked");
    expect(regionVerdict({ ...none, emailDomain: "firma.nl", phone: "+14155550123" })).toBe("blocked");
  });

  it("an outside phone or a known outside country, or an owner mark, passes", () => {
    expect(regionVerdict({ ...none, phone: "+14155550123", companyDomain: "acme.com" })).toBe("outside");
    expect(regionVerdict({ ...none, country: "US" })).toBe("outside");
    expect(regionVerdict({ ...none, attested: true })).toBe("outside");
  });

  it("no signal at all is unknown, which is refused", () => {
    expect(regionVerdict({ ...none, companyDomain: "acme.com", emailDomain: "acme.com" })).toBe("unknown");
  });
});

describe("a location in an answer (E-13)", () => {
  it("finds a refused country by name, alias or trailing code", () => {
    expect(refusedCountryInLocation("Paris, France")).toBe("FR");
    expect(refusedCountryInLocation("Munich, Deutschland")).toBe("DE");
    expect(refusedCountryInLocation("London, England, United Kingdom")).toBe("GB");
    expect(refusedCountryInLocation("Lyon, FR")).toBe("FR");
    expect(refusedCountryInLocation("  AMSTERDAM ; The Netherlands ")).toBe("NL");
  });
  it("leaves an outside location alone", () => {
    expect(refusedCountryInLocation("Austin, Texas, United States")).toBeNull();
    expect(refusedCountryInLocation("Toronto, Canada")).toBeNull();
    expect(refusedCountryInLocation("")).toBeNull();
  });
});
