import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
const keysSchema = z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/), z.string().regex(/^[A-Za-z0-9+/]{43}=$/));
function keyring() {
  const keys = keysSchema.parse(JSON.parse(process.env.SECRET_ENCRYPTION_KEYS_JSON || "{}"));
  const active = process.env.SECRET_ENCRYPTION_ACTIVE_KEY || "";
  if (!keys[active] || Object.values(keys).some(k => Buffer.from(k, "base64").length !== 32)) throw Error("Secret encryption is not configured.");
  return { keys, active };
}
export function encryptionReady() { try { keyring(); return true; } catch { return false; } }
export function sealSecret(plaintext: string, context: string) {
  const { keys, active } = keyring(), nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keys[active], "base64"), nonce);
  cipher.setAAD(Buffer.from(`marketingbus:v1:${context}`));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", active, nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
export function openSecret(envelope: string, context: string) {
  const { keys } = keyring(), parts = envelope.split(".");
  const [version, keyId, nonce, tag, encrypted] = parts;
  if (parts.length !== 5 || version !== "v1" || !keys[keyId] || Buffer.from(nonce, "base64url").length !== 12 || Buffer.from(tag, "base64url").length !== 16) throw Error("Invalid encrypted secret.");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keys[keyId], "base64"), Buffer.from(nonce, "base64url"));
  decipher.setAAD(Buffer.from(`marketingbus:v1:${context}`)); decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}
