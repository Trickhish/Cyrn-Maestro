import { expect, test, describe } from "bun:test";
import {
  base32Encode,
  base32Decode,
  hotp,
  totp,
  verifyTotp,
  generateSecret,
  generateRecoveryCodes,
  otpauthUri,
} from "./totp";

/* Published test vectors, so this implementation is verified rather than
   trusted. If any of these fail, the code an authenticator app produces will
   not match what the server expects, and nobody will be able to sign in. */

describe("RFC 4226 — HOTP vectors", () => {
  /* Appendix D, secret "12345678901234567890". */
  const secret = Buffer.from("12345678901234567890", "ascii");
  const expected = [
    "755224", "287082", "359152", "969429", "338314",
    "254676", "287922", "162583", "399871", "520489",
  ];

  for (const [counter, code] of expected.entries()) {
    test(`counter ${counter} → ${code}`, () => {
      expect(hotp(secret, counter)).toBe(code);
    });
  }
});

describe("RFC 6238 — TOTP vectors", () => {
  /* Appendix B. The published table uses an 8-digit code; this implementation
     emits 6, which is what authenticator apps use, so each expectation is the
     last six digits of the published value. */
  const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));

  const vectors: Array<[number, string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ];

  for (const [seconds, code] of vectors) {
    test(`t=${seconds} → ${code}`, () => {
      expect(totp(secret, seconds * 1000)).toBe(code);
    });
  }
});

describe("base32", () => {
  /* RFC 4648 section 10, minus the padding this implementation omits. */
  const vectors: Array<[string, string]> = [
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ];

  for (const [plain, encoded] of vectors) {
    test(`${JSON.stringify(plain)} ↔ ${encoded}`, () => {
      expect(base32Encode(Buffer.from(plain))).toBe(encoded);
      expect(base32Decode(encoded).toString()).toBe(plain);
    });
  }

  test("rejects characters outside the alphabet", () => {
    /* 0, 1 and 8 are excluded precisely because they are misread as O, I and B. */
    expect(() => base32Decode("ABC0")).toThrow();
  });

  test("tolerates lowercase and spacing, as typed by a human", () => {
    expect(base32Decode("mzxw 6ytb oi").toString()).toBe("foobar");
  });
});

describe("verification", () => {
  const secret = generateSecret();

  test("accepts the current code", () => {
    const now = Date.now();
    expect(verifyTotp(secret, totp(secret, now), now)).toBe(true);
  });

  /* Phones drift. One period either way is the usual compromise. */
  test("accepts one period either side, for clock drift", () => {
    const now = Date.now();
    expect(verifyTotp(secret, totp(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totp(secret, now + 30_000), now)).toBe(true);
  });

  /* Widening the window multiplies the codes valid at any instant, which is
     the number a brute-force attempt is counting on. */
  test("rejects codes further out than that", () => {
    const now = Date.now();
    expect(verifyTotp(secret, totp(secret, now - 90_000), now)).toBe(false);
    expect(verifyTotp(secret, totp(secret, now + 90_000), now)).toBe(false);
  });

  test("rejects malformed input without throwing", () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 56 78"]) {
      expect(verifyTotp(secret, bad)).toBe(false);
    }
  });

  test("rejects a code from a different secret", () => {
    const other = generateSecret();
    const now = Date.now();
    expect(verifyTotp(secret, totp(other, now), now)).toBe(false);
  });
});

describe("secrets and recovery codes", () => {
  test("secrets are unique and decodable", () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateSecret()));
    expect(seen.size).toBe(100);
    for (const secret of seen) expect(base32Decode(secret).length).toBe(20);
  });

  test("recovery codes are unique and readable", () => {
    const codes = generateRecoveryCodes(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9a-f]{5}-[0-9a-f]{5}$/);
  });
});

describe("the URI an authenticator reads", () => {
  test("carries the secret, issuer and parameters", () => {
    const uri = otpauthUri("JBSWY3DPEHPK3PXP", "alice@example.com");
    expect(uri).toStartWith("otpauth://totp/Maestro:alice%40example.com?");
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=Maestro");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
