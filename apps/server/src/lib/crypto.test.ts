import { expect, test, describe, beforeAll } from "bun:test";

/* config.secretKey() reads the environment at call time, so a key has to exist
   before these run. Set one that is not the real one. */
beforeAll(() => {
  process.env.MAESTRO_SECRET_KEY = "a".repeat(64);
});

const { hashPassword, verifyPassword, newToken, hashToken, encryptSecret, decryptSecret } =
  await import("./crypto");

describe("passwords", () => {
  test("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("Correct horse battery staple", hash)).toBe(false);
  });

  test("salts, so the same password hashes differently every time", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  test("the stored hash is argon2id", async () => {
    expect(await hashPassword("x")).toStartWith("$argon2id$");
  });
});

describe("tokens", () => {
  test("are unique and URL-safe", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newToken()));
    expect(seen.size).toBe(200);
    for (const t of seen) expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("hash deterministically, and the hash is not the token", () => {
    const t = newToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toBe(t);
    expect(hashToken(t)).not.toContain(t);
  });
});

describe("secrets at rest", () => {
  test("round-trips", () => {
    const secret = "sk-not-a-real-key-000";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  test("ciphertext does not contain the plaintext, and repeats differ", () => {
    const secret = "sk-not-a-real-key-000";
    const a = encryptSecret(secret);
    const b = encryptSecret(secret);
    expect(a).not.toContain(secret);
    expect(a).not.toBe(b);
  });

  test("a tampered ciphertext fails instead of decrypting to garbage", () => {
    const stored = encryptSecret("sk-not-a-real-key-000");
    const [v, iv, tag, ct] = stored.split(".");
    const flipped = ct.startsWith("A") ? "B" + ct.slice(1) : "A" + ct.slice(1);
    expect(() => decryptSecret([v, iv, tag, flipped].join("."))).toThrow();
  });

  test("rejects a malformed stored value", () => {
    expect(() => decryptSecret("garbage")).toThrow();
  });
});
