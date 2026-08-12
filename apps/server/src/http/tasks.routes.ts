import { Hono } from "hono";
import { eq, desc, and } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { append, replayForDisplay, subscribe, lastSeq } from "../tasks/events";
import { startTask, steer, cancel, decideApproval, isRunning } from "../tasks/runner";
import { onlineNodes, loadOf, noteAssigned } from "../nodes/registry";
import { assertCan, projectScope, taskScope } from "../lib/permissions";
import { BadRequest, NotFound, requireActor, type Env } from "./context";

export const taskRoutes = new Hono<Env>();

const CreateTask = z.object({
  projectId: z.string(),
  prompt: z.string().min(1, "Describe what the agent should do."),
  title: z.string().max(120).optional(),
  nodeId: z.string().optional(),
  model: z.string().optional(),
});

taskRoutes.get("/", async (c) => {
  const actor = requireActor(c);
  const projectId = c.req.query("projectId");

  const rows = await db
    .select({
      id: schema.tasks.id,
      projectId: schema.tasks.projectId,
      title: schema.tasks.title,
      status: schema.tasks.status,
      model: schema.tasks.model,
      costUsd: schema.tasks.costUsd,
      createdAt: schema.tasks.createdAt,
      startedAt: schema.tasks.startedAt,
      endedAt: schema.tasks.endedAt,
      error: schema.tasks.error,
      nodeName: schema.nodes.name,
      projectName: schema.projects.name,
    })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.tasks.projectId, schema.projects.id))
    .leftJoin(schema.nodes, eq(schema.tasks.nodeId, schema.nodes.id))
    .where(
      projectId
        ? and(
            eq(schema.projects.ownerUserId, actor.id),
            eq(schema.tasks.projectId, projectId),
          )
        : eq(schema.projects.ownerUserId, actor.id),
    )
    .orderBy(desc(schema.tasks.createdAt))
    .limit(100);

  return c.json({ tasks: rows.map((t) => ({ ...t, running: isRunning(t.id) })) });
});

taskRoutes.post("/", async (c) => {
  const actor = requireActor(c);
  const parsed = CreateTask.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw new BadRequest("Check the form.", z.flattenError(parsed.error).fieldErrors);
  }

  const scope = await projectScope(parsed.data.projectId);
  if (!scope) throw new NotFound();
  await assertCan(actor, "task.run", scope);

  /* Manual dispatch in v0.1: the router lands in v0.4. Until then, honour the
     named node, or pick the least loaded online one so two tasks dispatched
     back to back do not pile onto the same machine while another sits idle. */
    /* Nodes belonging to whoever owns the PROJECT, not to whoever pressed the
     button. A member's personal laptop is not org capacity. */
  const available = onlineNodes(scope);

  if (available.length === 0) {
    throw new BadRequest("No node is online. Install one from Fleet → Add node, then try again.");
  }

  let node;
  if (parsed.data.nodeId) {
    node = available.find((n) => n.nodeId === parsed.data.nodeId);
    if (!node) throw new BadRequest("That node is not online.");
  } else {
    const withRoom = available.filter((n) => loadOf(n) < n.maxConcurrentTasks);
    /* Every node full is worth saying plainly — the alternative is a task that
       is accepted and then rejected by the node for reasons the user cannot
       see. */
    if (withRoom.length === 0) {
      throw new BadRequest(
        "Every node is at capacity. Wait for a task to finish, or add another machine.",
      );
    }
    node = withRoom.sort((a, b) => loadOf(a) - loadOf(b))[0];
  }

  /* A workspace row per (project, node) so the node knows where to work. */
  const [existing] = await db
    .select()
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.projectId, parsed.data.projectId),
        eq(schema.workspaces.nodeId, node.nodeId),
      ),
    )
    .limit(1);

  const workspace =
    existing ??
    (
      await db
        .insert(schema.workspaces)
        .values({
          id: crypto.randomUUID(),
          projectId: parsed.data.projectId,
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
    parsed.data.title ??
    parsed.data.prompt.split("\n")[0].slice(0, 80) +
      (parsed.data.prompt.length > 80 ? "…" : "");

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId: parsed.data.projectId,
    workspaceId: workspace.id,
    nodeId: node.nodeId,
    actorUserId: actor.id,
    title,
    prompt: parsed.data.prompt,
    status: "queued",
    model: parsed.data.model ?? null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    createdAt: Date.now(),
  });

  append(taskId, { kind: "status", status: "queued" });
  append(taskId, { kind: "user_message", text: parsed.data.prompt, queued: false });

  /* Tell the node to make the workspace, then run. Not awaited: the response
     returns immediately and the UI follows the event stream. */
  const { sendToNode } = await import("../nodes/registry");
  const { newId } = await import("@maestro/protocol");
  sendToNode(node.nodeId, {
    type: "task.assign",
    id: newId(),
    taskId,
    projectId: parsed.data.projectId,
    workspacePath: workspace.path || "",
    limits: { wallClockMs: 30 * 60 * 1000, maxToolCalls: 200 },
  });

  /* Counted against the node the moment it is sent, so a second dispatch a
     second later sees it rather than waiting for the next heartbeat. */
  noteAssigned(node.nodeId, taskId);

  void startTask(taskId);

  return c.json({ task: { id: taskId, title, status: "queued" } }, 201);
});

