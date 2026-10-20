/**
 * agents.md G-1: the follow-up agent's actor ID for one business,
 * `derivedId(tenantId, "followup-agent", "actor")` in core: the SHA-256 of the parts joined by
 * NUL, written as an RFC 9562 version-8 UUID. An agent draft names this ID as its author and has
 * no email, so the Inbox uses it to say the agent wrote it. test/agent-actor.test.ts pins it to
 * core's `agentActorId`.
 *
 * Null where the page has no Web Crypto (served over plain http from another host): the Inbox
 * then falls back to the wording it uses for any author without an email.
 */
export async function agentActorId(tenantId: string, subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null): Promise<string | null> {
  if (!subtle) return null;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode([tenantId, "followup-agent", "actor"].join("\u0000")));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
