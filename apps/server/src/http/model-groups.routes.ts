import { Hono } from "hono";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { assertCan } from "../lib/permissions";
import { record } from "../lib/audit";
import { BadRequest, NotFound, requireActor, activeScope, type Env } from "./context";

export const modelGroupRoutes = new Hono<Env>();

function ownedBy(scope: { ownerUserId?: string | null; ownerOrgId?: string | null }) {
  return scope.ownerOrgId
    ? eq(schema.modelGroups.ownerOrgId, scope.ownerOrgId)
    : eq(schema.modelGroups.ownerUserId, scope.ownerUserId!);
}

async function ownGroup(id: string, scope: { ownerUserId?: string | null; ownerOrgId?: string | null }) {
  const [group] = await db
    .select()
    .from(schema.modelGroups)
    .where(and(eq(schema.modelGroups.id, id), ownedBy(scope)))
    .limit(1);
  if (!group) throw new NotFound();
  return group;
}

/* Shared with model-lists.routes.ts's own copy rather than a common module —
   each route file owning its tenancy check is the existing pattern here, and
   the two checks are one line apart from identical only by accident: a group
   is scoped by owner, a model by which of the owner's providers serve it. */
async function isOwnedModel(
  modelId: string,
  scope: { ownerUserId?: string | null; ownerOrgId?: string | null },
): Promise<boolean> {
  const [known] = await db
    .select({ modelId: schema.models.modelId })
    .from(schema.models)
    .innerJoin(schema.providerConnections, eq(schema.models.providerId, schema.providerConnections.id))
    .where(
      and(
        eq(schema.models.modelId, modelId),
        scope.ownerOrgId
          ? eq(schema.providerConnections.ownerOrgId, scope.ownerOrgId)
          : eq(schema.providerConnections.ownerUserId, scope.ownerUserId!),
      ),
    )
    .limit(1);
  return Boolean(known);
}

modelGroupRoutes.get("/", async (c) => {
  const actor = requireActor(c);
  const scope = activeScope(c);
  await assertCan(actor, "provider.read", scope);

  const groups = await db
    .select()
    .from(schema.modelGroups)
    .where(ownedBy(scope))
    .orderBy(asc(schema.modelGroups.createdAt));

  const members = await db
    .select({
      id: schema.modelGroupMembers.id,
      groupId: schema.modelGroupMembers.groupId,
      modelId: schema.modelGroupMembers.modelId,
    })
    .from(schema.modelGroupMembers)
    .orderBy(asc(schema.modelGroupMembers.position));

  return c.json({
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      createdAt: group.createdAt,
      members: members
        .filter((m) => m.groupId === group.id)
        .map((m) => ({ id: m.id, modelId: m.modelId })),
    })),
  });
});

const GroupInput = z.object({ name: z.string().trim().min(1).max(80) });

modelGroupRoutes.post("/", async (c) => {
  const actor = requireActor(c);
  const parsed = GroupInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Give the group a name.");

  const scope = activeScope(c);
  await assertCan(actor, "provider.manage", scope);

  const row = {
    id: crypto.randomUUID(),
    ownerUserId: scope.ownerOrgId ? null : actor.id,
    ownerOrgId: scope.ownerOrgId ?? null,
    name: parsed.data.name,
    createdAt: Date.now(),
  };

  try {
    await db.insert(schema.modelGroups).values(row);
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      throw new BadRequest(`There is already a group called "${row.name}".`);
    }
    throw err;
  }

  await record(scope.ownerOrgId ?? null, actor, "model_group.created", row.id, { name: row.name });
  return c.json({ group: { ...row, members: [] } }, 201);
});

modelGroupRoutes.patch("/:id", async (c) => {
  const actor = requireActor(c);
  const scope = activeScope(c);
  await assertCan(actor, "provider.manage", scope);
  const group = await ownGroup(c.req.param("id"), scope);

  const parsed = GroupInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Give the group a name.");

  try {
    await db.update(schema.modelGroups).set({ name: parsed.data.name }).where(eq(schema.modelGroups.id, group.id));
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      throw new BadRequest(`There is already a group called "${parsed.data.name}".`);
    }
    throw err;
  }

  await record(scope.ownerOrgId ?? null, actor, "model_group.changed", group.id, { name: parsed.data.name });
  return c.json({ ok: true });
});

