// Company facts (docs/requirements/business-profile.md BP-19, BP-21): the one read every agent prompt
// builder uses for what the business is, says and does. A guard test (packages/core/test/company-facts.test.ts)
// fails when a prompt builder reads the profile or the tenant's name any other way.
import type { CompanyFacts, Fact, FactMark, FactMarks } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { getBusinessProfile } from "./handlers.js";

const provenance = (mark: FactMark | undefined) => ({ setBy: mark?.setBy ?? null, setAt: mark?.setAt ?? null });
const known = <T>(value: T, mark: FactMark | undefined): Fact<T> => ({ status: "known", value, ...provenance(mark) });
const notKnown = { status: "not_known" } as const;

/** BP-19: the tenant's facts with who set each. An empty list or a null value is not known, never a default. */
export async function readCompanyFacts(tx: Transaction, tenantId: string): Promise<CompanyFacts> {
  const profile = await getBusinessProfile(tx, tenantId);
  const marks: FactMarks = profile.factMarks;
  return {
    name: known(profile.displayName, marks.displayName),
    description: profile.description === null ? notKnown : known(profile.description, marks.description),
    services: profile.services.length === 0 ? notKnown : known(profile.services, marks.services),
    timeZone: profile.timeZone === null ? notKnown : known(profile.timeZone, marks.timeZone),
    hours: profile.hours === null ? notKnown : known(profile.hours, marks.hours),
    tone: profile.tone === null ? notKnown : known(profile.tone, marks.tone),
    policies: profile.policies.length === 0 ? notKnown : { status: "known", value: profile.policies },
  };
}
