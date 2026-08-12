import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import {
  authenticateFully,
  createSession,
  createUser,
  destroySession,
  registrationOpen,
  sessionCookie,
  clearedCookie,
  isSecureRequest,
  SESSION_COOKIE,
} from "../lib/auth";
import { BadRequest, requireActor, type Env } from "./context";
import { record } from "../lib/audit";

const Credentials = z.object({
  code: z.string().optional(),
  email: z.email("That does not look like an email address."),
  /* Long enough to matter, with no composition rules — those push people
     toward "Password1!" and buy nothing. */
  password: z.string().min(10, "Use at least 10 characters."),
});

export const authRoutes = new Hono<Env>();

/* Whether this particular request reached us over HTTPS, honouring the proxy's
   X-Forwarded-Proto since the hop to this server is plain HTTP either way. */
function secureFor(c: { req: { header(name: string): string | undefined; url: string } }): boolean {
  return isSecureRequest({
    forwardedProto: c.req.header("x-forwarded-proto") ?? null,
    url: c.req.url,
  });
}

authRoutes.get("/session", async (c) => {
  const actor = c.get("actor");
  return c.json({
    actor,
    registrationOpen: actor ? false : await registrationOpen(),
  });
});

authRoutes.post("/register", async (c) => {
  if (!(await registrationOpen())) {
    /* Not 403: after the first account, registration is closed to everyone,
       which is a state of the instance rather than a fact about the caller. */
    throw new BadRequest(
      "Registration is closed on this instance. Ask an administrator for an invitation.",
    );
  }

  const parsed = Credentials.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw new BadRequest("Check the form.", z.flattenError(parsed.error).fieldErrors);
  }

  const actor = await createUser(parsed.data.email, parsed.data.password);
  const token = await createSession(actor.id, {
    ip: c.req.header("x-forwarded-for") ?? undefined,
    userAgent: c.req.header("user-agent") ?? undefined,
  });

  c.header("Set-Cookie", sessionCookie(token, secureFor(c)));
  return c.json({ actor }, 201);
});

authRoutes.post("/login", async (c) => {
  const parsed = Credentials.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw new BadRequest("Enter your email and password.");
  }

  const { actor, needsSecondFactor } = await authenticateFully(
    parsed.data.email,
    parsed.data.password,
    parsed.data.code,
  );

  if (needsSecondFactor) {
    /* Deliberately distinct from a wrong password: the password WAS right, and
       pretending otherwise would leave the user retyping it forever. This only
       reveals that an account has 2FA to someone who already knows its
       password. */
    return c.json(
      { error: "Enter the code from your authenticator app.", needsSecondFactor: true },
      401,
    );
  }

  if (!actor) {
    /* One message for both failure modes, so this endpoint cannot be used to
       find out which email addresses have accounts. */
    /* Recorded without an actor — the whole point is that authentication did
       not succeed, so there is nobody to attribute it to beyond the address
       that was tried. */
    await record(null, null, "auth.failed", parsed.data.email.trim().toLowerCase());
    return c.json({ error: "That email and password do not match." }, 401);
  }

  const token = await createSession(actor.id, {
    ip: c.req.header("x-forwarded-for") ?? undefined,
    userAgent: c.req.header("user-agent") ?? undefined,
  });

  c.header("Set-Cookie", sessionCookie(token, secureFor(c)));
  /* Instance scope: a sign-in is not yet inside any organization. */
  await record(null, actor, "auth.signed_in");
  return c.json({ actor });
});

authRoutes.post("/logout", async (c) => {
  await destroySession(getCookie(c, SESSION_COOKIE));
  c.header("Set-Cookie", clearedCookie(secureFor(c)));
  return c.json({ ok: true });
});

authRoutes.get("/me", (c) => c.json({ actor: requireActor(c) }));
