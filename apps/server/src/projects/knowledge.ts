import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "../db";

/* What a project knows about itself, beyond its code.
 *
 * A project usually already exists somewhere before Maestro ever touches it —
 * a checkout on a machine, a staging URL, a port nothing else is using — and
 * re-explaining that in every conversation is exactly the kind of thing that
 * should be written down once. This module is the one place that reads and
 * writes it; both the settings UI and the agent's own tools (tasks/knowledge-
 * tools.ts) go through it, so there is one notion of what "the project root"
 * or "a registered fact" means.
 *
 * The workspace root is not stored here — it already has a home on
 * `workspaces.path`, keyed by (project, node), and duplicating it into this
 * table would just be a second place for the two to disagree. */

export type NoteKind = "directory" | "url" | "port" | "memory";

export interface ProjectNote {
  id: string;
  kind: NoteKind;
  label: string | null;
  value: string;
  nodeId: string | null;
  nodeName: string | null;
  createdAt: number;
}

export interface WorkspaceEntry {
  nodeId: string;
  nodeName: string;
  path: string;
  provisionedAt: number | null;
}

export interface ProjectKnowledge {
  /* Reuses `projects.instructions`, which is already prepended to every
     task's system prompt — a project brief and a standing instruction are the
     same thing in practice, so this is a second name for one field rather
     than a second field. */
  brief: string | null;
  workspaces: WorkspaceEntry[];
  notes: ProjectNote[];
}

export async function getKnowledge(projectId: string): Promise<ProjectKnowledge> {
  const [project] = await db
    .select({ instructions: schema.projects.instructions })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);

  const workspaces = await db
    .select({
      nodeId: schema.workspaces.nodeId,
      nodeName: schema.nodes.name,
      path: schema.workspaces.path,
      provisionedAt: schema.workspaces.provisionedAt,
    })
    .from(schema.workspaces)
    .innerJoin(schema.nodes, eq(schema.workspaces.nodeId, schema.nodes.id))
    .where(eq(schema.workspaces.projectId, projectId));

  const notes = await db
    .select({
      id: schema.projectNotes.id,
      kind: schema.projectNotes.kind,
      label: schema.projectNotes.label,
      value: schema.projectNotes.value,
      nodeId: schema.projectNotes.nodeId,
      nodeName: schema.nodes.name,
      createdAt: schema.projectNotes.createdAt,
    })
    .from(schema.projectNotes)
    .leftJoin(schema.nodes, eq(schema.projectNotes.nodeId, schema.nodes.id))
    .where(eq(schema.projectNotes.projectId, projectId))
    .orderBy(desc(schema.projectNotes.createdAt));

  return {
    brief: project?.instructions ?? null,
    workspaces: workspaces.filter((w) => w.path),
    notes: notes.map((n) => ({ ...n, nodeName: n.nodeName ?? null })),
  };
}

export async function setBrief(projectId: string, text: string | null): Promise<void> {
  await db
    .update(schema.projects)
    .set({ instructions: text })
    .where(eq(schema.projects.id, projectId));
}

/* Where the project lives on one machine. Keyed by (project, node) — the same
 * pair a task is dispatched against — so setting it again for a machine
 * replaces the old path rather than adding a second, ambiguous one.
 *
 * This is read once, at the moment a task is handed to a node, and fixed for
 * that task's whole lifetime (nodes/src/client.ts opens the workspace at
 * accept-time and every tool call for that task resolves against it). A call
 * made mid-task changes where the *next* task on this node starts, not the
 * one currently running — there is no way to relocate a task that has already
 * started without the risk of a tool call resolving against a directory that
 * changed out from under it mid-conversation. */
export async function setWorkspacePath(
  projectId: string,
  nodeId: string,
  path: string,
): Promise<void> {
  await db
    .insert(schema.workspaces)
    .values({
      id: crypto.randomUUID(),
      projectId,
      nodeId,
      path,
      branch: null,
      provisionedAt: Date.now(),
      createdAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: [schema.workspaces.projectId, schema.workspaces.nodeId],
      set: { path, provisionedAt: Date.now() },
    });
}

/* A labelled fact: a directory, a URL, or a port. Registering the same label
 * twice replaces the value — "project root" (or "docs", or "staging") should
 * have one current answer, not a growing history of every value it once had. */
export async function upsertFact(
  projectId: string,
  kind: Exclude<NoteKind, "memory">,
  label: string,
  value: string,
  nodeId: string | null,
): Promise<{ id: string }> {
  await db
    .insert(schema.projectNotes)
    .values({
      id: crypto.randomUUID(),
      projectId,
      kind,
      label,
      value,
      nodeId,
      createdAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: [schema.projectNotes.projectId, schema.projectNotes.kind, schema.projectNotes.label],
      set: { value, nodeId, createdAt: Date.now() },
    });

  const [row] = await db
    .select({ id: schema.projectNotes.id })
    .from(schema.projectNotes)
    .where(
      and(
        eq(schema.projectNotes.projectId, projectId),
        eq(schema.projectNotes.kind, kind),
        eq(schema.projectNotes.label, label),
      ),
    )
    .limit(1);

  return { id: row!.id };
}

/* Free text, always appended rather than replacing anything — a memory is a
 * note to a future task, not a fact with one current value. */
export async function addMemory(projectId: string, text: string): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  await db.insert(schema.projectNotes).values({
    id,
    projectId,
    kind: "memory",
    label: null,
    value: text,
    nodeId: null,
    createdAt: Date.now(),
  });
  return { id };
}

export async function deleteNote(projectId: string, noteId: string): Promise<boolean> {
  const deleted = await db
    .delete(schema.projectNotes)
    .where(and(eq(schema.projectNotes.id, noteId), eq(schema.projectNotes.projectId, projectId)))
    .returning({ id: schema.projectNotes.id });
  return deleted.length > 0;
}
