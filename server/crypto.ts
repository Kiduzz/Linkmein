import crypto from "node:crypto";
import { config } from "./config.js";

// AES-256-GCM with a key derived from APP_SECRET. Output: v1.<iv>.<tag>.<ciphertext> (base64url).
const key = crypto.createHash("sha256").update(`linkmein:${config.appSecret}`).digest();

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decrypt(payload: string): string {
  const [version, iv, tag, ciphertext] = payload.split(".");
  if (version !== "v1" || !iv || !tag || ciphertext === undefined) throw new Error("Unrecognized encrypted payload");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Shows enough of a secret to recognize it without revealing it. */
export function maskSecret(secret: string): string {
  if (secret.length <= 12) return "••••";
  return `${secret.slice(0, 7)}…${secret.slice(-4)}`;
}
