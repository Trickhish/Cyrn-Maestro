import { Hono } from "hono";
import { and, desc, eq, count } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { config } from "../config";
import { newToken, hashToken } from "../lib/crypto";
import { assertCan, roleIn, invalidateMembership } from "../lib/permissions";
import { permissionsFor } from "../lib/roles";
import { record } from "../lib/audit";
import { BadRequest, NotFound, requireActor, type Env } from "./context";

export const orgRoutes = new Hono<Env>();

const ROLES = ["owner", "admin", "member", "viewer"] as const;

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "org"
  );
}

/* ------------------------------------------------------------------- orgs */

orgRoutes.get("/", async (c) => {
  const actor = requireActor(c);

  const rows = await db
    .select({
      id: schema.organizations.id,
      name: schema.organizations.name,
      slug: schema.organizations.slug,
      role: schema.memberships.role,
      createdAt: schema.organizations.createdAt,
    })
    .from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.memberships.orgId, schema.organizations.id))
    .where(eq(schema.memberships.userId, actor.id))
    .orderBy(desc(schema.organizations.createdAt));

  return c.json({
    organizations: rows.map((row) => ({ ...row, permissions: permissionsFor(row.role) })),
  });
});

orgRoutes.post("/", async (c) => {
  const actor = requireActor(c);
  const parsed = z
    .object({ name: z.string().min(1).max(80) })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Give the organization a name.");

  const base = slugify(parsed.data.name);
  const taken = new Set(
    (await db.select({ slug: schema.organizations.slug }).from(schema.organizations)).map(
      (r) => r.slug,
    ),
  );
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;

  const org = {
    id: crypto.randomUUID(),
    name: parsed.data.name,
    slug,
    require2fa: false,
    createdAt: Date.now(),
  };

  await db.insert(schema.organizations).values(org);
  /* Whoever creates it owns it. An org with no owner cannot be administered. */
  await db.insert(schema.memberships).values({
    id: crypto.randomUUID(),
    userId: actor.id,
    orgId: org.id,
    role: "owner",
    createdAt: Date.now(),
  });
  invalidateMembership(actor.id, org.id);

  await record(org.id, actor, "org.created", org.id, { name: org.name });

  return c.json({ organization: { ...org, role: "owner", permissions: permissionsFor("owner") } }, 201);
});

/* ---------------------------------------------------------------- members */

orgRoutes.get("/:id/members", async (c) => {
  const actor = requireActor(c);
  const orgId = c.req.param("id");
  await assertCan(actor, "member.view", { ownerOrgId: orgId });

  const members = await db
    .select({
      userId: schema.memberships.userId,
      email: schema.users.email,
      role: schema.memberships.role,
      since: schema.memberships.createdAt,
    })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
    .where(eq(schema.memberships.orgId, orgId));

  const pending = await db
    .select({
      id: schema.invitations.id,
      email: schema.invitations.email,
      role: schema.invitations.role,
      expiresAt: schema.invitations.expiresAt,
    })
    .from(schema.invitations)
    .where(
      and(eq(schema.invitations.orgId, orgId), eq(schema.invitations.acceptedAt, null as never)),
    );

  return c.json({ members, invitations: pending });
});

orgRoutes.post("/:id/invitations", async (c) => {
  const actor = requireActor(c);
  const orgId = c.req.param("id");
  await assertCan(actor, "member.invite", { ownerOrgId: orgId });

  const parsed = z
    .object({ email: z.email(), role: z.enum(ROLES) })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Enter an email address and a role.");

  /* Only an owner may create another owner: an admin promoting someone above
     themselves is a privilege escalation with extra steps. */
  if (parsed.data.role === "owner") {
    await assertCan(actor, "org.delete", { ownerOrgId: orgId });
  }

  const token = `inv_${newToken(18)}`;
  await db.insert(schema.invitations).values({
    id: crypto.randomUUID(),
    orgId,
    email: parsed.data.email.trim().toLowerCase(),
    role: parsed.data.role,
    tokenHash: hashToken(token),
    invitedBy: actor.id,
    expiresAt: Date.now() + 7 * 24 * 3600_000,
    acceptedAt: null,
    createdAt: Date.now(),
  });

  await record(orgId, actor, "member.invited", parsed.data.email, { role: parsed.data.role });

  return c.json({
    /* Shown once. There is no read path back to it — the hash is all that is
       stored, same as every other token here. */
    link: `${config.publicUrl}/invite/${token}`,
    expiresInMs: 7 * 24 * 3600_000,
  });
});

