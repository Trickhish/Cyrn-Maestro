import { Hono } from "hono";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { assertCan } from "../lib/permissions";
import { record } from "../lib/audit";
import { BadRequest, NotFound, requireActor, activeScope, type Env } from "./context";

export const modelListRoutes = new Hono<Env>();

function ownedBy(scope: { ownerUserId?: string | null; ownerOrgId?: string | null }) {
  return scope.ownerOrgId
    ? eq(schema.modelLists.ownerOrgId, scope.ownerOrgId)
    : eq(schema.modelLists.ownerUserId, scope.ownerUserId!);
}

async function withEntries(listId: string) {
  return db
    .select({ id: schema.modelListEntries.id })
    .from(schema.modelListEntries)
    .where(eq(schema.modelListEntries.listId, listId))
    .orderBy(asc(schema.modelListEntries.position));
}

/* Fetches one list the caller may see, or throws NotFound — used by every
   route below "/:id" so a stranger's list id behaves exactly like one that
   does not exist. */
async function ownList(id: string, scope: { ownerUserId?: string | null; ownerOrgId?: string | null }) {
  const [list] = await db
    .select()
    .from(schema.modelLists)
    .where(and(eq(schema.modelLists.id, id), ownedBy(scope)))
    .limit(1);
  if (!list) throw new NotFound();
  return list;
}

modelListRoutes.get("/", async (c) => {
  const actor = requireActor(c);
  const scope = activeScope(c);
  await assertCan(actor, "provider.read", scope);

  const lists = await db
    .select()
    .from(schema.modelLists)
    .where(ownedBy(scope))
    .orderBy(asc(schema.modelLists.createdAt));

  const entries = lists.length
    ? await db
        .select({
          id: schema.modelListEntries.id,
          listId: schema.modelListEntries.listId,
          modelId: schema.modelListEntries.modelId,
          groupId: schema.modelListEntries.groupId,
          groupName: schema.modelGroups.name,
        })
        .from(schema.modelListEntries)
        .leftJoin(schema.modelGroups, eq(schema.modelListEntries.groupId, schema.modelGroups.id))
        .where(
          inArray(
            schema.modelListEntries.listId,
            lists.map((l) => l.id),
          ),
        )
        .orderBy(asc(schema.modelListEntries.position))
    : [];

  return c.json({
    lists: lists.map((list) => ({
      id: list.id,
      name: list.name,
      description: list.description,
      createdAt: list.createdAt,
      entries: entries
        .filter((e) => e.listId === list.id)
        .map((e) => ({
          id: e.id,
          modelId: e.modelId,
          groupId: e.groupId,
          groupName: e.groupName,
        })),
    })),
  });
});

const ListInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullish(),
});

modelListRoutes.post("/", async (c) => {
  const actor = requireActor(c);
  const parsed = ListInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Give the list a name.", z.flattenError(parsed.error).fieldErrors);

  const scope = activeScope(c);
  /* Curating what a task-routing decision reads is the same authority as
     configuring a provider — not something any member should do unasked. */
  await assertCan(actor, "provider.manage", scope);

  const row = {
    id: crypto.randomUUID(),
    ownerUserId: scope.ownerOrgId ? null : actor.id,
    ownerOrgId: scope.ownerOrgId ?? null,
    name: parsed.data.name,
    description: parsed.data.description || null,
    createdAt: Date.now(),
  };

  try {
    await db.insert(schema.modelLists).values(row);
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      throw new BadRequest(`There is already a list called "${row.name}".`);
    }
    throw err;
  }

  await record(scope.ownerOrgId ?? null, actor, "model_list.created", row.id, { name: row.name });
  return c.json({ list: { ...row, entries: [] } }, 201);
});

modelListRoutes.patch("/:id", async (c) => {
  const actor = requireActor(c);
  const scope = activeScope(c);
  await assertCan(actor, "provider.manage", scope);
  const list = await ownList(c.req.param("id"), scope);

  const parsed = ListInput.partial().safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Check the form.");

  try {
    await db
      .update(schema.modelLists)
      .set({
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description || null } : {}),
      })
      .where(eq(schema.modelLists.id, list.id));
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      throw new BadRequest(`There is already a list called "${parsed.data.name}".`);
    }
    throw err;
  }

  await record(scope.ownerOrgId ?? null, actor, "model_list.changed", list.id, { name: list.name });
  return c.json({ ok: true });
});

modelListRoutes.delete("/:id", async (c) => {
  const actor = requireActor(c);
  const scope = activeScope(c);
  await assertCan(actor, "provider.manage", scope);
  const list = await ownList(c.req.param("id"), scope);

  await db.delete(schema.modelLists).where(eq(schema.modelLists.id, list.id));
  await record(scope.ownerOrgId ?? null, actor, "model_list.deleted", list.id, { name: list.name });
  return c.json({ ok: true });
});

/* Exactly one of the two — a single call id that resolves to two different
   things is worse than two smaller, unambiguous ones. */
