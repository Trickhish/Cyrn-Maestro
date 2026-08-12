import { Hono } from "hono";
import { eq, desc, and } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { replayForDisplay, subscribe, lastSeq } from "../tasks/events";
import { steer, cancel, decideApproval, isRunning } from "../tasks/runner";
import { createTask } from "../tasks/create";
import { planRoute } from "../router";
import { assertCan, projectScope, taskScope } from "../lib/permissions";
import { BadRequest, NotFound, requireActor, type Env } from "./context";
import { record } from "../lib/audit";

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

  const created = await createTask(actor, parsed.data);

  return c.json({ task: { id: created.taskId, title: created.title, status: "queued" } }, 201);
});

/* What the router would do, without doing it.
 *
 * This is what makes automatic routing trustworthy: the composer shows the
 * node, the model and the reasoning BEFORE dispatch, with the alternatives
 * one click away. Explaining a choice after the fact is not the same thing. */
taskRoutes.post("/plan", async (c) => {
  const actor = requireActor(c);

  const parsed = z
    .object({
      projectId: z.string(),
      prompt: z.string().default(""),
      nodeId: z.string().optional(),
      model: z.string().optional(),
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Check the request.");

  const scope = await projectScope(parsed.data.projectId);
  if (!scope) throw new NotFound();
  await assertCan(actor, "task.read", scope);

  return c.json(
    await planRoute({
      owner: scope,
      prompt: parsed.data.prompt,
      projectId: parsed.data.projectId,
      pinnedNodeId: parsed.data.nodeId ?? null,
      pinnedModel: parsed.data.model ?? null,
      }),
  );
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

  /* Who let a command run on a real machine is exactly the question this log
     exists to answer. */
  await record(scope.ownerOrgId ?? null, actor, parsed.data.approved ? "task.approved" : "task.denied", c.req.param("id"), {
    callId: parsed.data.callId,
  });
  return c.json({ ok: true });
});

taskRoutes.get("/:id/seq", async (c) => {
  const actor = requireActor(c);
  const scope = await taskScope(c.req.param("id"));
  if (!scope) throw new NotFound();
  await assertCan(actor, "task.read", scope);
  return c.json({ seq: await lastSeq(c.req.param("id")) });
});
