import { and, eq } from "drizzle-orm";
import { db, schema } from "../db";
import type { Actor } from "./auth";
import { personalGrants, roleGrants, type OrgRole, type Permission } from "./roles";

export type { Permission } from "./roles";

/* One check in front of every route and every socket action.
 *
 * Two levels of authority, deliberately separate:
 *
 *   Instance admin runs the server. That is about keeping the process alive —
 *   users, registration policy, the fleet as infrastructure. It grants nothing
 *   inside an organization the admin is not a member of. The person who
 *   restarts the server should not silently be able to read every tenant's
 *   source code, and the small friction of having to join an org — which is
 *   itself audited, and visible to that org's owners — is worth it.
 *
 *   Organization role is about the work: Owner, Admin, Member, Viewer.
 *
 * Resolution needs a database read for org scopes, so this is async. The
 * synchronous form remains for the personal case, which is most call sites. */

export class Forbidden extends Error {
  constructor(readonly permission: Permission) {
    super(`Not allowed: ${permission}`);
  }
}

export interface Scope {
  ownerUserId?: string | null;
  ownerOrgId?: string | null;
}

/* Membership is read on nearly every request, and it changes rarely. A short
   TTL keeps a role change taking effect within seconds without hitting the
   database on every permission check. */
const MEMBERSHIP_TTL_MS = 5_000;
const membershipCache = new Map<string, { role: OrgRole | null; at: number }>();

export function invalidateMembership(userId: string, orgId: string): void {
  membershipCache.delete(`${userId}:${orgId}`);
}

export function clearMembershipCache(): void {
  membershipCache.clear();
}

export async function roleIn(userId: string, orgId: string): Promise<OrgRole | null> {
  const key = `${userId}:${orgId}`;
  const cached = membershipCache.get(key);
  if (cached && Date.now() - cached.at < MEMBERSHIP_TTL_MS) return cached.role;

  const [row] = await db
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.orgId, orgId)))
    .limit(1);

  const role = row?.role ?? null;
  membershipCache.set(key, { role, at: Date.now() });
  return role;
}

export async function can(
  actor: Actor | null,
  permission: Permission,
  scope: Scope,
): Promise<boolean> {
  if (!actor) return false;

  if (scope.ownerOrgId) {
    const role = await roleIn(actor.id, scope.ownerOrgId);
    /* No membership, no access — instance admin included. */
    if (!role) return false;
    return roleGrants(role, permission);
  }

  if (scope.ownerUserId) {
    return scope.ownerUserId === actor.id && personalGrants(permission);
  }

  /* An unowned row is reachable by nobody. */
  return false;
}

export async function assertCan(
  actor: Actor | null,
  permission: Permission,
  scope: Scope,
): Promise<void> {
  if (!(await can(actor, permission, scope))) throw new Forbidden(permission);
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

export async function providerScope(providerId: string): Promise<Scope | null> {
  const [p] = await db
    .select({
      ownerUserId: schema.providerConnections.ownerUserId,
      ownerOrgId: schema.providerConnections.ownerOrgId,
    })
    .from(schema.providerConnections)
    .where(eq(schema.providerConnections.id, providerId))
    .limit(1);
  return p ?? null;
}

/* The scope a new thing should be created in: an org when one is active and the
   actor is a member, otherwise personal. */
export async function creationScope(
  actor: Actor,
  orgId: string | null | undefined,
): Promise<Scope> {
  if (!orgId) return { ownerUserId: actor.id, ownerOrgId: null };

  const role = await roleIn(actor.id, orgId);
  if (!role) throw new Forbidden("project.create");
  return { ownerUserId: null, ownerOrgId: orgId };
}
