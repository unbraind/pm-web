/**
 * Encrypt a secret (a GitHub access token) for at-rest storage.
 *
 * Uses AES-256-GCM with a random 12-byte IV and a key derived as SHA-256 of
 * {@link secretMaterial}. Returns a single self-describing string
 * `pmweb:v1:<iv>:<authTag>:<ciphertext>` with every component base64url-encoded,
 * so the prefix tags the format for {@link decryptSecret}.
 *
 * @param plainText - The plaintext secret to encrypt.
 * @returns The prefixed, colon-separated token string.
 */
export declare function encryptSecret(plainText: string): string;
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
export declare function decryptSecret(stored: string | null | undefined): string | null;
