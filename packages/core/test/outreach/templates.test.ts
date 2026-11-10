import { describe, expect, it } from "vitest";
import {
  addressProblem, appendFooter, buildFooter, canonicalJson, contentDigest, formatPostalAddress, campaignVariables, hasUnknownVariable, missingVariables,
  renderTooLong,
  prospectsDigest, renderStep, renderTemplate, templateProblem, unknownVariableProblem, type FooterProfile,
} from "../../src/outreach/templates.js";

const steps = [
  { subject: "Quick idea for {{company}}", body: "Hi {{first_name}}, I noticed {{company}} works in {{industry}}.", delayBusinessDays: 0 },
  { body: "Following up, {{first_name}}.", delayBusinessDays: 3 },
];
const values = { firstName: "Sam", company: "Acme", industry: "Plumbing", opener: null };
const openerSteps = [
  { subject: "Quick idea for {{company}}", body: "Hi {{first_name}},\n\n{{opener}}\n\nI help {{industry}} teams.", delayBusinessDays: 0 },
  { body: "Following up, {{first_name}}.", delayBusinessDays: 3 },
];

describe("templates (OS-5)", () => {
  it("renders first_name, company and industry", () => {
    const step = renderStep(steps, 1, values);
    expect(step).toEqual({ ok: true, subject: "Quick idea for Acme", body: "Hi Sam, I noticed Acme works in Plumbing." });
  });

  it("gives follow-ups `Re: ` plus step 1's rendered subject", () => {
    expect(renderStep(steps, 2, values)).toEqual({ ok: true, subject: "Re: Quick idea for Acme", body: "Following up, Sam." });
  });

  it("renders a value that holds a variable literally, in a single pass", () => {
    const step = renderStep(steps, 1, { firstName: "{{company}}", company: "Acme", industry: "{{first_name}}", opener: null });
    expect(step).toEqual({ ok: true, subject: "Quick idea for Acme", body: "Hi {{company}}, I noticed Acme works in {{first_name}}." });
    expect(renderTemplate("{{first_name}}", { firstName: "{{{{", company: "c", industry: null, opener: null })).toBe("{{{{");
  });

  it("renders {{opener}} as plain text in a body, in the same pass as the other variables", () => {
    const opener = "I read your note on retrofitting boilers in Leeds.";
    expect(renderStep(openerSteps, 1, { ...values, opener })).toEqual({
      ok: true, subject: "Quick idea for Acme", body: `Hi Sam,\n\n${opener}\n\nI help Plumbing teams.`,
    });
    expect(renderStep(openerSteps, 2, { ...values, opener })).toEqual({ ok: true, subject: "Re: Quick idea for Acme", body: "Following up, Sam." });
    expect(campaignVariables(openerSteps)).toEqual(new Set(["first_name", "company", "industry", "opener"]));
  });

  it("renders an opener that holds a variable or braces literally, never scanning it again", () => {
    const opener = "Loved {{company}} and {{opener}} and {{first_name}} {{";
    expect(renderStep(openerSteps, 1, { ...values, opener })).toEqual({
      ok: true, subject: "Quick idea for Acme", body: `Hi Sam,\n\n${opener}\n\nI help Plumbing teams.`,
    });
    expect(renderTemplate("{{opener}}", { ...values, opener: "$& $1 {{" })).toBe("$& $1 {{");
  });

  it("still rejects an unknown variable next to {{opener}}", () => {
    const bad = [{ subject: "s", body: "{{opener}} {{openers}}", delayBusinessDays: 0 }];
    expect(unknownVariableProblem(bad)).toEqual({ path: "steps.0.body", code: "unknown_variable" });
    expect(renderStep(bad, 1, { ...values, opener: "x" })).toEqual({ ok: false, reason: "unknown_variable" });
    for (const spaced of ["{{ opener }}", "{{Opener}}", "{{opener}"]) expect(hasUnknownVariable(spaced), spaced).toBe(true);
  });

  it("refuses to render when the campaign uses {{opener}} and the prospect has none", () => {
    for (const opener of [null, "", "   "])
      expect(renderStep(openerSteps, 1, { ...values, opener })).toEqual({ ok: false, reason: "missing_field" });
    expect(missingVariables(openerSteps, values)).toEqual(["opener"]);
    // A campaign that never uses {{opener}} does not need one.
    expect(missingVariables(steps, values)).toEqual([]);
    expect(renderStep(steps, 1, { ...values, opener: "ignored" }).ok).toBe(true);
  });

  it("applies the render length limit to a body that holds the longest opener", () => {
    const longest = "o".repeat(300);
    expect(renderTooLong(openerSteps, { ...values, opener: longest })).toBe(false);
    const heavy = [{ subject: "s", body: "{{opener}}".repeat(61), delayBusinessDays: 0 }];
    expect(renderTooLong(heavy, { ...values, opener: longest })).toBe(true);
    const inSubject = [{ subject: "{{opener}}{{opener}}", body: "b", delayBusinessDays: 0 }];
    expect(renderTooLong(inSubject, { ...values, opener: longest })).toBe(true);
  });

  it("flags every other brace sequence as an unknown variable", () => {
    for (const bad of ["{{ first_name }}", "{{firstname}}", "{{First_Name}}", "Hi {{", "}} later", "{{unknown}}", "{{first_name}", "{{{{first_name}}"])
      expect(hasUnknownVariable(bad), bad).toBe(true);
    for (const good of ["{{first_name}} {{company}} {{industry}} {{opener}}", "no braces", "single { and } are fine"])
      expect(hasUnknownVariable(good), good).toBe(false);
    expect(unknownVariableProblem([{ subject: "ok", body: "x" }, { body: "Dear {{name}}" }])).toEqual({ path: "steps.1.body", code: "unknown_variable" });
    expect(unknownVariableProblem([{ subject: "{{who}}", body: "x" }])).toEqual({ path: "steps.0.subject", code: "unknown_variable" });
  });

  it("refuses to render when a used variable is empty, and when a value breaks the subject line", () => {
    expect(missingVariables(steps, { ...values, industry: "  " })).toEqual(["industry"]);
    expect(renderStep(steps, 1, { ...values, industry: null })).toEqual({ ok: false, reason: "missing_field" });
    expect(renderStep(steps, 1, { ...values, company: "Acme\nBcc: x@y.z" })).toEqual({ ok: false, reason: "subject_line_break" });
    // A campaign that never uses industry accepts a prospect without one.
    expect(renderStep([{ subject: "Hi {{first_name}}", body: "b" }], 1, { ...values, industry: null }).ok).toBe(true);
  });
});

