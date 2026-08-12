import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { config } from "../config";
import { createEnrollmentToken, revokeNode, getLiveNode, renameLiveNode } from "../nodes/registry";
import { assertCan, nodeScope, projectScope } from "../lib/permissions";
import { record } from "../lib/audit";
import { BadRequest, NotFound, requireActor, activeScope, type Env } from "./context";

export const nodeRoutes = new Hono<Env>();

nodeRoutes.get("/", async (c) => {
  const actor = requireActor(c);
  const scope = activeScope(c);
  const rows = await db
    .select()
    .from(schema.nodes)
    .where(
      scope.ownerOrgId
        ? eq(schema.nodes.ownerOrgId, scope.ownerOrgId)
        : eq(schema.nodes.ownerUserId, actor.id),
    );

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
        runningTasks: live ? Math.max(live.assigned.size, live.reported.size) : 0,
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

  const scope = activeScope(c);
  /* Enrolling a node into an org is an administrative act, not something any
     member can do — a node runs arbitrary commands on a real machine. */
  await assertCan(actor, "node.enroll", scope);

  if (parsed.data.projectId) {
    const projScope = await projectScope(parsed.data.projectId);
    if (!projScope) throw new NotFound();
    await assertCan(actor, "node.enroll", projScope);
  }

  const token = await createEnrollmentToken(scope, parsed.data.projectId ?? null);
  /* The token itself is never recorded — only that someone created the ability
     to add a machine that runs arbitrary commands. */
  await record(scope.ownerOrgId, actor, "node.enrollment_created", parsed.data.projectId ?? null);

  return c.json({
    token,
    expiresInMs: config.enrollmentTtlMs,
    command: `curl -fsSL ${config.publicUrl}/install/${token} | sh`,
  });
});

const RenameNode = z.object({ name: z.string().trim().min(1).max(60) });

/* Renaming does not touch the daemon at all — it is a label on the record, not
   an identity change. The install-time name (the hostname, or an explicit
   --name) is often not the name someone wants to see in a list of five nodes,
   and there is no reason renaming should require reinstalling. */
nodeRoutes.patch("/:id", async (c) => {
  const actor = requireActor(c);
  const scope = await nodeScope(c.req.param("id"));
  if (!scope) throw new NotFound();
  await assertCan(actor, "node.revoke", scope);

  const parsed = RenameNode.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Give it a name.");

  const updated = await db
    .update(schema.nodes)
    .set({ name: parsed.data.name })
    .where(eq(schema.nodes.id, c.req.param("id")))
    .returning({ id: schema.nodes.id });
  if (updated.length === 0) throw new NotFound();

  renameLiveNode(c.req.param("id"), parsed.data.name);
  await record(scope.ownerOrgId ?? null, actor, "node.renamed", c.req.param("id"), {
    name: parsed.data.name,
  });

  return c.json({ ok: true });
});

nodeRoutes.delete("/:id", async (c) => {
  const actor = requireActor(c);
  const scope = await nodeScope(c.req.param("id"));
  if (!scope) throw new NotFound();
  await assertCan(actor, "node.revoke", scope);

  if (!(await revokeNode(c.req.param("id"), scope))) throw new NotFound();
  await record(scope.ownerOrgId ?? null, actor, "node.revoked", c.req.param("id"));
  return c.json({ ok: true });
});
