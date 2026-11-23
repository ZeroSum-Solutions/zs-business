import { z } from "zod";
import type { BusinessHours, BusinessPolicy } from "./business.js";
import { WEEKDAYS } from "./business.js";

// Company facts (docs/requirements/business-profile.md BP-19, BP-20): what agents may say about the
// business, read in one place. A fact is known, with who set it and when, or it is not known. A
// prompt carries the words "not known" for a missing fact, never a guess.

/** BP-20: the words a prompt carries for a fact the owner has not set. */
export const NOT_KNOWN = "not known" as const;

/** BP-19: who set a known fact and when; both null when the value was stored before marks existed. */
export interface FactProvenance {
  readonly setBy: string | null;
  readonly setAt: string | null;
}
export type Fact<T> = ({ readonly status: "known"; readonly value: T } & FactProvenance) | { readonly status: "not_known" };

/** BP-19: what `readCompanyFacts` returns. Policies are known as a list; each carries its own mark. */
export interface CompanyFacts {
  readonly name: Fact<string>;
  readonly description: Fact<string>;
  readonly services: Fact<readonly string[]>;
  readonly timeZone: Fact<string>;
  readonly hours: Fact<BusinessHours>;
  readonly tone: Fact<string>;
  readonly policies: { readonly status: "known"; readonly value: readonly BusinessPolicy[] } | { readonly status: "not_known" };
}

const notKnown = z.literal(NOT_KNOWN);
const dayPrompt = z.string();
/**
 * BP-20: the facts as a model sees them: each value, or "not known". Hours read per day as
 * "09:00-17:00" or "closed". Provenance stays out of the prompt: it names people, not the business.
 */
export const companyFactsPromptSchema = z.strictObject({
  name: z.string(),
  description: z.string().or(notKnown),
  services: z.array(z.string()).or(notKnown),
  timeZone: z.string().or(notKnown),
  hours: z.strictObject(Object.fromEntries(WEEKDAYS.map((day) => [day, dayPrompt])) as Record<(typeof WEEKDAYS)[number], typeof dayPrompt>).or(notKnown),
  tone: z.string().or(notKnown),
  policies: z.array(z.strictObject({ title: z.string(), text: z.string() })).or(notKnown),
});
export type CompanyFactsPrompt = z.infer<typeof companyFactsPromptSchema>;

/** BP-20: one fixed sentence every prompt builder adds to its system text. */
export const COMPANY_FACTS_RULE = [
  "The JSON object's \"company\" value holds the business's own facts as its owner set them.",
  `A fact that reads "${NOT_KNOWN}" is not known: do not guess it, and say the business will confirm it.`,
  "Follow the tone note when one is given. Never state an opening time, a policy or a service the facts do not give.",
].join(" ");

/** BP-20: the prompt form of the facts. Pure, so every builder renders them the same way. */
export function companyFactsForPrompt(facts: CompanyFacts): CompanyFactsPrompt {
  const value = <T, R>(fact: Fact<T>, render: (value: T) => R): R | typeof NOT_KNOWN =>
    fact.status === "known" ? render(fact.value) : NOT_KNOWN;
  return {
    // A business always has a name; one that is somehow missing is still said as not known, never invented.
    name: facts.name.status === "known" ? facts.name.value : NOT_KNOWN,
    description: value(facts.description, (text) => text),
    services: value(facts.services, (names) => [...names]),
    timeZone: value(facts.timeZone, (zone) => zone),
    hours: value(facts.hours, (hours) => Object.fromEntries(WEEKDAYS.map((day) => {
      const times = hours[day];
      return [day, times ? `${times.open}-${times.close}` : "closed"];
    })) as Record<(typeof WEEKDAYS)[number], string>),
    tone: value(facts.tone, (text) => text),
    policies: facts.policies.status === "known" ? facts.policies.value.map(({ title, text }) => ({ title, text })) : NOT_KNOWN,
  };
}
