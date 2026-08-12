import { Hono } from "hono";
import { z } from "zod";
import { askConductor } from "../conductor/runner";
import { NoProviderError } from "../providers/gateway";
import { ProviderError } from "../providers/types";
import { BadRequest, requireActor, type Env } from "./context";

export const conductorRoutes = new Hono<Env>();

const Ask = z.object({
  question: z.string().min(1, "Ask something."),
  /* The client holds the thread. v0.1 keeps no server-side Conductor history —
     conductor_threads lands with organizations, where a durable per-member
     thread actually earns its keep. */
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .max(40)
    .optional(),
  /* Set when the Conductor is embedded on a specific project's own page —
     its tools then default to that project rather than needing the model to
     be told or to ask which one. */
  projectId: z.string().optional(),
});

conductorRoutes.post("/ask", async (c) => {
  const actor = requireActor(c);

  const parsed = Ask.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new BadRequest("Ask something.");

  try {
    const turn = await askConductor(
      actor,
      parsed.data.history ?? [],
      parsed.data.question,
      c.req.raw.signal,
      { projectId: parsed.data.projectId },
    );

    return c.json({
      text: turn.text,
      /* The tools it used, so the interface can show its work rather than
         asking the user to trust an unsourced answer. */
      usedTools: turn.toolCalls.map((call) => ({ name: call.name, args: call.args })),
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