taskRoutes.get("/:id", async (c) => {
  const actor = requireActor(c);
  const scope = await taskScope(c.req.param("id"));
  if (!scope) throw new NotFound();
  await assertCan(actor, "task.read", scope);

  const [task] = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, c.req.param("id")))
    .limit(1);
  if (!task) throw new NotFound();

  return c.json({
    task: { ...task, running: isRunning(task.id) },
    events: await replayForDisplay(task.id),
  });
});

/* Server-sent events rather than a WebSocket: the stream is one-directional,
   it reconnects on its own, and it survives a proxy that only speaks HTTP. */
taskRoutes.get("/:id/stream", async (c) => {
  const actor = requireActor(c);
  const taskId = c.req.param("id");
  const scope = await taskScope(taskId);
  if (!scope) throw new NotFound();
  await assertCan(actor, "task.read", scope);

  /* Resume from where the client left off. Without this, a dropped connection
     silently loses whatever happened while it was gone. */
  const after = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

      const write = (event: { seq: number; kind: string }) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      for (const event of await replayForDisplay(taskId, after)) write(event);

      const unsubscribe = subscribe(taskId, write);

      /* Comment frames keep intermediaries from timing the connection out
         during a long tool call with no output. */
      const keepAlive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          closed = true;
        }
      }, 15_000);

      const stop = () => {
        closed = true;
        clearInterval(keepAlive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* Already closed by the client going away. */
        }
      };

      c.req.raw.signal.addEventListener("abort", stop, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      /* Tells nginx not to buffer, which would hold every event until the
         response completed and make the stream useless. */
      "x-accel-buffering": "no",
    },
  });
});

const Steer = z.object({ text: z.string().min(1) });

taskRoutes.post("/:id/steer", async (c) => {
  const actor = requireActor(c);
  const scope = await taskScope(c.req.param("id"));
  if (!scope) throw new NotFound();
  await assertCan(actor, "task.run", scope);

  const parsed = Steer.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Type a message first.");

  if (!steer(c.req.param("id"), parsed.data.text)) {
    throw new BadRequest("That task is not running, so there is nothing to steer.");
  }
  return c.json({ ok: true });
});

taskRoutes.post("/:id/cancel", async (c) => {
  const actor = requireActor(c);
  const scope = await taskScope(c.req.param("id"));
  if (!scope) throw new NotFound();
  await assertCan(actor, "task.cancel", scope);

  if (!cancel(c.req.param("id"))) throw new BadRequest("That task is not running.");
  return c.json({ ok: true });
});

const Decision = z.object({ callId: z.string(), approved: z.boolean() });

taskRoutes.post("/:id/approve", async (c) => {
  const actor = requireActor(c);
  const scope = await taskScope(c.req.param("id"));
  if (!scope) throw new NotFound();
  await assertCan(actor, "task.approve", scope);

  const parsed = Decision.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Send callId and approved.");

  const ok = await decideApproval(
    c.req.param("id"),
    parsed.data.callId,
    parsed.data.approved,
    actor.id,
  );
  if (!ok) throw new BadRequest("That approval has already been decided, or does not exist.");
  return c.json({ ok: true });
});

taskRoutes.get("/:id/seq", async (c) => {
  const actor = requireActor(c);
  const scope = await taskScope(c.req.param("id"));
  if (!scope) throw new NotFound();
  await assertCan(actor, "task.read", scope);
  return c.json({ seq: await lastSeq(c.req.param("id")) });
});
