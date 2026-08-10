import crypto from "node:crypto";

const TOKEN_PREFIX = "pmweb:v1";

/**
 * Resolve the shared secret used to derive the GitHub-token encryption key.
 *
 * Reads `PM_WEB_SECRET_KEY` first, then falls back to `JWT_SECRET`. Throws when
 * neither is set or the value is shorter than 32 characters, because AES-256
 * under a weak secret would expose stored tokens to offline brute force.
 *
 * @returns The raw secret string (at least 32 characters).
 */
function secretMaterial(): string {
  const value = process.env.PM_WEB_SECRET_KEY || process.env.JWT_SECRET;
  if (!value || value.length < 32) {
    throw new Error("Set PM_WEB_SECRET_KEY or a JWT_SECRET of at least 32 characters before storing GitHub tokens.");
  }
  return value;
}

function encryptionKey(): Buffer {
  return crypto.createHash("sha256").update(secretMaterial(), "utf8").digest();
}

/**
 * Encrypt a secret (a GitHub access token) for at-rest storage.
 *
 * Uses AES-256-GCM with a random 12-byte IV and a key derived as SHA-256 of
 * {@link secretMaterial}. Returns a single self-describing string
 * `pmweb:v1:<iv>:<authTag>:<ciphertext>`; the IV, auth tag, and ciphertext
 * are base64url-encoded, while `pmweb:v1` remains a literal prefix that tags
 * the format for {@link decryptSecret}.
 *
 * @param plainText - The plaintext secret to encrypt.
 * @returns The prefixed, colon-separated token string.
 */
export function encryptSecret(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    TOKEN_PREFIX,
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

/**
 * Decrypt a value previously produced by {@link encryptSecret}.
 *
 * A nullish or empty input returns `null`, and a value without the `pmweb:v1:`
 * prefix is returned unchanged (a legacy plaintext token passes through).
 * Otherwise the IV, auth tag and ciphertext are parsed and decrypted with
 * AES-256-GCM; a malformed string or failed authenticity check throws.
 *
 * @param stored - The stored token string, or null/undefined when none exists.
 * @returns The recovered plaintext, or `null` for a missing value.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!stored.startsWith(`${TOKEN_PREFIX}:`)) {
    return stored;
  }

  const [, , ivRaw, tagRaw, encryptedRaw] = stored.split(":");
  if (!ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error("Stored GitHub token is malformed.");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivRaw, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
