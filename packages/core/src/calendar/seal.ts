// G-3: sealed refresh tokens. Original code. The API seals with a public key and cannot open;
// only the calendar worker holds the private key. X25519 with a fresh ephemeral key per seal,
// HKDF-SHA-256 to an AES-256-GCM key, and the tenant and connection as additional data, so a
// sealed token opens only for the row it was sealed for.
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

const VERSION = "zsg1";
const SEALED_PATTERN = /^zsg1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,2800})$/;
/** The raw X25519 public key follows this fixed SPKI prefix. */
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export interface SealContext {
  readonly tenantId: string;
  readonly connectionId: string;
}

const aad = (context: SealContext) => Buffer.from(`${VERSION}:${context.tenantId.toLowerCase()}:${context.connectionId.toLowerCase()}`);

function key(shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeral, recipient]), `${VERSION} refresh token`, 32));
}

const rawPublic = (publicKey: KeyObject) => (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(SPKI_PREFIX.length);

/** GOOGLE_TOKEN_PUBLIC_KEY: base64 of the DER SPKI of an X25519 key. Throws on anything else. */
export function parseSealPublicKey(value: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "x25519") throw new Error("The token public key must be an X25519 key");
  return key;
}

/** GOOGLE_TOKEN_PRIVATE_KEY: base64 of the DER PKCS#8 of an X25519 key. Throws on anything else. */
export function parseSealPrivateKey(value: string): KeyObject {
  const key = createPrivateKey({ key: Buffer.from(value, "base64"), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "x25519") throw new Error("The token private key must be an X25519 key");
  return key;
}

/** A new key pair in the variable formats above; for tests and the Mac's one-time setup. */
export function generateSealKeyPair(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync("x25519");
  return {
    publicKey: (pair.publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64"),
    privateKey: (pair.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64"),
  };
}

export function sealRefreshToken(publicKey: KeyObject, context: SealContext, token: string): string {
  if (token.length === 0 || token.length > 2000) throw new Error("A refresh token is 1 to 2000 characters");
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralRaw = rawPublic(ephemeral.publicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(shared, ephemeralRaw, rawPublic(publicKey)), iv);
  cipher.setAAD(aad(context));
  const sealed = Buffer.concat([cipher.update(token, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return [VERSION, ephemeralRaw.toString("base64url"), iv.toString("base64url"), sealed.toString("base64url")].join(".");
}

/** The token, or null when it is malformed, sealed for another row or to another key. */
export function openRefreshToken(privateKey: KeyObject, context: SealContext, sealed: string): string | null {
  const match = SEALED_PATTERN.exec(sealed);
  if (!match) return null;
  try {
    const ephemeralRaw = Buffer.from(match[1]!, "base64url");
    const iv = Buffer.from(match[2]!, "base64url");
    const body = Buffer.from(match[3]!, "base64url");
    if (ephemeralRaw.length !== 32 || iv.length !== 12 || body.length < 17) return null;
    const ephemeral = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, ephemeralRaw]), format: "der", type: "spki" });
    const shared = diffieHellman({ privateKey, publicKey: ephemeral });
    const recipient = rawPublic(createPublicKey(privateKey));
    const decipher = createDecipheriv("aes-256-gcm", key(shared, ephemeralRaw, recipient), iv);
    decipher.setAAD(aad(context));
    decipher.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
