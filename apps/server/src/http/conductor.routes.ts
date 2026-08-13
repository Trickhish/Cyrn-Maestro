import { Hono } from "hono";
import { z } from "zod";
import { db, schema } from "../db";
import { askConductor, CONDUCTOR_LIST_NAME } from "../conductor/runner";
import { loadThread, remember, thread } from "../conductor/thread";
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
  /* Keeps the question out of the thread while still recording the answer.
     Nothing in the interface sends it any more — the follow-up that used to
     lives on the server now (conductor/followup.ts), which writes the thread
     directly. Kept so an older client is not rejected. */
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

/* The thread as it stands, so reopening the page continues rather than
   restarts — and so a browser polling this sees follow-ups written by the
   background job while it was sitting there. */
conductorRoutes.get("/history", async (c) => {
  const actor = requireActor(c);
  const rows = await loadThread(actor.id, c.req.query("projectId"));
  return c.json({
    messages: rows.map((r) => {
      const tools = (r.tools ?? []) as Array<{ name: string; args: unknown; result: string }>;
      return {
        /* Sent so a poller can tell "same thread" from "something was added"
           without diffing content. */
        id: r.id,
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

/* Streamed rather than a single JSON reply so the chat can narrate the turn as
   it happens — a `progress` frame per model turn and tool call, then one `done`
   frame carrying the whole answer, or an `error` frame instead. The final
   payload is exactly what the JSON reply used to be, so the only client change
   is reading the last frame rather than the body. */
conductorRoutes.post("/ask", async (c) => {
  const actor = requireActor(c);

  const parsed = Ask.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Ask something.");

  const projectId = parsed.data.projectId;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

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
          (event) => send("progress", event),
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

        send("done", {
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
            call.name === "create_task"
              ? [...call.result.matchAll(/\[([0-9a-f-]{8,})\]/gi)].map((m) => m[1])
              : [],
          ),
          usage: turn.usage,
          model: turn.model,
        });
      } catch (err) {
        if (err instanceof NoProviderError) {
          send("error", { error: err.message });
        } else if (err instanceof ProviderError) {
          send("error", { error: err.message, retryable: err.retryable });
        } else {
          /* Headers are already out, so we cannot answer 500 — report it as an
             error frame and log it the way the global handler otherwise would. */
          console.error("conductor /ask failed", err);
          send("error", { error: "The Conductor hit an unexpected error." });
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* Client already gone. */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
});
