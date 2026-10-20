// agents.md G-1: the dashboard derives the follow-up agent's actor ID exactly as core does, so
// the Inbox can name the agent as the author of its drafts.
import { describe, expect, it } from "vitest";
import { agentActorId as coreAgentActorId } from "@zs/core";
import { agentActorId } from "../src/lib/agent-actor";
import { DEMO_AGENT_ACTOR_ID, DEMO_TENANT_ID } from "../src/lib/api/demo/seed";

describe("agent actor ID", () => {
  it("matches core's agentActorId for any tenant", async () => {
    for (const tenant of [DEMO_TENANT_ID, "00000000-0000-4000-8000-000000000001", "f47ac10b-58cc-4372-a567-0e02b2c3d479"]) {
      expect(await agentActorId(tenant)).toBe(coreAgentActorId(tenant));
    }
  });

  it("is the demo seed's agent author", async () => {
    expect(await agentActorId(DEMO_TENANT_ID)).toBe(DEMO_AGENT_ACTOR_ID);
  });

  it("is null without Web Crypto", async () => {
    expect(await agentActorId(DEMO_TENANT_ID, null)).toBeNull();
  });
});
