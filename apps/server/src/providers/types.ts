/* The gateway's internal shape.
 *
 * The agent loop only ever sees these types, never a provider's wire format.
 * That is what makes "switch this task to a different model mid-flight" a
 * routing decision rather than a rewrite of the loop. */

export interface ToolDefinition {
  name: string;
  description: string;
  /* JSON Schema. Generated from the protocol's Zod schemas so the model is
     told exactly what the node will accept. */
  parameters: Record<string, unknown>;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  /* Raw JSON text as the model produced it. Parsed and validated at the edge,
     because a model can and will emit malformed JSON here. */
  argumentsJson: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCallRequest[] }
  | { role: "tool"; toolCallId: string; content: string };

export type ReasoningEffort = "low" | "medium" | "high";

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  /* Some models refuse a request that does not ask for reasoning. Set from the
     model's probe result rather than guessed per call. */
  reasoningEffort?: ReasoningEffort;
}

export type StreamEvent =
  /* Text as it arrives, for live rendering. */
  | { type: "text"; delta: string }
  /* Emitted once a tool call is fully assembled, never per fragment. */
  | { type: "tool_call"; call: ToolCallRequest }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; finishReason: FinishReason };

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error";

export interface ProbeResult {
  ok: boolean;
  error?: string;
  /* True when the model only answered once reasoning was requested. */
  needsReasoningEffort?: boolean;
}

export interface ModelInfo {
  id: string;
  contextWindow?: number;
  priceInPerMTok?: number;
  priceOutPerMTok?: number;
}

export interface ProviderAdapter {
  readonly kind: string;
  listModels(): Promise<ModelInfo[]>;
  /* Cheap check that a listed model can actually be called. Providers routinely
     advertise models they cannot route, or that need extra parameters. */
  probe(modelId: string, signal?: AbortSignal): Promise<ProbeResult>;
  stream(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent>;
}

/* Provider failures the loop has to tell apart: a rate limit is worth retrying
   on another connection, a bad request is not. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
