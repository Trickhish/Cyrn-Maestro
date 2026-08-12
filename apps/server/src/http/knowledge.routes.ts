import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { assertCan, projectScope } from "../lib/permissions";
import { record } from "../lib/audit";
import {
  getKnowledge,
  setBrief,
  setWorkspacePath,
  upsertFact,
  addMemory,
  deleteNote,
} from "../projects/knowledge";
import { BadRequest, NotFound, requireActor, type Env } from "./context";

export const knowledgeRoutes = new Hono<Env>();

/* Everything here is scoped to a project the caller can already reach —
   read needs project.read, every write needs project.update, matching how
   routing rules (a sibling per-project setting) are gated. */

knowledgeRoutes.get("/", async (c) => {
  const actor = requireActor(c);
  const projectId = c.req.query("projectId");
  if (!projectId) throw new BadRequest("projectId is required.");

  const scope = await projectScope(projectId);
  if (!scope) throw new NotFound();
  await assertCan(actor, "project.read", scope);

  return c.json(await getKnowledge(projectId));
});

const BriefInput = z.object({
  projectId: z.string().min(1),
  text: z.string().max(20_000).nullable(),
});

knowledgeRoutes.put("/brief", async (c) => {
  const actor = requireActor(c);
  const parsed = BriefInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Check the form.");

  const scope = await projectScope(parsed.data.projectId);
  if (!scope) throw new NotFound();
  await assertCan(actor, "project.update", scope);

  await setBrief(parsed.data.projectId, parsed.data.text?.trim() || null);
  await record(scope.ownerOrgId ?? null, actor, "project.brief_changed", parsed.data.projectId);

  return c.json({ ok: true });
});

const WorkspaceInput = z.object({
  projectId: z.string().min(1),
  nodeId: z.string().min(1),
  path: z.string().min(1).max(1000),
});

knowledgeRoutes.put("/workspace", async (c) => {
  const actor = requireActor(c);
  const parsed = WorkspaceInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Give a machine and a path.");

  const scope = await projectScope(parsed.data.projectId);
  if (!scope) throw new NotFound();
  await assertCan(actor, "project.update", scope);

  /* The node has to belong to the same owner as the project — otherwise this
     would let a project be pointed at a machine's filesystem someone else
     controls, which is a far more consequential mistake than a routing hint
     aimed at the wrong node. */
  const [node] = await db
    .select({ ownerUserId: schema.nodes.ownerUserId, ownerOrgId: schema.nodes.ownerOrgId })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, parsed.data.nodeId))
    .limit(1);
  if (!node) throw new NotFound();
  const sameOwner = scope.ownerOrgId
    ? node.ownerOrgId === scope.ownerOrgId
    : node.ownerUserId === scope.ownerUserId;
  if (!sameOwner) throw new BadRequest("That machine does not belong to this project's owner.");

  await setWorkspacePath(parsed.data.projectId, parsed.data.nodeId, parsed.data.path.trim());
  await record(scope.ownerOrgId ?? null, actor, "project.workspace_set", parsed.data.projectId, {
    nodeId: parsed.data.nodeId,
    path: parsed.data.path,
  });

  return c.json({ ok: true });
});

const FactInput = z.object({
  projectId: z.string().min(1),
  kind: z.enum(["directory", "url", "port"]),
  label: z.string().min(1).max(60),
  value: z.string().min(1).max(500),
  nodeId: z.string().nullish(),
});

knowledgeRoutes.post("/facts", async (c) => {
  const actor = requireActor(c);
  const parsed = FactInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Check the form.", z.flattenError(parsed.error).fieldErrors);

  const scope = await projectScope(parsed.data.projectId);
  if (!scope) throw new NotFound();
  await assertCan(actor, "project.update", scope);

  if (parsed.data.nodeId) {
    const [node] = await db
      .select({ ownerUserId: schema.nodes.ownerUserId, ownerOrgId: schema.nodes.ownerOrgId })
      .from(schema.nodes)
      .where(eq(schema.nodes.id, parsed.data.nodeId))
      .limit(1);
    const sameOwner =
      node &&
      (scope.ownerOrgId ? node.ownerOrgId === scope.ownerOrgId : node.ownerUserId === scope.ownerUserId);
    if (!sameOwner) throw new BadRequest("That machine does not belong to this project's owner.");
  }

  const { id } = await upsertFact(
    parsed.data.projectId,
    parsed.data.kind,
    parsed.data.label.trim(),
    parsed.data.value.trim(),
    parsed.data.nodeId ?? null,
  );
  await record(scope.ownerOrgId ?? null, actor, "project.fact_set", parsed.data.projectId, {
    kind: parsed.data.kind,
    label: parsed.data.label,
  });

  return c.json({ id }, 201);
});

const MemoryInput = z.object({
  projectId: z.string().min(1),
  text: z.string().min(1).max(2000),
});

knowledgeRoutes.post("/memories", async (c) => {
  const actor = requireActor(c);
  const parsed = MemoryInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Give something to remember.");

  const scope = await projectScope(parsed.data.projectId);
  if (!scope) throw new NotFound();
  await assertCan(actor, "project.update", scope);

  const { id } = await addMemory(parsed.data.projectId, parsed.data.text.trim());
  await record(scope.ownerOrgId ?? null, actor, "project.memory_added", parsed.data.projectId);

  return c.json({ id }, 201);
});

knowledgeRoutes.delete("/notes/:id", async (c) => {
  const actor = requireActor(c);

  const [note] = await db
    .select({ projectId: schema.projectNotes.projectId })
    .from(schema.projectNotes)
    .where(eq(schema.projectNotes.id, c.req.param("id")))
    .limit(1);
  if (!note) throw new NotFound();

  const scope = await projectScope(note.projectId);
  if (!scope) throw new NotFound();
  await assertCan(actor, "project.update", scope);

  await deleteNote(note.projectId, c.req.param("id"));
  await record(scope.ownerOrgId ?? null, actor, "project.note_removed", note.projectId);

  return c.json({ ok: true });
});
