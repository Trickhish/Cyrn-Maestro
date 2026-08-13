import { Hono } from "hono";
import { and, desc, eq, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { askConductor, CONDUCTOR_LIST_NAME } from "../conductor/runner";
import { NoProviderError, modelListMembers } from "../providers/gateway";
import { ProviderError } from "../providers/types";
import { can, projectScope } from "../lib/permissions";
import { BadRequest, requireActor, type Env } from "./context";

export const conductorRoutes = new Hono<Env>();

/* Which models the Conductor may run on: its profile's own currently-usable
   members, best first. The interface offers exactly these, so forcing one is
   a choice within the profile rather than a way around it — the list is what
   says which models are fit to coordinate. */
conductorRoutes.get("/models", async (c) => {
  const actor = requireActor(c);
  const projectId = c.req.query("projectId");

  const project = projectId ? await projectScope(projectId) : null;
  const scope =
    project && (await can(actor, "task.run", project))
      ? project
      : { ownerUserId: actor.id, ownerOrgId: null };

  const members = await modelListMembers(scope, CONDUCTOR_LIST_NAME);

  return c.json({
    profile: CONDUCTOR_LIST_NAME,
    /* Empty when there is no such profile, or nothing in it is up. The
       Conductor still runs — it falls back to default routing — so this is a
       "nothing to choose between" signal, not an error. */
    models: "models" in members ? members.models : [],
  });
});

const Ask = z.object({
  question: z.string().min(1, "Ask something."),
  /* The client holds the thread. v0.1 keeps no server-side Conductor history —
     conductor_threads lands with organizations, where a durable per-member
     thread actually earns its keep. */
  /* The thread lives on the server now, so nothing needs sending. Kept only
     so an older client posting one is not rejected — it is ignored. */
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .max(40)
    .optional(),
  /* Set for the follow-up the interface fires itself when a dispatched task
     finishes. The answer belongs in the thread; the question does not, because
     the user never typed it. */
  silent: z.boolean().optional(),
  /* Set when the Conductor is embedded on a specific project's own page —
     its tools then default to that project rather than needing the model to
     be told or to ask which one. */
  projectId: z.string().optional(),
  /* Whatever the user pinned by hand in the routing chips, so a dispatch the
     Conductor makes without choosing a model of its own still honours it. */
  pinnedModel: z.string().optional(),
  pinnedNodeId: z.string().optional(),
  pinnedModelList: z.string().optional(),
  /* Overrides the model the Conductor itself reasons on, ahead of its own
     profile. */
  conductorModel: z.string().optional(),
});

/* How much of a thread is kept.
 *
 * Enough that the Conductor knows what you just asked it to do, and that
 * reopening the page continues a conversation rather than starting one. Not so
 * much that it becomes an archive: old turns cost tokens on every call and
 * answer questions nobody is asking any more. Trimmed on write, so the bound
 * holds without a sweeper. */
const THREAD_LIMIT = 40;

/* One thread per person per project. The global screen is its own, with a null
   projectId — and `isNull` rather than `eq(null)`, which matches nothing. */
const thread = (actorId: string, projectId?: string) =>
  and(
    eq(schema.conductorMessages.actorUserId, actorId),
    projectId
      ? eq(schema.conductorMessages.projectId, projectId)
      : isNull(schema.conductorMessages.projectId),
  );

async function loadThread(actorId: string, projectId?: string) {
  const rows = await db
    .select()
    .from(schema.conductorMessages)
    .where(thread(actorId, projectId))
    .orderBy(desc(schema.conductorMessages.createdAt))
    .limit(THREAD_LIMIT);
  return rows.reverse();
}

async function remember(
  actorId: string,
  projectId: string | undefined,
  role: "user" | "assistant",
  content: string,
  model?: string,
  tools?: unknown,
) {
  if (!content.trim()) return;

  await db.insert(schema.conductorMessages).values({
    id: crypto.randomUUID(),
    projectId: projectId ?? null,
    actorUserId: actorId,
    role,
    content,
    model: model ?? null,
    tools: tools ?? null,
    createdAt: Date.now(),
  });

  /* Trim by id rather than a date cutoff: two turns in the same millisecond
     are ordinary, and a cutoff would keep or drop both. */
  const keep = await db
    .select({ id: schema.conductorMessages.id })
    .from(schema.conductorMessages)
    .where(thread(actorId, projectId))
    .orderBy(desc(schema.conductorMessages.createdAt))
    .limit(THREAD_LIMIT);

  /* Anything outside the newest THREAD_LIMIT goes. Only worth a query when the
     thread is actually at the bound. */
  if (keep.length === THREAD_LIMIT) {
    await db
      .delete(schema.conductorMessages)
      .where(
        and(
          thread(actorId, projectId),
          notInArray(
            schema.conductorMessages.id,
            keep.map((k) => k.id),
          ),
        ),
      );
  }
}

/* The thread as it stands, so reopening the page continues rather than
   restarts. */
conductorRoutes.get("/history", async (c) => {
  const actor = requireActor(c);
  const rows = await loadThread(actor.id, c.req.query("projectId"));
  return c.json({
    messages: rows.map((r) => {
      const tools = (r.tools ?? []) as Array<{ name: string; args: unknown; result: string }>;
      return {
        role: r.role,
        content: r.content,
        model: r.model,
        usedTools: tools,
        /* Derived rather than stored a second time: the tool's own result is
           the authority on what was dispatched, here as much as on /ask. */
        dispatched: tools.flatMap((t) =>
          t.name === "create_task"
            ? [...String(t.result).matchAll(/\[([0-9a-f-]{8,})\]/gi)].map((m) => m[1])
            : [],
        ),
      };
    }),
  });
});

conductorRoutes.delete("/history", async (c) => {
  const actor = requireActor(c);
  await db.delete(schema.conductorMessages).where(thread(actor.id, c.req.query("projectId")));
  return c.json({ ok: true });
});

conductorRoutes.post("/ask", async (c) => {
  const actor = requireActor(c);

  const parsed = Ask.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Ask something.");

  const projectId = parsed.data.projectId;

  try {
    /* Read from the thread rather than trusting what the client sends: it is
       the same conversation the interface renders, and it is what lets the
       Conductor know what was asked of it before the page was reloaded. */
    const history = (await loadThread(actor.id, projectId)).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const turn = await askConductor(
      actor,
      history,
      parsed.data.question,
      c.req.raw.signal,
      {
        projectId: parsed.data.projectId,
        pinnedModel: parsed.data.pinnedModel,
        pinnedNodeId: parsed.data.pinnedNodeId,
        pinnedModelList: parsed.data.pinnedModelList,
        conductorModel: parsed.data.conductorModel,
      },
    );

    if (!parsed.data.silent) await remember(actor.id, projectId, "user", parsed.data.question);
    await remember(
      actor.id,
      projectId,
      "assistant",
      turn.text,
      turn.model,
      turn.toolCalls.map((call) => ({ name: call.name, args: call.args, result: call.result })),
    );

    return c.json({
      text: turn.text,
      /* The tools it used, so the interface can show its work rather than
         asking the user to trust an unsourced answer. */
      usedTools: turn.toolCalls.map((call) => ({
        name: call.name,
        args: call.args,
        /* Sent so the chat can show its work the way a task thread does —
           what was asked and what came back, not just which tools ran. */
        result: call.result,
      })),
      /* What this turn actually dispatched, read from the tool's own result
         rather than from the model's prose — it does not reliably quote the
         id back, and a card the interface only draws when the sentence
         happens to mention one is a card that mostly does not appear. */
      dispatched: turn.toolCalls.flatMap((call) =>
        call.name === "create_task" ? [...call.result.matchAll(/\[([0-9a-f-]{8,})\]/gi)].map((m) => m[1]) : [],
      ),
      usage: turn.usage,
      model: turn.model,
    });
  } catch (err) {
    if (err instanceof NoProviderError) {
      return c.json({ error: err.message }, 400);
    }
    if (err instanceof ProviderError) {
      return c.json({ error: err.message, retryable: err.retryable }, 502);
    }
    throw err;
  }
});
