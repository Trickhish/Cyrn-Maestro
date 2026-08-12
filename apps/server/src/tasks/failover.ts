import { candidatesFor, resolveProvider, toolDefinitions, type ResolvedProvider } from "../providers/gateway";
import type { ToolDefinition } from "../providers/types";
import { ProviderError, type ChatMessage, type StreamEvent } from "../providers/types";
import { append } from "./events";

/* Failover.
 *
 * A 429 or a 5xx is the provider having a bad moment, not the task being wrong.
 * Losing twenty minutes of work to one is indefensible, so the turn is retried
 * on the next candidate model.
 *
 * Two rules keep this from hiding problems:
 *
 *   Only retryable errors fail over. A 400 means the request itself is wrong,
 *   and sending it to a second model just produces the same error twice while
 *   spending money.
 *
 *   Failover is never silent. Every switch is appended to the thread, because a
 *   task that quietly finishes on a different model than the one shown in the
 *   header is a task whose cost and output nobody can explain afterwards. */

export interface FailoverContext {
  owner: { ownerUserId?: string | null; ownerOrgId?: string | null };
  taskId: string;
  system: string;
  messages: ChatMessage[];
  /* Tools beyond the node's own — load_skill, and later the MCP ones. */
  extraTools?: ToolDefinition[];
}

export async function* streamWithFailover(
  current: () => ResolvedProvider,
  replace: (provider: ResolvedProvider) => void,
  context: FailoverContext,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const startedWith = current().model;
  const candidates = await candidatesFor(context.owner, startedWith);

  let lastError: unknown;

  for (const [index, model] of candidates.entries()) {
    if (signal.aborted) return;

    if (index > 0) {
      /* Re-resolving picks up that model's own connection, price and reasoning
         requirement — a fallback is a different model, not the same one under a
         new name. */
      try {
        replace(await resolveProvider(context.owner, model));
      } catch {
        continue;
      }

      append(context.taskId, {
        kind: "assistant_message",
        text: `Switched to ${model} after ${startedWith} was unavailable.`,
        model,
      });
    }

    const provider = current();

    try {
      /* Buffered rather than forwarded as it arrives: once a delta has been
         yielded, the caller has already appended it, and a mid-stream failure
         would leave half a sentence in the thread that the retry then repeats.
         Turns are short enough that holding one is cheap. */
      const events: StreamEvent[] = [];

      for await (const event of provider.adapter.stream(
        {
          model: provider.model,
          messages: [{ role: "system", content: context.system }, ...context.messages],
          tools: [...toolDefinitions(), ...(context.extraTools ?? [])],
          maxTokens: 8192,
          reasoningEffort: provider.reasoningEffort,
        },
        signal,
      )) {
        events.push(event);
      }

      yield* events;
      return;
    } catch (err) {
      lastError = err;

      if (signal.aborted) return;

      /* A request the provider rejected as malformed will be rejected by the
         next one too. Only transient failures are worth another attempt. */
      if (!(err instanceof ProviderError) || !err.retryable) throw err;

      const isLast = index === candidates.length - 1;
      if (isLast) break;

      append(context.taskId, {
        kind: "log",
        stream: "stderr",
        chunk: `${provider.model} is unavailable (${err.status}). Trying another model.\n`,
      });
    }
  }

  throw lastError ?? new Error("Every available model refused this request.");
}
