// Connections C-22: sealed Shopify tokens. Original code. AES-256-GCM with a random 96-bit nonce per
// seal and the shop and column as additional data, so a sealed value copied to another row or column
// fails to open. The key is `SHOPIFY_TOKEN_SEAL_KEY` (32 bytes, base64). A previous key opens old rows
// during a rotation; the key id is stored beside the value. Tokens never appear in a thrown message.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

export interface SealKeys {
  readonly current: { readonly id: string; readonly key: Buffer };
  readonly previous?: { readonly id: string; readonly key: Buffer };
}
export interface SealContext {
  readonly shopId: string;
  readonly column: "access" | "refresh";
}
export interface Sealed {
  readonly text: string;
  readonly keyId: string;
}

const VERSION = "zss1";
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const SEALED = /^zss1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{1,4096})$/;

function parseKey(value: string, what: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value) || key.length !== 32) throw new Error(`${what} must be 32 bytes of base64`);
  return key;
}

export function parseSealKeys(input: { current: string; currentId: string; previous?: string; previousId?: string }): SealKeys {
  if (!KEY_ID.test(input.currentId)) throw new Error("The seal key id is 1 to 32 letters, digits, - or _");
  const current = { id: input.currentId, key: parseKey(input.current, "The seal key") };
  if (input.previous === undefined) return { current };
  if (input.previousId === undefined || !KEY_ID.test(input.previousId)) throw new Error("The previous seal key needs its own id");
  if (input.previousId === input.currentId) throw new Error("The previous seal key id must differ from the current one");
  const previous = { id: input.previousId, key: parseKey(input.previous, "The previous seal key") };
  if (previous.key.equals(current.key)) throw new Error("The previous seal key must differ from the current one");
  return { current, previous };
}

const aad = (context: SealContext, keyId: string) => Buffer.from(`${VERSION}|${context.shopId}|${context.column}|${keyId}`);

export function sealToken(keys: SealKeys, context: SealContext, token: string): Sealed {
  const bytes = Buffer.from(token, "utf8");
  if (bytes.length === 0 || bytes.length > 2000) throw new SealError("A token is 1 to 2000 bytes");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.current.key, nonce);
  cipher.setAAD(aad(context, keys.current.id));
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  const text = `${VERSION}.${nonce.toString("base64url")}.${tag.toString("base64url")}.${body.toString("base64url")}`;
  return { text, keyId: keys.current.id };
}

export function openToken(keys: SealKeys, context: SealContext, sealed: Sealed): string {
  const key = [keys.current, keys.previous].find((candidate) => candidate?.id === sealed.keyId);
  if (!key) throw new SealError("No key for this sealed value");
  const match = SEALED.exec(sealed.text);
  if (!match) throw new SealError("Not a sealed value");
  const nonce = Buffer.from(match[1]!, "base64url");
  const tag = Buffer.from(match[2]!, "base64url");
  const body = Buffer.from(match[3]!, "base64url");
  if (nonce.length !== 12 || tag.length !== 16) throw new SealError("Not a sealed value");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.key, nonce);
    decipher.setAAD(aad(context, key.id));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    throw new SealError("The sealed value did not open");
  }
}
