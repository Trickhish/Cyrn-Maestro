import { Hono } from "hono";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { db, schema } from "../db";
import {
  SESSION_COOKIE,
  createSession,
  sessionCookie,
  isSecureRequest,
} from "../lib/auth";
import {
  hashPassword,
  verifyPassword,
  hashToken,
  encryptSecret,
  decryptSecret,
} from "../lib/crypto";
import { generateSecret, verifyTotp, otpauthUri, generateRecoveryCodes } from "../lib/totp";
import { record } from "../lib/audit";
import { BadRequest, NotFound, requireActor, type Env } from "./context";

export const accountRoutes = new Hono<Env>();

function secureFor(c: { req: { header(name: string): string | undefined; url: string } }): boolean {
  return isSecureRequest({
    forwardedProto: c.req.header("x-forwarded-proto") ?? null,
    url: c.req.url,
  });
}

async function currentUser(actorId: string) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, actorId)).limit(1);
  if (!user) throw new NotFound();
  return user;
}

/* ------------------------------------------------------------------ status */

accountRoutes.get("/", async (c) => {
  const actor = requireActor(c);
  const user = await currentUser(actor.id);

  const [unused] = await db
    .select({ id: schema.recoveryCodes.id })
    .from(schema.recoveryCodes)
    .where(and(eq(schema.recoveryCodes.userId, actor.id), isNull(schema.recoveryCodes.usedAt)))
    .limit(1);

  return c.json({
    email: user.email,
    instanceRole: user.instanceRole,
    createdAt: user.createdAt,
    twoFactor: {
      enabled: Boolean(user.totpEnabledAt),
      enabledAt: user.totpEnabledAt,
      hasRecoveryCodes: Boolean(unused),
    },
  });
});

/* ---------------------------------------------------------------- password */

const ChangePassword = z.object({
  currentPassword: z.string().min(1, "Enter your current password."),
  newPassword: z.string().min(10, "Use at least 10 characters."),
});

accountRoutes.post("/password", async (c) => {
  const actor = requireActor(c);
  const parsed = ChangePassword.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw new BadRequest("Check the form.", z.flattenError(parsed.error).fieldErrors);
  }

  const user = await currentUser(actor.id);

  /* Re-authenticate before changing the credential. Without this, anyone who
     finds an unlocked browser owns the account permanently rather than until
     the session expires. */
  if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
    return c.json({ error: "That is not your current password." }, 401);
  }

  if (parsed.data.currentPassword === parsed.data.newPassword) {
    throw new BadRequest("The new password is the same as the current one.");
  }

  await db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(parsed.data.newPassword) })
    .where(eq(schema.users.id, actor.id));

  /* Every other session dies. A password change is usually a response to
     suspecting someone else has access, and leaving their session alive would
     defeat the point. The current one is reissued so the user is not logged
     out of the tab they are standing in. */
  const currentToken = getCookie(c, SESSION_COOKIE);
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, actor.id));

  const fresh = await createSession(actor.id, {
    ip: c.req.header("x-forwarded-for") ?? undefined,
    userAgent: c.req.header("user-agent") ?? undefined,
  });
  void currentToken;

  c.header("Set-Cookie", sessionCookie(fresh, secureFor(c)));
  await record(null, actor, "auth.password_changed");

  return c.json({ ok: true, otherSessionsRevoked: true });
});

/* ---------------------------------------------------------------- sessions */

accountRoutes.get("/sessions", async (c) => {
  const actor = requireActor(c);
  const currentHash = hashToken(getCookie(c, SESSION_COOKIE) ?? "");

  const rows = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.userId, actor.id))
    .orderBy(desc(schema.sessions.createdAt));

  return c.json({
    sessions: rows.map((row) => ({
      id: row.id,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      /* So the interface can label it rather than inviting someone to revoke
         the session they are using and wonder why they were signed out. */
      current: row.tokenHash === currentHash,
    })),
  });
});

accountRoutes.delete("/sessions/:id", async (c) => {
  const actor = requireActor(c);

  const deleted = await db
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.id, c.req.param("id")), eq(schema.sessions.userId, actor.id)))
    .returning({ id: schema.sessions.id });

  if (deleted.length === 0) throw new NotFound();
  await record(null, actor, "auth.session_revoked", c.req.param("id"));
  return c.json({ ok: true });
});

accountRoutes.post("/sessions/revoke-others", async (c) => {
  const actor = requireActor(c);
  const currentHash = hashToken(getCookie(c, SESSION_COOKIE) ?? "");

  const deleted = await db
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.userId, actor.id), ne(schema.sessions.tokenHash, currentHash)))
    .returning({ id: schema.sessions.id });

  await record(null, actor, "auth.other_sessions_revoked", null, { count: deleted.length });
  return c.json({ revoked: deleted.length });
});

/* --------------------------------------------------------------------- 2FA */

/* Begins enrolment. The secret is stored but not yet active: it becomes real
   only once a code proves the authenticator actually has it, so a half-finished
   setup cannot lock anyone out. */
accountRoutes.post("/2fa/begin", async (c) => {
  const actor = requireActor(c);
  const user = await currentUser(actor.id);

  if (user.totpEnabledAt) {
    throw new BadRequest("Two-factor authentication is already on. Turn it off first.");
  }

  const secret = generateSecret();
  await db
    .update(schema.users)
    .set({ totpSecret: encryptSecret(secret), totpEnabledAt: null })
    .where(eq(schema.users.id, actor.id));

  return c.json({
    secret,
    uri: otpauthUri(secret, user.email),
  });
});

accountRoutes.post("/2fa/confirm", async (c) => {
  const actor = requireActor(c);
  const parsed = z
    .object({ code: z.string().min(6) })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Enter the six-digit code.");

  const user = await currentUser(actor.id);
  if (!user.totpSecret) throw new BadRequest("Start the setup again.");
  if (user.totpEnabledAt) throw new BadRequest("Two-factor authentication is already on.");

  if (!verifyTotp(decryptSecret(user.totpSecret), parsed.data.code)) {
    return c.json({ error: "That code is not right. Check your authenticator and try again." }, 400);
  }

  await db
    .update(schema.users)
    .set({ totpEnabledAt: Date.now() })
    .where(eq(schema.users.id, actor.id));

  /* Issued once, at the moment 2FA becomes real — the point at which losing
     the phone starts to matter. */
  const codes = generateRecoveryCodes();
  await db.delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, actor.id));
  await db.insert(schema.recoveryCodes).values(
    codes.map((code) => ({
      id: crypto.randomUUID(),
      userId: actor.id,
      codeHash: hashToken(code),
      usedAt: null,
      createdAt: Date.now(),
    })),
  );

  await record(null, actor, "auth.2fa_enabled");
  return c.json({ recoveryCodes: codes });
});

accountRoutes.post("/2fa/disable", async (c) => {
  const actor = requireActor(c);
  const parsed = z
    .object({ password: z.string().min(1) })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Enter your password to turn this off.");

  const user = await currentUser(actor.id);

  /* Turning off a second factor is a security downgrade, so it costs the first
     factor to do. */
  if (!(await verifyPassword(parsed.data.password, user.passwordHash))) {
    return c.json({ error: "That password is not right." }, 401);
  }

  await db
    .update(schema.users)
    .set({ totpSecret: null, totpEnabledAt: null })
    .where(eq(schema.users.id, actor.id));
  await db.delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, actor.id));

  await record(null, actor, "auth.2fa_disabled");
  return c.json({ ok: true });
});
