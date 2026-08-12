import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { assertCan, projectScope } from "../lib/permissions";
import { record } from "../lib/audit";
import { BadRequest, NotFound, requireActor, activeScope, type Env } from "./context";

export const projectRoutes = new Hono<Env>();

const CreateProject = z.object({
  name: z.string().min(1).max(80),
  repoUrl: z.string().optional(),
  branch: z.string().optional(),
  instructions: z.string().max(20_000).optional(),
  defaultModelId: z.string().optional(),
});

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "project"
  );
}

projectRoutes.get("/", async (c) => {
  const actor = requireActor(c);
  const scope = activeScope(c);
  const rows = await db
    .select()
    .from(schema.projects)
    .where(
      scope.ownerOrgId
        ? eq(schema.projects.ownerOrgId, scope.ownerOrgId)
        : eq(schema.projects.ownerUserId, actor.id),
    )
    .orderBy(desc(schema.projects.createdAt));
  return c.json({ projects: rows });
});

projectRoutes.post("/", async (c) => {
  const actor = requireActor(c);
  const parsed = CreateProject.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw new BadRequest("Check the form.", z.flattenError(parsed.error).fieldErrors);
  }

  /* Slugs are unique per owner, so a second "API" gets a suffix rather than a
     constraint violation the user has to interpret. */
  const scope = activeScope(c);
  await assertCan(actor, "project.create", scope);

  const base = slugify(parsed.data.name);
  const taken = new Set(
    (
      await db
        .select({ slug: schema.projects.slug })
        .from(schema.projects)
        .where(
          scope.ownerOrgId
            ? eq(schema.projects.ownerOrgId, scope.ownerOrgId)
            : eq(schema.projects.ownerUserId, actor.id),
        )
    ).map((r) => r.slug),
  );

  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;

  const row = {
    id: crypto.randomUUID(),
    ownerUserId: scope.ownerOrgId ? null : actor.id,
    ownerOrgId: scope.ownerOrgId,
    name: parsed.data.name,
    slug,
    repoUrl: parsed.data.repoUrl ?? null,
    branch: parsed.data.branch ?? "main",
    instructions: parsed.data.instructions ?? null,
    defaultModelId: parsed.data.defaultModelId ?? null,
    spendCapUsd: null,
    createdAt: Date.now(),
  };

  await db.insert(schema.projects).values(row);
  await record(scope.ownerOrgId, actor, "project.created", row.id, { name: row.name });
  return c.json({ project: row }, 201);
});

projectRoutes.patch("/:id", async (c) => {
  const actor = requireActor(c);
  const scope = await projectScope(c.req.param("id"));
  if (!scope) throw new NotFound();
  await assertCan(actor, "project.update", scope);

  const parsed = CreateProject.partial().safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Check the form.");

  await db
    .update(schema.projects)
    .set({
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
      ...(parsed.data.repoUrl !== undefined ? { repoUrl: parsed.data.repoUrl } : {}),
      ...(parsed.data.branch !== undefined ? { branch: parsed.data.branch } : {}),
      ...(parsed.data.instructions !== undefined ? { instructions: parsed.data.instructions } : {}),
      ...(parsed.data.defaultModelId !== undefined
        ? { defaultModelId: parsed.data.defaultModelId }
        : {}),
    })
    .where(eq(schema.projects.id, c.req.param("id")));

  const [updated] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, c.req.param("id")))
    .limit(1);

  return c.json({ project: updated });
});

projectRoutes.delete("/:id", async (c) => {
  const actor = requireActor(c);
  const scope = await projectScope(c.req.param("id"));
  if (!scope) throw new NotFound();
  await assertCan(actor, "project.delete", scope);

  await db.delete(schema.projects).where(eq(schema.projects.id, c.req.param("id")));
  await record(scope.ownerOrgId ?? null, actor, "project.deleted", c.req.param("id"));
  return c.json({ ok: true });
});
