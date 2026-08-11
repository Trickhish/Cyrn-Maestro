import { parseSSE } from "./sse";
import {
  ProviderError,
  type ChatMessage,
  type ChatRequest,
  type ModelInfo,
  type ProviderAdapter,
  type StreamEvent,
  type FinishReason,
  type ToolCallRequest,
} from "./types";

/* OpenAI chat-completions adapter.
 *
 * Covers CLIProxyAPI, OpenAI itself, OpenRouter, Groq, vLLM, Ollama and
 * LM Studio — anything speaking the same shape. */

interface Options {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly kind = "openai_compatible";
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: Options) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/models`, { headers: this.headers() });
    if (!res.ok) throw await providerError(res, "listing models");

    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    return (body.data ?? []).map((m) => ({
      id: String(m.id),
      contextWindow:
        typeof m.context_length === "number"
          ? m.context_length
          : typeof m.context_window === "number"
            ? m.context_window
            : undefined,
    }));
  }

  async *stream(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      signal,
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map(toWireMessage),
        stream: true,
        /* Not every OpenAI-compatible server honours this, so usage is still
           treated as optional below. Without it, OpenAI omits usage entirely
           on streamed responses and every task would report zero cost. */
        stream_options: { include_usage: true },
        ...(request.tools?.length
          ? {
              tools: request.tools.map((t) => ({
                type: "function",
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                },
              })),
              tool_choice: "auto",
            }
          : {}),
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      }),
    });

    if (!res.ok) throw await providerError(res, "starting a completion");
    if (!res.body) throw new ProviderError("The provider returned an empty response.", 502, true);

    /* Tool call fragments arrive interleaved and out of order, keyed by index,
       with `arguments` streamed as partial JSON text. Assembling them here —
       and only emitting once the stream ends — is the difference between
       working tool use and a parade of JSON parse errors. */
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: FinishReason = "stop";
    let sawUsage = false;

    for await (const data of parseSSE(res.body, signal)) {
      let chunk: OpenAIChunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        /* A malformed frame is not worth killing a long completion over. */
        continue;
      }

      if (chunk.usage) {
        sawUsage = true;
        yield {
          type: "usage",
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (choice.delta?.content) {
        yield { type: "text", delta: choice.delta.content };
      }

      for (const fragment of choice.delta?.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        const existing = pending.get(index) ?? { id: "", name: "", args: "" };
        pending.set(index, {
          /* Identity arrives on the first fragment only; later ones carry
             just an arguments delta, so never overwrite with an empty value. */
          id: fragment.id || existing.id,
          name: fragment.function?.name || existing.name,
          args: existing.args + (fragment.function?.arguments ?? ""),
        });
      }

      if (choice.finish_reason) {
        finishReason = normaliseFinish(choice.finish_reason);
      }
    }

    for (const [index, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      yield {
        type: "tool_call",
        call: {
          id: call.id || `call_${index}`,
          name: call.name,
          argumentsJson: call.args || "{}",
        } satisfies ToolCallRequest,
      };
    }

    /* Some servers report tool calls without setting finish_reason. Trusting
       the flag alone would end the turn while calls are outstanding. */
    if (pending.size > 0 && finishReason === "stop") finishReason = "tool_calls";

    if (!sawUsage) {
      yield { type: "usage", inputTokens: 0, outputTokens: 0 };
    }
    yield { type: "done", finishReason };
  }
}

/* ------------------------------------------------------------------ wire shapes */

interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        /* An assistant turn that only made tool calls has no text. The field
           must still be present, and null rather than "" — some servers reject
           an empty string alongside tool_calls. */
        content: message.content || null,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.argumentsJson },
              })),
            }
          : {}),
      };
    default:
      return { role: message.role, content: message.content };
  }
}

function normaliseFinish(reason: string): FinishReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

async function providerError(res: Response, doing: string): Promise<ProviderError> {
  const text = await res.text().catch(() => "");
  let detail = text.slice(0, 400);
  try {
    const parsed = JSON.parse(text);
    detail = parsed?.error?.message ?? detail;
  } catch {
    /* Not JSON — the raw body is the best detail available. */
  }

  /* 429 and 5xx are worth failing over to another connection; 4xx means the
     request itself is wrong and retrying it changes nothing. */
  const retryable = res.status === 429 || res.status >= 500;
  const hint =
    res.status === 401 || res.status === 403
      ? " Check MAESTRO_PROVIDER_API_KEY."
      : res.status === 404
        ? " Check MAESTRO_PROVIDER_BASE_URL — it should end in /v1."
        : "";

  return new ProviderError(
    `Provider failed while ${doing} (${res.status}).${hint}${detail ? ` ${detail}` : ""}`,
    res.status,
    retryable,
  );
}
