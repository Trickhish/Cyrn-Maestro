import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config";

/* Password hashing uses Bun's built-in argon2id — memory-hard, so a leaked
   database is expensive to attack offline. Bun.password.verify reads the
   parameters out of the stored hash, so raising the cost later does not
   invalidate existing passwords. */

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash, "argon2id");
}

/* Session, node and enrollment tokens are random secrets, not passwords: they
   have full entropy already, so a fast hash is correct here. Argon2 on every
   request would be a self-inflicted denial of service.

   Only the hash is stored. Comparison is constant-time so a token cannot be
   recovered a byte at a time by timing the response. */

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/* Provider credentials at rest.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than yielding garbage that gets sent to a provider as an API key. Stored as
 * iv.tag.ciphertext, all base64url, one column. */

const ENC_VERSION = "v1";

function key(): Buffer {
  const raw = config.secretKey();
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) {
    throw new Error(
      "MAESTRO_SECRET_KEY must be 32 bytes of hex (64 characters). " +
        "Generate one with: openssl rand -hex 32",
    );
  }
  return buf;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENC_VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(
    ".",
  );
}

export function decryptSecret(stored: string): string {
  const [version, ivB64, tagB64, ctB64] = stored.split(".");
  if (version !== ENC_VERSION || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("Stored secret is not in the expected format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
