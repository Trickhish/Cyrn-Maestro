/* Roles as bundles of capabilities.
 *
 * The roles are the interface; the capabilities are what is actually checked.
 * Keeping them separate means a route asks "may this actor do X" rather than
 * "is this actor an admin", so adding a role later does not mean auditing every
 * call site to work out what it should now be allowed to do.
 *
 * Note what no role has: there is no `secret.read`. Provider keys, node tokens
 * and MCP secrets are write-only through the API. They go in encrypted and come
 * out only inside the server process at call time, so no bundle here — and no
 * instance admin — can pull one back out. */

export type Permission =
  | "project.create"
  | "project.read"
  | "project.update"
  | "project.delete"
  | "project.transfer"
  | "task.run"
  | "task.read"
  | "task.approve"
  | "task.cancel"
  | "node.enroll"
  | "node.read"
  | "node.revoke"
  | "provider.manage"
  | "provider.read"
  | "member.view"
  | "member.invite"
  | "member.remove"
  | "org.settings"
  | "org.delete"
  | "audit.read";

export type OrgRole = "owner" | "admin" | "member" | "viewer";

const VIEWER: Permission[] = ["project.read", "task.read", "node.read", "member.view"];

const MEMBER: Permission[] = [
  ...VIEWER,
  "project.create",
  "task.run",
  "task.approve",
  "task.cancel",
  /* Can use a provider without being able to add, change or remove one. */
  "provider.read",
];

const ADMIN: Permission[] = [
  ...MEMBER,
  "project.update",
  "project.delete",
  "provider.manage",
  "node.enroll",
  "node.revoke",
  "member.invite",
  "member.remove",
  "org.settings",
  "audit.read",
];

/* Owner adds only the two irreversible things: handing the org to someone else,
   and destroying it. */
const OWNER: Permission[] = [...ADMIN, "project.transfer", "org.delete"];

const BUNDLES: Record<OrgRole, ReadonlySet<Permission>> = {
  viewer: new Set(VIEWER),
  member: new Set(MEMBER),
  admin: new Set(ADMIN),
  owner: new Set(OWNER),
};

export function roleGrants(role: OrgRole, permission: Permission): boolean {
  return BUNDLES[role]?.has(permission) ?? false;
}

export function permissionsFor(role: OrgRole): Permission[] {
  return [...(BUNDLES[role] ?? [])];
}

/* A personal owner has every permission over their own things. There is no
   role to look up: owning it is the grant. */
export function personalGrants(permission: Permission): boolean {
  /* Except the org-only ones, which are meaningless without an org. */
  return permission !== "org.delete" && permission !== "org.settings" && permission !== "audit.read"
    ? true
    : false;
}

export const ROLE_ORDER: OrgRole[] = ["viewer", "member", "admin", "owner"];

export function isAtLeast(role: OrgRole, minimum: OrgRole): boolean {
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(minimum);
}
