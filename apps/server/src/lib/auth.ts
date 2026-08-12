import { eq, and, gt, count, isNull } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../config";
import { hashPassword, verifyPassword, newToken, hashToken, decryptSecret } from "./crypto";
import { verifyTotp } from "./totp";
import { registrationPolicy } from "./settings";

export interface Actor {
  id: string;
  email: string;
  instanceRole: "instance_admin" | "user";
}

export const SESSION_COOKIE = "maestro_session";

/* Registration is open until the first account exists — a fresh self-hosted
   instance should not be a land grab — and after that only if an instance
   administrator deliberately reopens it. */
export async function registrationOpen(): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(schema.users);
  if ((row?.n ?? 0) === 0) return true;

  return (await registrationPolicy()).open;
}

/* Whether this particular address may register, which is a separate question
   from whether registration is open at all: an admin can reopen it and still
   restrict it to one domain. */
export async function mayRegister(email: string): Promise<{ ok: boolean; reason?: string }> {
  if (!(await registrationOpen())) {
    return {
      ok: false,
      reason: "Registration is closed on this instance. Ask an administrator for an invitation.",
    };
  }

  const { allowedDomain } = await registrationPolicy();
  if (!allowedDomain) return { ok: true };

  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  if (domain !== allowedDomain.toLowerCase()) {
    return { ok: false, reason: `Only ${allowedDomain} addresses can register on this instance.` };
  }

  return { ok: true };
}

export async function createUser(email: string, password: string): Promise<Actor> {
  const normalized = email.trim().toLowerCase();
  const first = await registrationOpen();

  const user = {
    id: crypto.randomUUID(),
    email: normalized,
    passwordHash: await hashPassword(password),
    instanceRole: (first ? "instance_admin" : "user") as Actor["instanceRole"],
    status: "active" as const,
    createdAt: Date.now(),
  };

  await db.insert(schema.users).values(user);
  return { id: user.id, email: user.email, instanceRole: user.instanceRole };
}

export interface AuthOutcome {
  actor: Actor | null;
  /* The password was right but a second factor is required and was not
     supplied or did not match. Distinct from a plain failure so the interface
     can ask for a code rather than claim the password was wrong. */
  needsSecondFactor?: boolean;
}

export async function authenticate(email: string, password: string): Promise<Actor | null> {
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email.trim().toLowerCase()))
    .limit(1);

  /* Verify against a dummy hash when the account does not exist, so "no such
     user" and "wrong password" take the same time and cannot be told apart. */
  if (!user) {
    await verifyPassword(password, DUMMY_HASH);
    return null;
  }
  if (user.status !== "active") return null;
  if (!(await verifyPassword(password, user.passwordHash))) return null;

  return { id: user.id, email: user.email, instanceRole: user.instanceRole };
}

/* Full sign-in, including the second factor when the account has one.
 *
 * The code is checked here rather than in the route so there is exactly one
 * path that can mint a session — a second path that skipped the factor would
 * be an authentication bypass nobody would notice until it mattered. */
export async function authenticateFully(
  email: string,
  password: string,
  code: string | undefined,
): Promise<AuthOutcome> {
  const actor = await authenticate(email, password);
  if (!actor) return { actor: null };

  const [user] = await db
    .select({ totpSecret: schema.users.totpSecret, totpEnabledAt: schema.users.totpEnabledAt })
    .from(schema.users)
    .where(eq(schema.users.id, actor.id))
    .limit(1);

  if (!user?.totpEnabledAt || !user.totpSecret) return { actor };

  if (!code) return { actor: null, needsSecondFactor: true };

  if (verifyTotp(decryptSecret(user.totpSecret), code)) return { actor };

  /* A recovery code is single-use: burning it on use is what stops a leaked
     backup list from being a permanent spare key. */
  if (await consumeRecoveryCode(actor.id, code)) return { actor };

  return { actor: null, needsSecondFactor: true };
}

async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  const normalised = code.trim().toLowerCase();
  const consumed = await db
    .update(schema.recoveryCodes)
    .set({ usedAt: Date.now() })
    .where(
      and(
        eq(schema.recoveryCodes.userId, userId),
        eq(schema.recoveryCodes.codeHash, hashToken(normalised)),
        isNull(schema.recoveryCodes.usedAt),
      ),
    )
    .returning({ id: schema.recoveryCodes.id });

  return consumed.length > 0;
}

const DUMMY_HASH = await hashPassword(newToken());

export async function createSession(
  userId: string,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<string> {
  const token = newToken();
  await db.insert(schema.sessions).values({
    id: crypto.randomUUID(),
    userId,
    tokenHash: hashToken(token),
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
    expiresAt: Date.now() + config.sessionTtlMs,
    createdAt: Date.now(),
  });
  return token;
}

export async function actorForToken(token: string | undefined): Promise<Actor | null> {
  if (!token) return null;

  const [row] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      instanceRole: schema.users.instanceRole,
      status: schema.users.status,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(
      and(
        eq(schema.sessions.tokenHash, hashToken(token)),
        gt(schema.sessions.expiresAt, Date.now()),
      ),
    )
    .limit(1);

  if (!row || row.status !== "active") return null;
  return { id: row.id, email: row.email, instanceRole: row.instanceRole };
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hashToken(token)));
}

/* Secure is decided per request, not from configuration.
 *
 * A Secure cookie is silently dropped by the browser over plain HTTP, so
 * deriving the flag from MAESTRO_PUBLIC_URL means anyone reaching the server
 * directly on http://127.0.0.1 — which is exactly what happens during local
 * development against a production .env — can log in successfully and then
 * appear logged out, with nothing in any log to say why.
 *
 * Behind a reverse proxy the connection to the server is plain HTTP even when
 * the browser used HTTPS, so X-Forwarded-Proto is what actually reflects the
 * user's connection. */
export function isSecureRequest(headers: {
  forwardedProto?: string | null;
  url: string;
}): boolean {
  const forwarded = headers.forwardedProto?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === "https";
  return headers.url.startsWith("https://");
}

function cookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function sessionCookie(token: string, secure: boolean): string {
  return cookie(token, Math.floor(config.sessionTtlMs / 1000), secure);
}

export function clearedCookie(secure: boolean): string {
  return cookie("", 0, secure);
}
