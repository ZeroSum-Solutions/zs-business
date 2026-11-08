// Connections C-24, S8: the HMAC on a Shopify webhook. The tag is the base64 HMAC-SHA256 of the raw
// body bytes under the client secret (the previous one during a rotation), compared in constant time
// on equal-length buffers. A missing, short or non-base64 header is simply not equal.
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhookHmac(secrets: { readonly current: string; readonly previous?: string }, rawBody: Uint8Array, header: string | null | undefined): boolean {
  if (header === null || header === undefined || !/^[A-Za-z0-9+/]{43}=$/.test(header)) return false;
  const given = Buffer.from(header, "base64");
  if (given.length !== 32) return false;
  let valid = false;
  for (const secret of [secrets.current, secrets.previous]) {
    if (secret === undefined) continue;
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    if (timingSafeEqual(given, expected)) valid = true;
  }
  return valid;
}
