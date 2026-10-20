// M6 model port (agents.md G-9). Original code. A real adapter arrives with M5; until then the
// only implementation is this deterministic fake, so tests and the cloud never call a model.
import type { FollowUpPrompt } from "@zs/contracts";

/** What the agent asks a model for: one follow-up email for one inquiry. */
export interface FollowUpModel {
  /** Returns the draft's subject and text; the runner trims and validates both. Throws on failure. */
  draft(prompt: FollowUpPrompt): Promise<{ subject: string; body: string }>;
}

export interface FakeFollowUpModel extends FollowUpModel {
  /** Every prompt the fake was given, in order. */
  readonly prompts: FollowUpPrompt[];
}

/**
 * A deterministic stand-in. `answer` replaces the default text for a test; it may throw or
 * return text that fails validation, to exercise G-8's `model_error` and `model_invalid`.
 */
export function createFakeFollowUpModel(
  answer?: (prompt: FollowUpPrompt) => Promise<{ subject: string; body: string }> | { subject: string; body: string },
): FakeFollowUpModel {
  const prompts: FollowUpPrompt[] = [];
  return {
    prompts,
    async draft(prompt) {
      prompts.push(prompt);
      if (answer) return answer(prompt);
      const name = prompt.customerName.split(/\s+/)[0] || "there";
      const when = prompt.booking ? ` about your booking on ${prompt.booking.startsAt.slice(0, 10)}` : "";
      return {
        subject: `Following up from ${prompt.businessName}`,
        body: `Hi ${name},\n\nThanks for getting in touch${when}. Is there anything we can help with before then?\n\n${prompt.businessName}`,
      };
    },
  };
}