modelGroupRoutes.delete("/:id", async (c) => {
  const actor = requireActor(c);
  const scope = activeScope(c);
  await assertCan(actor, "provider.manage", scope);
  const group = await ownGroup(c.req.param("id"), scope);

  /* Deleting a group in use removes it from every list it was added to — the
     same cascade every ownable resource here follows (a deleted provider
     takes its models with it, a deleted project takes its rules). The count
     is reported so the UI can say so before it happens, not after. */
  await db.delete(schema.modelGroups).where(eq(schema.modelGroups.id, group.id));
  await record(scope.ownerOrgId ?? null, actor, "model_group.deleted", group.id, { name: group.name });
  return c.json({ ok: true });
});

const MemberInput = z.object({ modelId: z.string().trim().min(1).max(200) });

modelGroupRoutes.post("/:id/members", async (c) => {
  const actor = requireActor(c);
  const scope = activeScope(c);
  await assertCan(actor, "provider.manage", scope);
  const group = await ownGroup(c.req.param("id"), scope);

  const parsed = MemberInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Pick a model.");
  if (!(await isOwnedModel(parsed.data.modelId, scope))) {
    throw new BadRequest("That model is not offered by any of this owner's providers.");
  }

  const [{ next }] = await db
    .select({ next: sql<number>`coalesce(max(${schema.modelGroupMembers.position}), -1) + 1` })
    .from(schema.modelGroupMembers)
    .where(eq(schema.modelGroupMembers.groupId, group.id));

  const id = crypto.randomUUID();
  try {
    await db.insert(schema.modelGroupMembers).values({
      id,
      groupId: group.id,
      modelId: parsed.data.modelId,
      position: next,
      createdAt: Date.now(),
    });
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      throw new BadRequest(`${parsed.data.modelId} is already in this group.`);
    }
    throw err;
  }

  await record(scope.ownerOrgId ?? null, actor, "model_group.member_added", group.id, {
    modelId: parsed.data.modelId,
  });
  return c.json({ id }, 201);
});

modelGroupRoutes.delete("/:id/members/:memberId", async (c) => {
  const actor = requireActor(c);
  const scope = activeScope(c);
  await assertCan(actor, "provider.manage", scope);
  const group = await ownGroup(c.req.param("id"), scope);

  const deleted = await db
    .delete(schema.modelGroupMembers)
    .where(
      and(
        eq(schema.modelGroupMembers.id, c.req.param("memberId")),
        eq(schema.modelGroupMembers.groupId, group.id),
      ),
    )
    .returning({ id: schema.modelGroupMembers.id });
  if (deleted.length === 0) throw new NotFound();

  await record(scope.ownerOrgId ?? null, actor, "model_group.member_removed", group.id);
  return c.json({ ok: true });
});

const OrderInput = z.object({ memberIds: z.array(z.string()).min(1) });

modelGroupRoutes.put("/:id/order", async (c) => {
  const actor = requireActor(c);
  const scope = activeScope(c);
  await assertCan(actor, "provider.manage", scope);
  const group = await ownGroup(c.req.param("id"), scope);

  const parsed = OrderInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Give the full order.");

  const current = await db
    .select({ id: schema.modelGroupMembers.id })
    .from(schema.modelGroupMembers)
    .where(eq(schema.modelGroupMembers.groupId, group.id));
  const currentIds = new Set(current.map((m) => m.id));
  const wantedIds = new Set(parsed.data.memberIds);

  if (
    parsed.data.memberIds.length !== current.length ||
    [...currentIds].some((id) => !wantedIds.has(id))
  ) {
    throw new BadRequest("That is not the current list of members.");
  }

  for (let position = 0; position < parsed.data.memberIds.length; position++) {
    await db
      .update(schema.modelGroupMembers)
      .set({ position })
      .where(eq(schema.modelGroupMembers.id, parsed.data.memberIds[position]!));
  }

  return c.json({ ok: true });
});