describe("footer and address guard (OS-6)", () => {
  const profile: FooterProfile = {
    displayName: "Zero Sum", legalName: "Zero Sum Solutions LLC",
    postalAddress: { line1: "100 Example Way", line2: "Suite 4", city: "Los Angeles", region: "CA", postalCode: "90001", country: "US" },
  };

  it("formats the address and appends the footer once", () => {
    expect(formatPostalAddress(profile.postalAddress!)).toBe("100 Example Way\nSuite 4\nLos Angeles, CA 90001");
    expect(formatPostalAddress({ line1: "1 Rue Example", city: "Paris", country: "FR" })).toBe("1 Rue Example\nParis\nFR");
    const footer = buildFooter(profile, "https://hub.example/u/zsu1_token");
    expect(footer).toBe(["--", "Zero Sum Solutions LLC", "100 Example Way", "Suite 4", "Los Angeles, CA 90001",
      'To stop these emails: https://hub.example/u/zsu1_token  (or reply "stop")'].join("\n"));
    expect(buildFooter({ ...profile, legalName: null }, "https://hub.example/u/t").split("\n")[1]).toBe("Zero Sum");
    const body = appendFooter("Hello\n\n", footer);
    expect(body.startsWith("Hello\n\n--\n")).toBe(true);
    expect(body.split("https://hub.example/u/zsu1_token")).toHaveLength(2);
  });

  it("answers the address problems the activation refuses", () => {
    expect(addressProblem({ ...profile, postalAddress: null })).toBe("postal_address_missing");
    expect(addressProblem({ ...profile, postalAddress: { ...profile.postalAddress!, line1: "PLACEHOLDER: postal address" } })).toBe("postal_address_placeholder");
    expect(addressProblem({ ...profile, legalName: "Name placeholder LLC" })).toBe("postal_address_placeholder");
    expect(addressProblem({ ...profile, displayName: "PlaceHolder" })).toBe("postal_address_placeholder");
    expect(addressProblem(profile)).toBeNull();
    expect(templateProblem([{ subject: "s", body: "Replace this Placeholder text" }])).toBe("template_placeholder");
    expect(templateProblem([{ subject: "placeholder", body: "x" }])).toBe("template_placeholder");
    expect(templateProblem(steps)).toBeNull();
  });
});

describe("digests (OS-4, OS-8)", () => {
  const content = { steps, window: { start: "08:00", end: "10:30" }, dailyCapPerMailbox: 20, mailboxIds: ["b", "A"] };

  it("hashes content independent of object key order and mailbox order, and notices every change", () => {
    const digest = contentDigest(content);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(contentDigest({ ...content, mailboxIds: ["a", "B"] })).toBe(digest);
    expect(contentDigest({ ...content, steps: steps.map((step) => ({ delayBusinessDays: step.delayBusinessDays, body: step.body, subject: "subject" in step ? step.subject : undefined })) })).toBe(digest);
    for (const changed of [
      { ...content, dailyCapPerMailbox: 19 }, { ...content, window: { start: "08:00", end: "10:31" } }, { ...content, mailboxIds: ["a"] },
      { ...content, steps: [steps[0]!, { ...steps[1]!, delayBusinessDays: 4 }] }, { ...content, steps: [{ ...steps[0]!, body: "other" }, steps[1]!] },
    ]) expect(contentDigest(changed)).not.toBe(digest);
  });

  it("hashes the sorted id:status of the prospects", () => {
    const a = prospectsDigest([{ id: "2", status: "pending" }, { id: "1", status: "active" }]);
    expect(prospectsDigest([{ id: "1", status: "active" }, { id: "2", status: "pending" }])).toBe(a);
    expect(prospectsDigest([{ id: "1", status: "active" }, { id: "2", status: "active" }])).not.toBe(a);
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: null }] })).toBe('{"a":[2,{"c":null}],"b":1}');
  });
});
