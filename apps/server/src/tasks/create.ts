import { and, eq } from "drizzle-orm";
import { newId } from "@maestro/protocol";
import { db, schema } from "../db";
import { append } from "./events";
import { startTask } from "./runner";
import { onlineNodes, loadOf, noteAssigned, sendToNode } from "../nodes/registry";
import { planRoute } from "../router";
import { assertCan, projectScope } from "../lib/permissions";
import { BadRequest, NotFound } from "../http/context";
import type { Actor } from "../lib/auth";

/* Task creation, factored out of the HTTP route so the Conductor can dispatch
   work the same way a human pressing the composer's button does — same
   permission check, same router, same spend rules. Nothing here is
   HTTP-specific; the route is a thin wrapper around this. */

export interface CreateTaskInput {
  projectId: string;
  prompt: string;
  title?: string;
  nodeId?: string;
  model?: string;
  /* Set only when the Conductor is dispatching, naming the thread that should
     hear how it went. Recorded on the task so the report can be triggered where
     the task finishes rather than by whoever happens to have a browser open —
     see conductor/followup.ts. `threadProjectId` is null for the global
     Conductor, which is not the same as the task's own project. */
  conductor?: { actorUserId: string; threadProjectId: string | null };
}

export interface CreatedTask {
  taskId: string;
  title: string;
  model: string;
  nodeName: string;
}

export async function createTask(actor: Actor, input: CreateTaskInput): Promise<CreatedTask> {
  const scope = await projectScope(input.projectId);
  if (!scope) throw new NotFound();
  await assertCan(actor, "task.run", scope);

  /* The router picks a node and a model and says why. An explicit choice from
     the caller wins; otherwise it scores what is actually available now.
     Nodes belong to whoever owns the PROJECT, not to whoever pressed the
     button — a member's personal laptop is not org capacity. */
  const plan = await planRoute({
    owner: scope,
    prompt: input.prompt,
    projectId: input.projectId,
    pinnedNodeId: input.nodeId ?? null,
    pinnedModel: input.model ?? null,
  });

  if (plan.blocked || !plan.node || !plan.model) {
    /* "Every node is busy" reads differently from "there are no nodes", and
       the router already knows which it is. */
    const online = onlineNodes(scope);
    const allBusy = online.length > 0 && online.every((n) => loadOf(n) >= n.maxConcurrentTasks);
    throw new BadRequest(
      allBusy
        ? "Every node is at capacity. Wait for a task to finish, or add another machine."
        : (plan.blocked ?? "Could not route this task."),
    );
  }

  const routedNode = plan.node;
  const routedModel = plan.model;
  const node = onlineNodes(scope).find((n) => n.nodeId === routedNode.picked.id)!;

  /* A workspace row per (project, node) so the node knows where to work. */
  const [existing] = await db
    .select()
    .from(schema.workspaces)
    .where(
      and(eq(schema.workspaces.projectId, input.projectId), eq(schema.workspaces.nodeId, node.nodeId)),
    )
    .limit(1);

  const workspace =
    existing ??
    (
      await db
        .insert(schema.workspaces)
        .values({
          id: crypto.randomUUID(),
          projectId: input.projectId,
          nodeId: node.nodeId,
          /* Empty means "the node decides", which it does by joining its
             workspace root with the project id. Storing the resolved path is
             the node's job to report back, not the server's to guess — the
             server does not know the node's filesystem layout. */
          path: "",
          branch: null,
          provisionedAt: Date.now(),
          createdAt: Date.now(),
        })
        .returning()
    )[0];

  const taskId = crypto.randomUUID();
  const title =
    input.title ?? input.prompt.split("\n")[0].slice(0, 80) + (input.prompt.length > 80 ? "…" : "");

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId: input.projectId,
    workspaceId: workspace.id,
    nodeId: node.nodeId,
    actorUserId: actor.id,
    title,
    prompt: input.prompt,
    status: "queued",
    model: routedModel.picked.id,
    /* Only true when the caller passed `model` themselves — the router's own
       default pick is not a pin, and stays free to fail over. */
    modelPinned: Boolean(input.model),
    conductorActorId: input.conductor?.actorUserId ?? null,
    conductorProjectId: input.conductor?.threadProjectId ?? null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    createdAt: Date.now(),
  });

  append(taskId, { kind: "status", status: "queued" });
  /* Recorded before anything runs, so the thread can always answer "why this
     machine and this model" without anyone reconstructing it afterwards. */
  append(taskId, {
    kind: "routing_decision",
    nodeName: plan.node.picked.name,
    model: routedModel.picked.id,
    because: `${plan.node.because}; ${plan.model.because}`,
  });
  append(taskId, { kind: "user_message", text: input.prompt, queued: false });

  /* Tell the node to make the workspace, then run. Not awaited: the caller
     returns immediately and the UI follows the event stream. */
  sendToNode(node.nodeId, {
    type: "task.assign",
    id: newId(),
    taskId,
    projectId: input.projectId,
    workspacePath: workspace.path || "",
    limits: { wallClockMs: 30 * 60 * 1000, maxToolCalls: 200 },
  });

  /* Counted against the node the moment it is sent, so a second dispatch a
     second later sees it rather than waiting for the next heartbeat. */
  noteAssigned(node.nodeId, taskId);

  void startTask(taskId);

  return { taskId, title, model: routedModel.picked.id, nodeName: node.name };
}
