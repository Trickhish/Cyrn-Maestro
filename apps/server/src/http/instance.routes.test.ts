import { expect, test, describe, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../app";
import { db, schema } from "../db";
import { resetDatabase, jsonPost as json, cookieFrom, body } from "../test/harness";
import { hashPassword, decryptSecret } from "../lib/crypto";
import { smtpSettings, invalidateSettings } from "../lib/settings";

const PASSWORD = "a-long-enough-password";
let adminCookie: string;
let userCookie: string;

const withCookie = (c: string, init: RequestInit = {}) => ({
  ...init,
  headers: { ...(init.headers ?? {}), cookie: c },
});

const put = (cookie: string, payload: unknown) =>
  app.request("/api/instance/settings", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

beforeEach(async () => {
  resetDatabase();
  invalidateSettings();

  adminCookie = cookieFrom(
    await app.request("/api/auth/register", json({ email: "admin@x.com", password: PASSWORD })),
  );

  await db.insert(schema.users).values({
    id: crypto.randomUUID(),
    email: "user@x.com",
    passwordHash: await hashPassword(PASSWORD),
    instanceRole: "user",
    status: "active",
    createdAt: Date.now(),
  });
  userCookie = cookieFrom(
    await app.request("/api/auth/login", json({ email: "user@x.com", password: PASSWORD })),
  );
});

describe("who can reach it", () => {
  test("an instance admin can", async () => {
    expect((await app.request("/api/instance/settings", withCookie(adminCookie))).status).toBe(200);
  });

  /* Instance settings are about running the server. Being a regular user — or
     an owner of some organization — has nothing to do with it. */
  test("an ordinary user cannot", async () => {
    expect((await app.request("/api/instance/settings", withCookie(userCookie))).status).toBe(400);
    expect((await put(userCookie, { smtp: { host: "evil.example.com" } })).status).toBe(400);
  });

  test("nobody signed out can", async () => {
    expect((await app.request("/api/instance/settings")).status).toBe(401);
  });
});

describe("SMTP settings", () => {
  test("saving and reading back, without the password", async () => {
    const res = await put(adminCookie, {
      smtp: {
        host: "smtp.example.com",
        port: 587,
        security: "starttls",
        username: "mailer",
        password: "hunter2-and-then-some",
        fromAddress: "maestro@example.com",
        fromName: "Maestro",
      },
    });
    expect(res.status).toBe(200);

    const saved = await body(res);
    expect(saved.smtp.host).toBe("smtp.example.com");
    expect(saved.smtp.passwordSet).toBe(true);
    /* The response says a password exists; it never says what it is. */
    expect(JSON.stringify(saved)).not.toContain("hunter2");
  });

  test("the password is encrypted at rest", async () => {
    await put(adminCookie, {
      smtp: { host: "smtp.example.com", fromAddress: "m@example.com", password: "hunter2-and-then-some" },
    });

    const [row] = await db
      .select()
      .from(schema.instanceSettings)
      .where(eq(schema.instanceSettings.key, "smtp.password"))
      .limit(1);

    expect(row.secret).toBe(true);
    expect(row.value).not.toContain("hunter2");
    expect(decryptSecret(row.value!)).toBe("hunter2-and-then-some");
  });

  /* The interface never receives the password back, so it cannot resubmit it.
     If omitting it cleared the stored one, saving any other field would break
     email until someone retyped the password. */
  test("omitting the password keeps the stored one", async () => {
    await put(adminCookie, {
      smtp: { host: "smtp.example.com", fromAddress: "m@example.com", password: "keep-me-please" },
    });
    await put(adminCookie, { smtp: { host: "smtp2.example.com" } });

    const settings = await smtpSettings();
    expect(settings?.host).toBe("smtp2.example.com");
    expect(settings?.password).toBe("keep-me-please");
  });

  test("an empty password clears it deliberately", async () => {
    await put(adminCookie, {
      smtp: { host: "smtp.example.com", fromAddress: "m@example.com", password: "remove-me-later" },
    });
    await put(adminCookie, { smtp: { password: "" } });

    expect((await smtpSettings())?.password).toBe("");
  });

  test("a malformed from address is rejected", async () => {
    const res = await put(adminCookie, { smtp: { fromAddress: "not-an-address" } });
    expect(res.status).toBe(400);
  });

  test("an out-of-range port is rejected", async () => {
    expect((await put(adminCookie, { smtp: { port: 0 } })).status).toBe(400);
    expect((await put(adminCookie, { smtp: { port: 70000 } })).status).toBe(400);
  });

  /* A half-configured server should read as unconfigured, so callers fail at
     configuration time rather than when someone needs a password reset. */
  test("host without a from address counts as unconfigured", async () => {
    await put(adminCookie, { smtp: { host: "smtp.example.com" } });
    expect(await smtpSettings()).toBeNull();
  });

  test("testing before configuring says what is missing", async () => {
    const res = await app.request(
      "/api/instance/settings/smtp/test",
      withCookie(adminCookie, json({ to: "someone@example.com" })),
    );
    expect(res.status).toBe(400);
    expect((await body(res)).error).toContain("host and a from address");
  });
});

describe("registration policy", () => {
  test("defaults to closed once an account exists", async () => {
    const settings = await body(await app.request("/api/instance/settings", withCookie(adminCookie)));
    expect(settings.registration.open).toBe(false);
  });

  test("an admin can reopen it, and registration follows", async () => {
    await put(adminCookie, { registration: { open: true } });

    const session = await body(await app.request("/api/auth/session"));
    expect(session.registrationOpen).toBe(true);
  });

  /* Reopening and restricting are separate questions: an instance can be open
     to a company's own domain without being open to the internet. */
  test("a domain restriction refuses addresses elsewhere", async () => {
    await put(adminCookie, { registration: { open: true, allowedDomain: "example.com" } });

    const outside = await app.request(
      "/api/auth/register",
      json({ email: "someone@gmail.com", password: PASSWORD }),
    );
    expect(outside.status).toBe(400);
    expect((await body(outside)).error).toContain("example.com");

    const inside = await app.request(
      "/api/auth/register",
      json({ email: "someone@example.com", password: PASSWORD }),
    );
    expect(inside.status).toBe(201);
  });

  /* A closed instance should still say the email was malformed, rather than
     making someone fix one problem at a time. */
  test("validation errors are reported before the policy", async () => {
    const res = await app.request(
      "/api/auth/register",
      json({ email: "not-an-email", password: "short" }),
    );
    expect(res.status).toBe(400);
    expect((await body(res)).details).toBeDefined();
  });

  test("closing it again refuses new accounts", async () => {
    await put(adminCookie, { registration: { open: true } });
    await put(adminCookie, { registration: { open: false } });

    const res = await app.request(
      "/api/auth/register",
      json({ email: "late@x.com", password: PASSWORD }),
    );
    expect(res.status).toBe(400);
  });
});

describe("the audit trail", () => {
  /* Recording which keys changed is useful; recording an SMTP password would
     defeat encrypting it in the first place. */
  test("records the change without the values", async () => {
    await put(adminCookie, {
      smtp: { host: "smtp.example.com", fromAddress: "m@example.com", password: "hunter2-and-then-some" },
    });

    const entries = await db.select().from(schema.auditLog);
    const change = entries.find((e) => e.action === "instance.settings_changed");

    expect(change).toBeDefined();
    expect(JSON.stringify(change)).not.toContain("hunter2");
    expect((change!.metadata as { keys: string[] }).keys).toContain("smtp.password");
  });
});
