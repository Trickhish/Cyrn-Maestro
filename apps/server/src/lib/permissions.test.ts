import { expect, test, describe, beforeEach } from "bun:test";
import { db, schema } from "../db";
import { resetDatabase } from "../test/harness";
import { can, clearMembershipCache, roleIn } from "./permissions";
import { permissionsFor, roleGrants, isAtLeast, type OrgRole } from "./roles";
import type { Actor } from "./auth";

/* The permission matrix is the whole security model. Everything else — routes,
   sockets, the Conductor — funnels through can(). */

const alice: Actor = { id: "alice", email: "a@x.com", instanceRole: "user" };
const bob: Actor = { id: "bob", email: "b@x.com", instanceRole: "user" };
const admin: Actor = { id: "admin", email: "c@x.com", instanceRole: "instance_admin" };

const ORG = "org-acme";

async function addMember(userId: string, role: OrgRole) {
  await db.insert(schema.memberships).values({
    id: crypto.randomUUID(),
    userId,
    orgId: ORG,
    role,
    createdAt: Date.now(),
  });
  clearMembershipCache();
}

beforeEach(async () => {
  resetDatabase();
  clearMembershipCache();

  const now = Date.now();
  await db.insert(schema.users).values(
    ["alice", "bob", "admin"].map((id) => ({
      id,
      email: `${id}@x.com`,
      passwordHash: "x",
      instanceRole: (id === "admin" ? "instance_admin" : "user") as never,
      status: "active" as const,
      createdAt: now,
    })),
  );
  await db.insert(schema.organizations).values({
    id: ORG,
    name: "Acme",
    slug: "acme",
    require2fa: false,
    createdAt: now,
  });
});

describe("personal ownership", () => {
  test("the owner may act on their own things", async () => {
    expect(await can(alice, "task.run", { ownerUserId: "alice" })).toBe(true);
    expect(await can(alice, "project.delete", { ownerUserId: "alice" })).toBe(true);
  });

  test("another user may not", async () => {
    expect(await can(bob, "task.read", { ownerUserId: "alice" })).toBe(false);
  });

  test("an anonymous caller may not", async () => {
    expect(await can(null, "project.read", { ownerUserId: "alice" })).toBe(false);
  });

  test("an unowned row is reachable by nobody", async () => {
    expect(await can(alice, "task.read", { ownerUserId: null })).toBe(false);
  });
});

describe("organization roles", () => {
  test("a viewer can read but not run", async () => {
    await addMember("alice", "viewer");
    expect(await can(alice, "task.read", { ownerOrgId: ORG })).toBe(true);
    expect(await can(alice, "task.run", { ownerOrgId: ORG })).toBe(false);
    expect(await can(alice, "project.create", { ownerOrgId: ORG })).toBe(false);
  });

  test("a member can run tasks and approve them, but not manage providers", async () => {
    await addMember("alice", "member");
    expect(await can(alice, "task.run", { ownerOrgId: ORG })).toBe(true);
    expect(await can(alice, "task.approve", { ownerOrgId: ORG })).toBe(true);
    expect(await can(alice, "project.create", { ownerOrgId: ORG })).toBe(true);
    expect(await can(alice, "provider.manage", { ownerOrgId: ORG })).toBe(false);
    expect(await can(alice, "member.invite", { ownerOrgId: ORG })).toBe(false);
  });

  test("an admin manages the org but cannot delete or transfer it", async () => {
    await addMember("alice", "admin");
    expect(await can(alice, "provider.manage", { ownerOrgId: ORG })).toBe(true);
    expect(await can(alice, "member.invite", { ownerOrgId: ORG })).toBe(true);
    expect(await can(alice, "node.revoke", { ownerOrgId: ORG })).toBe(true);
    expect(await can(alice, "audit.read", { ownerOrgId: ORG })).toBe(true);
    expect(await can(alice, "org.delete", { ownerOrgId: ORG })).toBe(false);
    expect(await can(alice, "project.transfer", { ownerOrgId: ORG })).toBe(false);
  });

  test("an owner can do everything an admin can, plus delete and transfer", async () => {
    await addMember("alice", "owner");
    for (const permission of permissionsFor("admin")) {
      expect(await can(alice, permission, { ownerOrgId: ORG })).toBe(true);
    }
    expect(await can(alice, "org.delete", { ownerOrgId: ORG })).toBe(true);
  });

  test("a non-member gets nothing", async () => {
    await addMember("alice", "owner");
    expect(await can(bob, "project.read", { ownerOrgId: ORG })).toBe(false);
    expect(await can(bob, "task.run", { ownerOrgId: ORG })).toBe(false);
  });
});

/* The separation the README argues for: running the server is not the same as
   being able to read every tenant's source code. */
describe("instance admins are operators, not omniscient readers", () => {
  test("an instance admin gets no access to an org they are not in", async () => {
    await addMember("alice", "owner");
    expect(await can(admin, "project.read", { ownerOrgId: ORG })).toBe(false);
    expect(await can(admin, "task.read", { ownerOrgId: ORG })).toBe(false);
    expect(await can(admin, "audit.read", { ownerOrgId: ORG })).toBe(false);
  });

  test("an instance admin gets no access to another user's personal work", async () => {
    expect(await can(admin, "task.read", { ownerUserId: "alice" })).toBe(false);
  });

  /* Access comes from membership, and joining is itself an audited event the
     org's owners can see. */
  test("joining the org is what grants access, and only what the role allows", async () => {
    await addMember("admin", "viewer");
    expect(await can(admin, "task.read", { ownerOrgId: ORG })).toBe(true);
    expect(await can(admin, "provider.manage", { ownerOrgId: ORG })).toBe(false);
  });
});

describe("no role can read a secret", () => {
  /* There is no secret.read permission at all — not withheld from some roles,
     absent from the type. Provider keys are write-only through the API. */
  test("the permission does not exist in any bundle", () => {
    for (const role of ["viewer", "member", "admin", "owner"] as OrgRole[]) {
      expect(permissionsFor(role).some((p) => String(p).includes("secret"))).toBe(false);
    }
  });
});

describe("role bundles", () => {
  test("each role strictly contains the one below it", () => {
    const order: OrgRole[] = ["viewer", "member", "admin", "owner"];
    for (let i = 1; i < order.length; i++) {
      for (const permission of permissionsFor(order[i - 1])) {
        expect(roleGrants(order[i], permission)).toBe(true);
      }
    }
  });

  test("ranking is ordered", () => {
    expect(isAtLeast("owner", "admin")).toBe(true);
    expect(isAtLeast("member", "admin")).toBe(false);
    expect(isAtLeast("viewer", "viewer")).toBe(true);
  });
});

describe("membership lookup", () => {
  test("reports the role, or null for a non-member", async () => {
    await addMember("alice", "admin");
    expect(await roleIn("alice", ORG)).toBe("admin");
    expect(await roleIn("bob", ORG)).toBe(null);
  });

  /* The cache is a performance detail that must never outlive a role change by
     more than its TTL, and must be invalidated explicitly on write. */
  test("a cleared cache reflects a changed role immediately", async () => {
    await addMember("alice", "viewer");
    expect(await can(alice, "task.run", { ownerOrgId: ORG })).toBe(false);

    await db.update(schema.memberships).set({ role: "member" });
    clearMembershipCache();

    expect(await can(alice, "task.run", { ownerOrgId: ORG })).toBe(true);
  });
});
