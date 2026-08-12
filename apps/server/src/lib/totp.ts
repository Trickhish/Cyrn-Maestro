import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/* Time-based one-time passwords, RFC 6238.
 *
 * Implemented directly rather than pulled in: the algorithm is forty lines,
 * the RFC publishes test vectors so correctness is provable rather than
 * assumed, and an authentication primitive is a poor place to inherit a
 * supply chain. The vectors are in totp.test.ts.
 *
 * SHA-1 is the default here and looks alarming, but it is what every
 * authenticator app implements. HMAC-SHA1 is not affected by the collision
 * attacks that broke SHA-1 for signatures, and choosing SHA-256 would leave
 * users unable to add the account to their phone. */

const DIGITS = 6;
const PERIOD_SECONDS = 30;

/* Base32, RFC 4648, no padding — the alphabet authenticator apps expect. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];

  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error("That is not a valid base32 secret.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

/* The counter is the number of whole periods since the epoch, as a 64-bit
   big-endian integer. */
function counterBuffer(counter: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  return buffer;
}

export function hotp(secret: Buffer, counter: number, algorithm = "sha1"): string {
  const digest = createHmac(algorithm, secret).update(counterBuffer(counter)).digest();

  /* Dynamic truncation: the low nibble of the last byte picks where to read a
     four-byte window, and the top bit is masked off so the result is positive
     regardless of platform signedness. */
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function totp(secretBase32: string, at = Date.now(), algorithm = "sha1"): string {
  const counter = Math.floor(at / 1000 / PERIOD_SECONDS);
  return hotp(base32Decode(secretBase32), counter, algorithm);
}

/* Accepts the current code and one period either side.
 *
 * The window is for clock drift between the phone and the server, not
 * convenience — widening it multiplies the number of codes valid at any moment,
 * which is exactly the thing a brute-force attempt is counting. One period
 * each way is the usual compromise. */
export function verifyTotp(secretBase32: string, code: string, at = Date.now()): boolean {
  const cleaned = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;

  const secret = base32Decode(secretBase32);
  const counter = Math.floor(at / 1000 / PERIOD_SECONDS);

  for (const drift of [0, -1, 1]) {
    if (constantTimeEqual(hotp(secret, counter + drift), cleaned)) return true;
  }
  return false;
}

/* The URI an authenticator app reads from a QR code. */
export function otpauthUri(secret: string, account: string, issuer = "Maestro"): string {
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${params}`;
}

/* Recovery codes exist for the day the phone is lost. They are single-use and
   stored hashed, exactly like every other credential here. */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () =>
    randomBytes(5).toString("hex").match(/.{1,5}/g)!.join("-"),
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
