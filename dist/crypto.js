import crypto from "node:crypto";
const TOKEN_PREFIX = "pmweb:v1";
function secretMaterial() {
    const value = process.env.PM_WEB_SECRET_KEY || process.env.JWT_SECRET;
    if (!value || value.length < 32) {
        throw new Error("Set PM_WEB_SECRET_KEY or a JWT_SECRET of at least 32 characters before storing GitHub tokens.");
    }
    return value;
}
function encryptionKey() {
    return crypto.createHash("sha256").update(secretMaterial(), "utf8").digest();
}
export function encryptSecret(plainText) {
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
export function decryptSecret(stored) {
    if (!stored)
        return null;
    if (!stored.startsWith(`${TOKEN_PREFIX}:`)) {
        return stored;
    }
    const [, , ivRaw, tagRaw, encryptedRaw] = stored.split(":");
    if (!ivRaw || !tagRaw || !encryptedRaw) {
        throw new Error("Stored GitHub token is malformed.");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([
        decipher.update(Buffer.from(encryptedRaw, "base64url")),
        decipher.final(),
    ]).toString("utf8");
}
//# sourceMappingURL=crypto.js.map