import { parseSSE } from "./sse";
import {
  ProviderError,
  type ChatMessage,
  type ChatRequest,
  type ModelInfo,
  type ProbeResult,
  type ProviderAdapter,
  type ReasoningEffort,
  type StreamEvent,
  type FinishReason,
  type ToolCallRequest,
} from "./types";

/* The recoverable probe failure: the model refuses a request that does not ask
   for reasoning, and answers normally once it does. Matched on the provider's
   own wording, deliberately loosely — the strategy name carries a date stamp
   that will change. */
function needsReasoning(message?: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes("thinking") && lower.includes("enabled");
}

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
      /* Standard on /v1/models, and the only thing in the response that says
         which upstream a proxied model actually comes from. */
      ownedBy: typeof m.owned_by === "string" && m.owned_by ? m.owned_by : undefined,
      root: typeof m.root === "string" && m.root ? m.root : undefined,
      parent: typeof m.parent === "string" && m.parent ? m.parent : undefined,
    }));
  }

  /* /v1/models over-advertises: a gateway lists models it cannot actually
     route, and models that refuse a plain request. Asking for a few tokens is
     the cheapest way to find out, and it is the difference between a model
     picker that works and one that fails at the first real task.
   *
     Two attempts, because the common failure is recoverable: Claude models
     behind CLIProxyAPI reject a request that does not ask for reasoning, and
     answer normally once it does. */
  async probe(modelId: string, signal?: AbortSignal): Promise<ProbeResult> {
    const plain = await this.probeOnce(modelId, undefined, signal);
    if (plain.ok) return { ok: true, needsReasoningEffort: false };

    if (!needsReasoning(plain.error)) return plain;

    const withReasoning = await this.probeOnce(modelId, "low", signal);
    return withReasoning.ok
      ? { ok: true, needsReasoningEffort: true }
      : withReasoning;
  }

  private async probeOnce(
    modelId: string,
    reasoningEffort: ReasoningEffort | undefined,
    signal?: AbortSignal,
  ): Promise<ProbeResult> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        signal,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 8,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        }),
      });

      if (!res.ok) {
        const err = await providerError(res, "probing a model");
        return { ok: false, error: err.message };
      }

      /* Some gateways stream whatever you ask for.
       *
       * A non-streaming request is answered with text/event-stream, so parsing
       * the body as JSON yields nothing and every model on the gateway looks
       * broken — which the router then refuses to use. Both shapes have to be
       * accepted, and a streamed answer is just as much proof that the model
       * works as a buffered one. */
      const contentType = res.headers.get("content-type") ?? "";

      if (contentType.includes("text/event-stream")) {
        const body = await res.text();

        for (const line of body.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;

          try {
            const frame = JSON.parse(data) as { choices?: unknown[]; error?: unknown };
            /* A gateway can also report a failure inside a 200 stream. */
            if (frame.error) {
              return { ok: false, error: describeStreamedError(frame.error) };
            }
            if (frame.choices) return { ok: true };
          } catch {
            /* Not a frame worth reading; keep looking. */
          }
        }

        return { ok: false, error: "The provider streamed no usable response." };
      }

      /* Some gateways answer 200 with an error body rather than a status. */
      const body = (await res.json().catch(() => null)) as { choices?: unknown[] } | null;
      if (!body?.choices) return { ok: false, error: "The provider returned no completion." };

      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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
        /* The proxy translates this into the upstream model's thinking config.
           A raw `thinking` block is dropped on the way through, so this is the
           parameter that actually takes effect. */
        ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
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

      /* A gateway can report a failure inside an otherwise-200 stream, after
         it has already sent keepalive frames — Omniroute does this for a
         Groq rate limit. Without this check the loop just finds no choices,
         finds no usage, and the turn quietly "completes" with nothing: the
         empty response looks identical to the model genuinely saying
         nothing, which is a much harder thing to debug than a thrown error. */
      if (chunk.error) {
        const message = describeStreamedError(chunk.error);
        throw new ProviderError(
          message.startsWith("[") ? message : `[${request.model}] ${message}`,
          429,
          true,
        );
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
  error?: unknown;
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

function describeStreamedError(error: unknown): string {
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : JSON.stringify(error).slice(0, 200);
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
