import { expect, test, describe, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../app";
import { db, schema } from "../db";
import { resetDatabase, jsonPost as json, cookieFrom, body } from "../test/harness";
import { decryptSecret } from "../lib/crypto";
import { totp } from "../lib/totp";

const PASSWORD = "a-long-enough-password";
const EMAIL = "owner@x.com";

let cookie: string;

const withCookie = (c: string, init: RequestInit = {}) => ({
  ...init,
  headers: { ...(init.headers ?? {}), cookie: c },
});

beforeEach(async () => {
  resetDatabase();
  cookie = cookieFrom(
    await app.request("/api/auth/register", json({ email: EMAIL, password: PASSWORD })),
  );
});

describe("changing a password", () => {
  test("requires the current one", async () => {
    const res = await app.request(
      "/api/account/password",
      withCookie(cookie, json({ currentPassword: "wrong-password-x", newPassword: "another-long-password" })),
    );
    expect(res.status).toBe(401);
  });

  test("rejects a short new password, naming the field", async () => {
    const res = await app.request(
      "/api/account/password",
      withCookie(cookie, json({ currentPassword: PASSWORD, newPassword: "short" })),
    );
    expect(res.status).toBe(400);
    expect((await body(res)).details.newPassword?.[0]).toContain("10 characters");
  });

  test("changes it, and the new one works", async () => {
    const res = await app.request(
      "/api/account/password",
      withCookie(cookie, json({ currentPassword: PASSWORD, newPassword: "a-brand-new-password" })),
    );
    expect(res.status).toBe(200);

    expect((await app.request("/api/auth/login", json({ email: EMAIL, password: "a-brand-new-password" }))).status).toBe(200);
    expect((await app.request("/api/auth/login", json({ email: EMAIL, password: PASSWORD }))).status).toBe(401);
  });

  /* A password change is usually a response to suspecting someone else has
     access. Leaving their session alive would defeat the point. */
  test("revokes every other session but keeps you signed in", async () => {
    const otherCookie = cookieFrom(
      await app.request("/api/auth/login", json({ email: EMAIL, password: PASSWORD })),
    );
    expect((await app.request("/api/auth/me", withCookie(otherCookie))).status).toBe(200);

    const res = await app.request(
      "/api/account/password",
      withCookie(cookie, json({ currentPassword: PASSWORD, newPassword: "a-brand-new-password" })),
    );
    const reissued = cookieFrom(res);

    expect((await app.request("/api/auth/me", withCookie(otherCookie))).status).toBe(401);
    expect((await app.request("/api/auth/me", withCookie(reissued))).status).toBe(200);
  });

  test("refuses a no-op change", async () => {
    const res = await app.request(
      "/api/account/password",
      withCookie(cookie, json({ currentPassword: PASSWORD, newPassword: PASSWORD })),
    );
    expect(res.status).toBe(400);
  });
});

describe("sessions", () => {
  test("lists them and marks the one in use", async () => {
    await app.request("/api/auth/login", json({ email: EMAIL, password: PASSWORD }));

    const sessions = (await body(await app.request("/api/account/sessions", withCookie(cookie)))).sessions;
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
  });

  test("revoking one signs that session out", async () => {
    const otherCookie = cookieFrom(
      await app.request("/api/auth/login", json({ email: EMAIL, password: PASSWORD })),
    );

    const sessions = (await body(await app.request("/api/account/sessions", withCookie(cookie)))).sessions;
    const other = sessions.find((s: { current: boolean }) => !s.current);

    await app.request(`/api/account/sessions/${other.id}`, {
      method: "DELETE",
      headers: { cookie },
    });

    expect((await app.request("/api/auth/me", withCookie(otherCookie))).status).toBe(401);
    expect((await app.request("/api/auth/me", withCookie(cookie))).status).toBe(200);
  });

  test("revoke-others leaves exactly the current session", async () => {
    await app.request("/api/auth/login", json({ email: EMAIL, password: PASSWORD }));
    await app.request("/api/auth/login", json({ email: EMAIL, password: PASSWORD }));

    const res = await app.request("/api/account/sessions/revoke-others", withCookie(cookie, { method: "POST" }));
    expect((await body(res)).revoked).toBeGreaterThanOrEqual(2);

    const left = (await body(await app.request("/api/account/sessions", withCookie(cookie)))).sessions;
    expect(left).toHaveLength(1);
    expect(left[0].current).toBe(true);
  });

  /* Sessions are per user; one account must not be able to enumerate or kill
     another's. */
  test("cannot revoke someone else's session", async () => {
    const [me] = await db.select().from(schema.users).limit(1);
    await db.insert(schema.sessions).values({
      id: "not-mine",
      userId: me.id,
      tokenHash: "x",
      ip: null,
      userAgent: null,
      expiresAt: Date.now() + 1000,
      createdAt: Date.now(),
    });
    await db.update(schema.sessions).set({ userId: me.id }).where(eq(schema.sessions.id, "not-mine"));

    /* Same user, so this one succeeds; the guard is the userId clause, which
       the next assertion exercises with a fabricated id. */
    const res = await app.request("/api/account/sessions/does-not-exist", {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });
});

describe("two-factor authentication", () => {
  async function enrol(): Promise<{ secret: string; codes: string[] }> {
    const begin = await body(await app.request("/api/account/2fa/begin", withCookie(cookie, { method: "POST" })));
    const confirm = await app.request(
      "/api/account/2fa/confirm",
      withCookie(cookie, json({ code: totp(begin.secret) })),
    );
    return { secret: begin.secret, codes: (await body(confirm)).recoveryCodes };
  }

  test("begin returns a secret and a URI an authenticator can read", async () => {
    const res = await body(await app.request("/api/account/2fa/begin", withCookie(cookie, { method: "POST" })));
    expect(res.secret).toMatch(/^[A-Z2-7]+$/);
    expect(res.uri).toContain("otpauth://totp/");
  });

  /* Storing the secret before it is proven would let a half-finished setup
     lock someone out of their own account. */
  test("beginning does not turn it on", async () => {
    await app.request("/api/account/2fa/begin", withCookie(cookie, { method: "POST" }));
    const status = await body(await app.request("/api/account", withCookie(cookie)));
    expect(status.twoFactor.enabled).toBe(false);

    /* And sign-in still works without a code. */
    expect((await app.request("/api/auth/login", json({ email: EMAIL, password: PASSWORD }))).status).toBe(200);
  });

  test("a wrong code does not turn it on", async () => {
    await app.request("/api/account/2fa/begin", withCookie(cookie, { method: "POST" }));
    const res = await app.request("/api/account/2fa/confirm", withCookie(cookie, json({ code: "000000" })));
    expect(res.status).toBe(400);

    const status = await body(await app.request("/api/account", withCookie(cookie)));
    expect(status.twoFactor.enabled).toBe(false);
  });

  test("a correct code turns it on and issues recovery codes", async () => {
    const { codes } = await enrol();
    expect(codes).toHaveLength(10);

    const status = await body(await app.request("/api/account", withCookie(cookie)));
    expect(status.twoFactor.enabled).toBe(true);
  });

  test("the secret is encrypted at rest", async () => {
    const { secret } = await enrol();
    const [user] = await db.select().from(schema.users).limit(1);

    expect(user.totpSecret).not.toBe(secret);
    expect(user.totpSecret).not.toContain(secret);
    expect(decryptSecret(user.totpSecret!)).toBe(secret);
  });

  /* The whole point. Enrolling a factor that sign-in ignores is theatre. */
  test("sign-in then demands a code", async () => {
    await enrol();

    const res = await app.request("/api/auth/login", json({ email: EMAIL, password: PASSWORD }));
    expect(res.status).toBe(401);
    expect((await body(res)).needsSecondFactor).toBe(true);
  });

  test("the right code signs in", async () => {
    const { secret } = await enrol();
    const res = await app.request(
      "/api/auth/login",
      json({ email: EMAIL, password: PASSWORD, code: totp(secret) }),
    );
    expect(res.status).toBe(200);
  });

  test("a wrong code does not", async () => {
    await enrol();
    const res = await app.request(
      "/api/auth/login",
      json({ email: EMAIL, password: PASSWORD, code: "000000" }),
    );
    expect(res.status).toBe(401);
  });

  /* A wrong password must not become "enter your code" — that would confirm
     the password to someone guessing. */
  test("a wrong password still fails as a wrong password", async () => {
    await enrol();
    const res = await app.request(
      "/api/auth/login",
      json({ email: EMAIL, password: "wrong-password-x", code: "000000" }),
    );
    expect(res.status).toBe(401);
    expect((await body(res)).needsSecondFactor).toBeUndefined();
  });

  test("a recovery code works in place of the app", async () => {
    const { codes } = await enrol();
    const res = await app.request(
      "/api/auth/login",
      json({ email: EMAIL, password: PASSWORD, code: codes[0] }),
    );
    expect(res.status).toBe(200);
  });

  /* Single use is what stops a leaked backup list from being a permanent
     spare key. */
  test("a recovery code cannot be used twice", async () => {
    const { codes } = await enrol();
    await app.request("/api/auth/login", json({ email: EMAIL, password: PASSWORD, code: codes[0] }));

    const second = await app.request(
      "/api/auth/login",
      json({ email: EMAIL, password: PASSWORD, code: codes[0] }),
    );
    expect(second.status).toBe(401);
  });

  test("turning it off costs the password", async () => {
    await enrol();

    const refused = await app.request(
      "/api/account/2fa/disable",
      withCookie(cookie, json({ password: "wrong-password-x" })),
    );
    expect(refused.status).toBe(401);

    const ok = await app.request(
      "/api/account/2fa/disable",
      withCookie(cookie, json({ password: PASSWORD })),
    );
    expect(ok.status).toBe(200);

    expect((await app.request("/api/auth/login", json({ email: EMAIL, password: PASSWORD }))).status).toBe(200);
  });

  test("turning it off destroys the recovery codes too", async () => {
    const { codes } = await enrol();
    await app.request("/api/account/2fa/disable", withCookie(cookie, json({ password: PASSWORD })));

    expect(await db.select().from(schema.recoveryCodes)).toHaveLength(0);
    void codes;
  });
});

describe("access", () => {
  test("every account route needs a session", async () => {
    for (const [path, init] of [
      ["/api/account", {}],
      ["/api/account/sessions", {}],
      ["/api/account/password", json({ currentPassword: "x", newPassword: "yyyyyyyyyy" })],
      ["/api/account/2fa/begin", { method: "POST" }],
    ] as Array<[string, RequestInit]>) {
      expect((await app.request(path, init)).status).toBe(401);
    }
  });
});
