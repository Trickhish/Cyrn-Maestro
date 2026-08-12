import { resolveProvider } from "../providers/gateway";
import { conductorToolDefinitions, runConductorTool } from "./tools";
import type { Actor } from "../lib/auth";
import type { ChatMessage } from "../providers/types";

/* The Conductor's loop.
 *
 * Same shape as the agent loop but with no node in it: tools resolve
 * in-process against the database, so a turn is model → tool → model with no
 * socket round trip and nothing to approve.
 *
 * Read-only by design at this stage. It reports on the fleet before it is
 * trusted to act on it, which is also why there is no create_task here yet —
 * the tool list is the whole permission boundary. */

const SYSTEM_PROMPT = `You are the Conductor inside Maestro, an orchestration console for AI coding agents.

You answer questions about the user's projects, machines and tasks by calling tools. You do not write code and you have no filesystem — other agents, running on the user's machines, do that work.

How to answer:
- Call tools rather than guessing. If you do not know, look it up.
- Lead with what needs the user's attention: anything blocked on an approval comes first.
- Be specific and short. "Two tasks are running, one has been waiting nine minutes for you" beats a paragraph.
- Refer to a task by its title, and include its id in square brackets so the interface can link it.
- Never invent a task, project, machine or number. If a tool returns nothing, say so plainly.
- Cost figures are only meaningful when the provider publishes prices. If they are absent, talk about tokens instead of claiming something was free.

You are currently read-only: you can report, but you cannot start, stop or approve anything. If the user asks you to, say that it is coming and tell them where in the interface they can do it now.`;

export interface ConductorTurn {
  text: string;
  toolCalls: Array<{ name: string; args: unknown; result: string }>;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

export async function askConductor(
  actor: Actor,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  question: string,
  signal?: AbortSignal,
): Promise<ConductorTurn> {
  /* Same ownership rule as a task: the Conductor runs on the user's own
     provider connection. */
  const provider = await resolveProvider({ ownerUserId: actor.id });

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
    { role: "user", content: question },
  ];

  const toolCalls: ConductorTurn["toolCalls"] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let text = "";

  /* Bounded: a read-only question that needs more than a handful of lookups is
     a question the model has misunderstood, and looping costs real money. */
  for (let turn = 0; turn < 6; turn++) {
    let turnText = "";
    const calls: Array<{ id: string; name: string; argumentsJson: string }> = [];

    for await (const event of provider.adapter.stream(
      {
        model: provider.model,
        messages,
        tools: conductorToolDefinitions(),
        maxTokens: 2048,
        reasoningEffort: provider.reasoningEffort,
      },
      signal,
    )) {
      if (event.type === "text") turnText += event.delta;
      if (event.type === "tool_call") calls.push(event.call);
      if (event.type === "usage") {
        usage.inputTokens += event.inputTokens;
        usage.outputTokens += event.outputTokens;
      }
    }

    if (calls.length === 0) {
      text = turnText || text;
      break;
    }

    messages.push({
      role: "assistant",
      content: turnText,
      toolCalls: calls,
    });

    for (const call of calls) {
      let args: unknown = {};
      try {
        args = JSON.parse(call.argumentsJson || "{}");
      } catch {
        /* Hand the error back and let it correct itself, same as the agent loop. */
      }

      const result = await runConductorTool(actor, call.name, args);
      toolCalls.push({ name: call.name, args, result });

      messages.push({ role: "tool", toolCallId: call.id, content: result });
    }

    text = turnText || text;
  }

  return { text, toolCalls, usage, model: provider.model };
}
