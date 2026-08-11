import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { config } from "../config";
import { createEnrollmentToken, revokeNode, getLiveNode } from "../nodes/registry";
import { BadRequest, NotFound, requireActor, type Env } from "./context";

export const nodeRoutes = new Hono<Env>();

nodeRoutes.get("/", async (c) => {
  const actor = requireActor(c);
  const rows = await db.select().from(schema.nodes).where(eq(schema.nodes.ownerUserId, actor.id));

  return c.json({
    nodes: rows.map((row) => {
      /* The database says what we last knew; the socket map says what is true
         now. A node whose process was killed has no socket but keeps a stale
         "online" row until something notices, so the live map wins. */
      const live = getLiveNode(row.id);
      return {
        id: row.id,
        name: row.name,
        status: live ? "online" : row.status === "revoked" ? "revoked" : "offline",
        os: row.os,
        arch: row.arch,
        version: row.version,
        capabilities: row.capabilities,
        maxConcurrentTasks: row.maxConcurrentTasks,
        runningTasks: live?.runningTaskIds.size ?? 0,
        lastSeenAt: row.lastSeenAt,
        loadPercent: row.loadPercent,
      };
    }),
  });
});

const CreateEnrollment = z.object({
  projectId: z.string().optional(),
});

/* Returns the one-command install line. The token is the URL path segment, so
   the script the server hands back is already personalised with the origin,
   the token and the project. */
nodeRoutes.post("/enroll", async (c) => {
  const actor = requireActor(c);
  const parsed = CreateEnrollment.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Check the request.");

  if (parsed.data.projectId) {
    const [project] = await db
      .select({ ownerUserId: schema.projects.ownerUserId })
      .from(schema.projects)
      .where(eq(schema.projects.id, parsed.data.projectId))
      .limit(1);
    if (!project || project.ownerUserId !== actor.id) throw new NotFound();
  }

  const token = await createEnrollmentToken(actor.id, parsed.data.projectId ?? null);

  return c.json({
    token,
    expiresInMs: config.enrollmentTtlMs,
    command: `curl -fsSL ${config.publicUrl}/install/${token} | sh`,
  });
});

nodeRoutes.delete("/:id", async (c) => {
  const actor = requireActor(c);
  if (!(await revokeNode(c.req.param("id"), actor.id))) throw new NotFound();
  return c.json({ ok: true });
});