orgRoutes.post("/invitations/accept", async (c) => {
  const actor = requireActor(c);
  const parsed = z
    .object({ token: z.string().min(1) })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("That invitation link is malformed.");

  const [invite] = await db
    .select()
    .from(schema.invitations)
    .where(eq(schema.invitations.tokenHash, hashToken(parsed.data.token)))
    .limit(1);

  if (!invite) throw new BadRequest("That invitation is not valid.");
  if (invite.acceptedAt) throw new BadRequest("That invitation has already been used.");
  if (invite.expiresAt < Date.now()) throw new BadRequest("That invitation has expired.");

  /* Bound to the address it was sent to, so a forwarded link does not let
     someone else join in the invitee's place. */
  if (invite.email !== actor.email.toLowerCase()) {
    throw new BadRequest(`That invitation was sent to ${invite.email}. Sign in as that account to accept it.`);
  }

  const existing = await roleIn(actor.id, invite.orgId);
  if (existing) throw new BadRequest("You are already a member of that organization.");

  await db.insert(schema.memberships).values({
    id: crypto.randomUUID(),
    userId: actor.id,
    orgId: invite.orgId,
    role: invite.role,
    createdAt: Date.now(),
  });
  await db
    .update(schema.invitations)
    .set({ acceptedAt: Date.now() })
    .where(eq(schema.invitations.id, invite.id));

  invalidateMembership(actor.id, invite.orgId);
  await record(invite.orgId, actor, "member.joined", actor.email, { role: invite.role });

  const [org] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.id, invite.orgId))
    .limit(1);

  return c.json({ organization: { ...org, role: invite.role } });
});

orgRoutes.patch("/:id/members/:userId", async (c) => {
  const actor = requireActor(c);
  const orgId = c.req.param("id");
  const userId = c.req.param("userId");
  await assertCan(actor, "member.invite", { ownerOrgId: orgId });

  const parsed = z
    .object({ role: z.enum(ROLES) })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Pick a role.");

  const target = await roleIn(userId, orgId);
  if (!target) throw new NotFound();

  const mine = await roleIn(actor.id, orgId);

  /* An admin cannot change an owner, nor create one. Only an owner outranks
     an owner. */
  if ((target === "owner" || parsed.data.role === "owner") && mine !== "owner") {
    throw new BadRequest("Only an owner can change an owner's role.");
  }

  if (target === "owner" && parsed.data.role !== "owner") {
    await assertLastOwnerSafe(orgId, userId);
  }

  await db
    .update(schema.memberships)
    .set({ role: parsed.data.role })
    .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId)));

  invalidateMembership(userId, orgId);
  await record(orgId, actor, "member.role_changed", userId, {
    from: target,
    to: parsed.data.role,
  });

  return c.json({ ok: true });
});

orgRoutes.delete("/:id/members/:userId", async (c) => {
  const actor = requireActor(c);
  const orgId = c.req.param("id");
  const userId = c.req.param("userId");

  /* Leaving is always allowed; removing someone else needs the permission. */
  if (userId !== actor.id) {
    await assertCan(actor, "member.remove", { ownerOrgId: orgId });
  }

  const target = await roleIn(userId, orgId);
  if (!target) throw new NotFound();
  if (target === "owner") await assertLastOwnerSafe(orgId, userId);

  await db
    .delete(schema.memberships)
    .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId)));

  invalidateMembership(userId, orgId);
  await record(orgId, actor, userId === actor.id ? "member.left" : "member.removed", userId);

  return c.json({ ok: true });
});

/* An org with no owner cannot be administered, invited to, or deleted — it is
   simply stuck. Refusing the last removal is the only way out. */
async function assertLastOwnerSafe(orgId: string, leavingUserId: string): Promise<void> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.role, "owner")));

  if ((row?.n ?? 0) <= 1) {
    throw new BadRequest(
      "This is the organization's only owner. Make someone else an owner first.",
    );
  }
  void leavingUserId;
}

/* ----------------------------------------------------------------- audit */

orgRoutes.get("/:id/audit", async (c) => {
  const actor = requireActor(c);
  const orgId = c.req.param("id");
  await assertCan(actor, "audit.read", { ownerOrgId: orgId });

  const rows = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.orgId, orgId))
    .orderBy(desc(schema.auditLog.at))
    .limit(200);

  return c.json({ entries: rows });
});
