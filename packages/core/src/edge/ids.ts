import { createHash } from "node:crypto";

/**
 * Deterministic RFC 9562 version-8 UUID from its parts. The edge derives target and approval
 * IDs from (tenant, idempotency key, purpose), so a replayed request rebuilds the exact
 * command the dispatcher stored and gets the stored result back.
 */
export function derivedId(...parts: readonly string[]): string {
  const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
