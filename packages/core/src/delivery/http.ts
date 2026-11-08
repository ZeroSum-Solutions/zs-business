// What the Resend and Twilio adapters share: the fetch shape they accept and small readers for the
// provider's answer. A leaf module (imports nothing).

/** The fetch an adapter calls; a test passes its own. */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Reads at most `limit` bytes of the body; a longer body is cut, which parses as unreadable. */
export async function readLimited(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return "";
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The body as JSON, or null when it is not JSON. */
export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The first string `code` on an error or its causes (at most four deep), or null. */
export function connectionCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
