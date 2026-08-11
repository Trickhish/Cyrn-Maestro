import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import type { Actor } from "./auth";

/* One check in front of every route and every socket action.
 *
 * v0.1 has no organizations, so ownership is always a user. The signature is
 * already the one the README specifies — can(actor, permission, scope) — so
 * adding org roles in v0.3 changes this file and nothing that calls it.
 *
 * Note what is deliberately absent: there is no `secret.read`. Provider keys
 * and node tokens are write-only through the API. No permission grants a read
 * path, so no role — instance admin included — can pull one back out. */

export type Permission =
  | "project.create"
  | "project.read"
  | "project.update"
  | "project.delete"
  | "task.run"
  | "task.read"
  | "task.approve"
  | "task.cancel"
  | "node.enroll"
  | "node.read"
  | "node.revoke"
  | "provider.manage"
  | "provider.read";

export interface Scope {
  ownerUserId?: string | null;
  ownerOrgId?: string | null;
}

export class Forbidden extends Error {
  constructor(readonly permission: Permission) {
    super(`Not allowed: ${permission}`);
  }
}

export function can(actor: Actor | null, _permission: Permission, scope: Scope): boolean {
  if (!actor) return false;

  /* Org-owned resources are unreachable until v0.3 ships roles. Failing closed
     here means a half-built tenancy feature cannot leak across owners. */
  if (scope.ownerOrgId) return false;

  return scope.ownerUserId === actor.id;
}

export function assertCan(actor: Actor | null, permission: Permission, scope: Scope): void {
  if (!can(actor, permission, scope)) throw new Forbidden(permission);
}

/* Scope lookups. Each returns null when the row does not exist, so a caller
   cannot distinguish "not yours" from "does not exist" — both end as 404. */

export async function projectScope(projectId: string): Promise<Scope | null> {
  const [p] = await db
    .select({ ownerUserId: schema.projects.ownerUserId, ownerOrgId: schema.projects.ownerOrgId })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  return p ?? null;
}

export async function taskScope(taskId: string): Promise<Scope | null> {
  const [row] = await db
    .select({ ownerUserId: schema.projects.ownerUserId, ownerOrgId: schema.projects.ownerOrgId })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.tasks.projectId, schema.projects.id))
    .where(eq(schema.tasks.id, taskId))
    .limit(1);
  return row ?? null;
}

export async function nodeScope(nodeId: string): Promise<Scope | null> {
  const [n] = await db
    .select({ ownerUserId: schema.nodes.ownerUserId, ownerOrgId: schema.nodes.ownerOrgId })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, nodeId))
    .limit(1);
  return n ?? null;
}
