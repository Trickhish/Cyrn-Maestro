import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { actorForToken, SESSION_COOKIE, type Actor } from "../lib/auth";
import { Forbidden } from "../lib/permissions";

export type Env = { Variables: { actor: Actor | null } };

/* Resolves the session on every request. Attaching the actor here rather than
   per-route means a route can never forget to look, only forget to check —
   and requireActor makes forgetting to check a 401 rather than a silent pass. */
export const withActor: MiddlewareHandler<Env> = async (c, next) => {
  c.set("actor", await actorForToken(getCookie(c, SESSION_COOKIE)));
  await next();
};

export function requireActor(c: Context<Env>): Actor {
  const actor = c.get("actor");
  if (!actor) throw new Unauthorized();
  return actor;
}

export class Unauthorized extends Error {}
export class NotFound extends Error {}
export class BadRequest extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/* Errors explain what went wrong and what to do, and never leak whether a row
   exists to someone not allowed to see it — Forbidden becomes 404 for exactly
   that reason. */
export function errorResponse(err: unknown, c: Context<Env>) {
  if (err instanceof Unauthorized) {
    return c.json({ error: "Not signed in." }, 401);
  }
  if (err instanceof Forbidden || err instanceof NotFound) {
    return c.json({ error: "Not found." }, 404);
  }
  if (err instanceof BadRequest) {
    return c.json({ error: err.message, details: err.details }, 400);
  }
  console.error("[server]", err);
  return c.json({ error: "Something went wrong on the server." }, 500);
}
