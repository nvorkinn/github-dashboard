import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// The sealed format: one version byte, a 12-byte nonce, the 16-byte tag, then the ciphertext, in base64url. The
// version is there so the format can change later; it is authenticated along with the purpose.
const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypts a value for a cookie with AES-256-GCM. `purpose` names what the value is for, so a value sealed for one
 * cookie doesn't open as another.
 */
export function seal(key: Buffer, purpose: string, value: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(associatedData(purpose));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

/** The value `seal` was given, or nothing if this was changed, sealed with another key or isn't one of ours. */
export function open(key: Buffer, purpose: string, sealed: string): string | undefined {
  const bytes = Buffer.from(sealed, "base64url");
  if (bytes.length < 1 + NONCE_BYTES + TAG_BYTES || bytes[0] !== VERSION) {
    return undefined;
  }
  const nonce = bytes.subarray(1, 1 + NONCE_BYTES);
  const tag = bytes.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
  const ciphertext = bytes.subarray(1 + NONCE_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(associatedData(purpose));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

function associatedData(purpose: string): Buffer {
  return Buffer.from(`${VERSION}:${purpose}`, "utf8");
}

/** A random value nobody can guess, safe in a URL. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Whether two strings are the same, taking the same time whatever they hold. */
export function sameString(a: string, b: string): boolean {
  // Hashing first gives timingSafeEqual the equal lengths it needs.
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** The signature GitHub puts in X-Hub-Signature-256 for a webhook body: its HMAC-SHA256 with the webhook secret. */
export function webhookSignature(secret: string, body: Uint8Array): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * Whether a webhook's signature header is the one its body and the secret give. A missing, short or garbled header
 * is simply wrong: the comparison takes strings of any length and never throws.
 */
export function validWebhookSignature(secret: string, body: Uint8Array, header: string | undefined): boolean {
  return header !== undefined && sameString(header, webhookSignature(secret, body));
}

/** The PKCE challenge for a verifier: its SHA-256, as GitHub's authorize page expects it. */
export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