const EntryInput = z
  .object({
    modelId: z.string().trim().min(1).max(200).nullish(),
    groupId: z.string().trim().min(1).nullish(),
  })
  .refine((v) => Boolean(v.modelId) !== Boolean(v.groupId), {
    message: "Give either a model or a group, not both.",
  });

/* Appended at the end — a fresh entry is the least-preferred one until
   someone says otherwise, never inserted ahead of what is already trusted. */
modelListRoutes.post("/:id/entries", async (c) => {
  const actor = requireActor(c);
  const scope = activeScope(c);
  await assertCan(actor, "provider.manage", scope);
  const list = await ownList(c.req.param("id"), scope);

  const parsed = EntryInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest(parsed.error.issues[0]?.message ?? "Pick a model or a group.");

  if (parsed.data.modelId) {
    /* Has to be a model id the owner can actually reach, not an arbitrary
       string — an unrecognised entry would sit in the list looking chosen but
       never resolving to anything. */
    const [known] = await db
      .select({ modelId: schema.models.modelId })
      .from(schema.models)
      .innerJoin(schema.providerConnections, eq(schema.models.providerId, schema.providerConnections.id))
      .where(
        and(
          eq(schema.models.modelId, parsed.data.modelId),
          scope.ownerOrgId
            ? eq(schema.providerConnections.ownerOrgId, scope.ownerOrgId)
            : eq(schema.providerConnections.ownerUserId, scope.ownerUserId!),
        ),
      )
      .limit(1);
    if (!known) throw new BadRequest("That model is not offered by any of this owner's providers.");
  } else {
    const [group] = await db
      .select({ id: schema.modelGroups.id })
      .from(schema.modelGroups)
      .where(
        and(
          eq(schema.modelGroups.id, parsed.data.groupId!),
          scope.ownerOrgId
            ? eq(schema.modelGroups.ownerOrgId, scope.ownerOrgId)
            : eq(schema.modelGroups.ownerUserId, scope.ownerUserId!),
        ),
      )
      .limit(1);
    if (!group) throw new NotFound();
  }

  const [{ next }] = await db
    .select({ next: sql<number>`coalesce(max(${schema.modelListEntries.position}), -1) + 1` })
    .from(schema.modelListEntries)
    .where(eq(schema.modelListEntries.listId, list.id));

  const id = crypto.randomUUID();
  try {
    await db.insert(schema.modelListEntries).values({
      id,
      listId: list.id,
      modelId: parsed.data.modelId ?? null,
      groupId: parsed.data.groupId ?? null,
      position: next,
      createdAt: Date.now(),
    });
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      throw new BadRequest(
        parsed.data.modelId
          ? `${parsed.data.modelId} is already on this list.`
          : "That group is already on this list.",
      );
    }
    throw err;
  }

  await record(scope.ownerOrgId ?? null, actor, "model_list.entry_added", list.id, {
    ...(parsed.data.modelId ? { modelId: parsed.data.modelId } : { groupId: parsed.data.groupId }),
  });
  return c.json({ id }, 201);
});

modelListRoutes.delete("/:id/entries/:entryId", async (c) => {
  const actor = requireActor(c);
  const scope = activeScope(c);
  await assertCan(actor, "provider.manage", scope);
  const list = await ownList(c.req.param("id"), scope);

  const deleted = await db
    .delete(schema.modelListEntries)
    .where(
      and(
        eq(schema.modelListEntries.id, c.req.param("entryId")),
        eq(schema.modelListEntries.listId, list.id),
      ),
    )
    .returning({ id: schema.modelListEntries.id });
  if (deleted.length === 0) throw new NotFound();

  await record(scope.ownerOrgId ?? null, actor, "model_list.entry_removed", list.id);
  return c.json({ ok: true });
});

const OrderInput = z.object({ entryIds: z.array(z.string()).min(1) });

/* The whole order, sent as one array, rather than a "move up" delta per
   click — a client-computed swap applied server-side by position can only
   drift from what is on screen if two edits ever race; sending the order
   the UI already shows cannot. */
modelListRoutes.put("/:id/order", async (c) => {
  const actor = requireActor(c);
  const scope = activeScope(c);
  await assertCan(actor, "provider.manage", scope);
  const list = await ownList(c.req.param("id"), scope);

  const parsed = OrderInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Give the full order.");

  const current = await withEntries(list.id);
  const currentIds = new Set(current.map((e) => e.id));
  const wantedIds = new Set(parsed.data.entryIds);

  if (
    parsed.data.entryIds.length !== current.length ||
    [...currentIds].some((id) => !wantedIds.has(id))
  ) {
    throw new BadRequest("That is not the current list of entries.");
  }

  for (let position = 0; position < parsed.data.entryIds.length; position++) {
    await db
      .update(schema.modelListEntries)
      .set({ position })
      .where(eq(schema.modelListEntries.id, parsed.data.entryIds[position]!));
  }

  return c.json({ ok: true });
});
