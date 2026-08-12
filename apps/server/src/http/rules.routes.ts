import { Hono } from "hono";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { assertCan, projectScope } from "../lib/permissions";
import { record } from "../lib/audit";
import { BadRequest, NotFound, requireActor, activeScope, type Env } from "./context";

export const ruleRoutes = new Hono<Env>();

const TIERS = ["light", "standard", "heavy"] as const;

const RuleInput = z.object({
  name: z.string().min(1).max(80),
  projectId: z.string().optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  enabled: z.boolean().optional(),
  matchText: z.string().max(200).nullish(),
  matchTier: z.enum(TIERS).nullish(),
  setTier: z.enum(TIERS).nullish(),
  setModelId: z.string().max(200).nullish(),
  setNodeId: z.string().nullish(),
});

/* Rules belong either to a project or to the whole owner. A rule scoped to a
   project the caller cannot reach must not be creatable, so the scope check
   follows the project when one is named. */
async function scopeFor(c: Parameters<typeof requireActor>[0], projectId?: string) {
  if (projectId) {
    const scope = await projectScope(projectId);
    if (!scope) throw new NotFound();
    return scope;
  }
  return activeScope(c);
}

ruleRoutes.get("/", async (c) => {
  const actor = requireActor(c);
  const projectId = c.req.query("projectId");
  const scope = await scopeFor(c, projectId);
  await assertCan(actor, "project.read", scope);

  const rows = await db
    .select()
    .from(schema.routingRules)
    .where(
      projectId
        ? or(
            eq(schema.routingRules.projectId, projectId),
            scope.ownerOrgId
              ? and(
                  eq(schema.routingRules.ownerOrgId, scope.ownerOrgId),
                  isNull(schema.routingRules.projectId),
                )
              : and(
                  eq(schema.routingRules.ownerUserId, scope.ownerUserId!),
                  isNull(schema.routingRules.projectId),
                ),
          )
        : scope.ownerOrgId
          ? eq(schema.routingRules.ownerOrgId, scope.ownerOrgId)
          : eq(schema.routingRules.ownerUserId, scope.ownerUserId!),
    )
    .orderBy(asc(schema.routingRules.priority), asc(schema.routingRules.createdAt));

  return c.json({ rules: rows });
});

ruleRoutes.post("/", async (c) => {
  const actor = requireActor(c);
  const parsed = RuleInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw new BadRequest("Check the rule.", z.flattenError(parsed.error).fieldErrors);
  }

  const scope = await scopeFor(c, parsed.data.projectId);
  /* Writing a rule changes what every future task in scope does, which is a
     project-level change rather than something any member may do. */
  await assertCan(actor, "project.update", scope);

  const row = {
    id: crypto.randomUUID(),
    projectId: parsed.data.projectId ?? null,
    /* Owner columns only when the rule is not project-scoped: a project rule
       inherits its scope from the project. */
    ownerOrgId: parsed.data.projectId ? null : (scope.ownerOrgId ?? null),
    ownerUserId: parsed.data.projectId ? null : (scope.ownerOrgId ? null : actor.id),
    name: parsed.data.name,
    priority: parsed.data.priority ?? 100,
    enabled: parsed.data.enabled ?? true,
    matchText: parsed.data.matchText ?? null,
    matchTier: parsed.data.matchTier ?? null,
    setTier: parsed.data.setTier ?? null,
    setModelId: parsed.data.setModelId ?? null,
    setNodeId: parsed.data.setNodeId ?? null,
    createdAt: Date.now(),
  };

  /* A rule that matches everything and changes nothing is almost always a
     half-finished thought, and it silently shadows every rule below it. */
  if (!row.setTier && !row.setModelId && !row.setNodeId) {
    throw new BadRequest("A rule has to change something: a tier, a model, or a machine.");
  }

  await db.insert(schema.routingRules).values(row);
  await record(scope.ownerOrgId ?? null, actor, "rule.created", row.id, { name: row.name });

  return c.json({ rule: row }, 201);
});

ruleRoutes.patch("/:id", async (c) => {
  const actor = requireActor(c);

  const [existing] = await db
    .select()
    .from(schema.routingRules)
    .where(eq(schema.routingRules.id, c.req.param("id")))
    .limit(1);
  if (!existing) throw new NotFound();

  const scope = await scopeFor(c, existing.projectId ?? undefined);
  await assertCan(actor, "project.update", scope);

  const parsed = RuleInput.partial().safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Check the rule.");

  await db
    .update(schema.routingRules)
    .set({
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
      ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
      ...(parsed.data.matchText !== undefined ? { matchText: parsed.data.matchText } : {}),
      ...(parsed.data.matchTier !== undefined ? { matchTier: parsed.data.matchTier } : {}),
      ...(parsed.data.setTier !== undefined ? { setTier: parsed.data.setTier } : {}),
      ...(parsed.data.setModelId !== undefined ? { setModelId: parsed.data.setModelId } : {}),
      ...(parsed.data.setNodeId !== undefined ? { setNodeId: parsed.data.setNodeId } : {}),
    })
    .where(eq(schema.routingRules.id, c.req.param("id")));

  await record(scope.ownerOrgId ?? null, actor, "rule.changed", c.req.param("id"));
  return c.json({ ok: true });
});

ruleRoutes.delete("/:id", async (c) => {
  const actor = requireActor(c);

  const [existing] = await db
    .select()
    .from(schema.routingRules)
    .where(eq(schema.routingRules.id, c.req.param("id")))
    .limit(1);
  if (!existing) throw new NotFound();

  const scope = await scopeFor(c, existing.projectId ?? undefined);
  await assertCan(actor, "project.update", scope);

  await db.delete(schema.routingRules).where(eq(schema.routingRules.id, c.req.param("id")));
  await record(scope.ownerOrgId ?? null, actor, "rule.deleted", c.req.param("id"), {
    name: existing.name,
  });

  return c.json({ ok: true });
});
