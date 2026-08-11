import { expect, test, describe, beforeAll } from "bun:test";
import { app } from "../app";
import { resetDatabase, jsonPost as json, cookieFrom } from "../test/harness";

beforeAll(resetDatabase);

const GOOD = "a-long-enough-password";

/* Order matters: everything in the first block runs while registration is open,
   and the block after it depends on the first account existing. */
describe("registration, while open", () => {
  test("a short password is rejected, naming the field", async () => {
    const res = await app.request("/api/auth/register", json({ email: "x@x.com", password: "short" }));
    expect(res.status).toBe(400);
    expect((await res.json()).details.password?.[0]).toContain("10 characters");
  });

  test("a malformed email is rejected, naming the field", async () => {
    const res = await app.request("/api/auth/register", json({ email: "not-an-email", password: GOOD }));
    expect(res.status).toBe(400);
    expect((await res.json()).details.email).toBeDefined();
  });

  test("neither rejection created an account", async () => {
    const res = await app.request("/api/auth/session");
    expect((await res.json()).registrationOpen).toBe(true);
  });

  test("the first account becomes the instance admin", async () => {
    const res = await app.request("/api/auth/register", json({ email: "first@x.com", password: GOOD }));
    expect(res.status).toBe(201);
    expect((await res.json()).actor.instanceRole).toBe("instance_admin");
  });
});

describe("registration, once closed", () => {
  test("a second account is refused", async () => {
    const res = await app.request("/api/auth/register", json({ email: "second@x.com", password: GOOD }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("closed");
  });

  test("the instance reports registration as closed", async () => {
    const res = await app.request("/api/auth/session");
    expect((await res.json()).registrationOpen).toBe(false);
  });
});

describe("login", () => {
  test("succeeds with the right password and sets an HttpOnly cookie", async () => {
    const res = await app.request("/api/auth/login", json({ email: "first@x.com", password: GOOD }));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  test("email is case-insensitive", async () => {
    const res = await app.request("/api/auth/login", json({ email: "FIRST@X.COM", password: GOOD }));
    expect(res.status).toBe(200);
  });

  test("fails with the wrong password", async () => {
    const res = await app.request("/api/auth/login", json({ email: "first@x.com", password: "wrong-password-here" }));
    expect(res.status).toBe(401);
  });

  /* A distinct message for "no such user" would turn this endpoint into a way
     to find out which email addresses have accounts. */
  test("an unknown account and a wrong password are indistinguishable", async () => {
    const unknown = await app.request("/api/auth/login", json({ email: "nobody@x.com", password: GOOD }));
    const wrong = await app.request("/api/auth/login", json({ email: "first@x.com", password: "wrong-password-here" }));
    expect(unknown.status).toBe(wrong.status);
    expect(await unknown.json()).toEqual(await wrong.json());
  });
});

describe("sessions", () => {
  test("/me is 401 without a cookie and 200 with one", async () => {
    expect((await app.request("/api/auth/me")).status).toBe(401);

    const login = await app.request("/api/auth/login", json({ email: "first@x.com", password: GOOD }));
    const res = await app.request("/api/auth/me", { headers: { cookie: cookieFrom(login) } });
    expect(res.status).toBe(200);
    expect((await res.json()).actor.email).toBe("first@x.com");
  });

  test("a forged cookie is rejected", async () => {
    const res = await app.request("/api/auth/me", { headers: { cookie: "maestro_session=not-a-real-token" } });
    expect(res.status).toBe(401);
  });

  /* Sessions are rows, not signed blobs, so logout has to actually revoke.
     Clearing the cookie alone would leave the token working if replayed. */
  test("logout revokes the token server-side, not just in the browser", async () => {
    const login = await app.request("/api/auth/login", json({ email: "first@x.com", password: GOOD }));
    const cookie = cookieFrom(login);

    expect((await app.request("/api/auth/me", { headers: { cookie } })).status).toBe(200);
    await app.request("/api/auth/logout", { method: "POST", headers: { cookie } });
    expect((await app.request("/api/auth/me", { headers: { cookie } })).status).toBe(401);
  });
});

describe("routing", () => {
  test("an unknown API path is a JSON 404, not the SPA shell", async () => {
    const res = await app.request("/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("healthz needs no session", async () => {
    expect((await app.request("/healthz")).status).toBe(200);
  });
});
