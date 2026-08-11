import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { TOOL_SCHEMAS, TOOL_DESCRIPTIONS, TOOL_NAMES } from "@maestro/protocol";
import { db, schema } from "../db";
import { decryptSecret } from "../lib/crypto";
import { OpenAICompatibleAdapter } from "./openai";
import type { ProviderAdapter, ReasoningEffort, ToolDefinition } from "./types";

/* The gateway resolves which provider a task is allowed to use, and hands the
 * loop an adapter. The rule from the README, enforced in exactly one place:
 *
 *   A task uses the provider connections of the project's OWNER. Nothing else.
 *
 * There is no fallback in either direction. An org project with no usable
 * provider fails loudly rather than quietly borrowing the member's personal
 * key — that would misattribute cost and push the org's source through an
 * account the org does not control. */

export class NoProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoProviderError";
  }
}

export interface ResolvedProvider {
  connectionId: string;
  name: string;
  model: string;
  adapter: ProviderAdapter;
  priceInPerMTok?: number;
  priceOutPerMTok?: number;
  /* Carried from the model's probe result. The loop passes it on every call —
     without it these models refuse the request outright. */
  reasoningEffort?: ReasoningEffort;
}

/* Owner scope, not actor. The member running the task is irrelevant to which
   account pays for it. */
export async function resolveProvider(
  owner: { ownerUserId?: string | null; ownerOrgId?: string | null },
  preferredModel?: string | null,
): Promise<ResolvedProvider> {
  if (owner.ownerOrgId) {
    throw new NoProviderError(
      "Organization-owned projects are not available yet. Move this project to a personal owner.",
    );
  }
  if (!owner.ownerUserId) {
    throw new NoProviderError("This project has no owner, so there are no credentials to use.");
  }

  const connections = await db
    .select()
    .from(schema.providerConnections)
    .where(
      and(
        eq(schema.providerConnections.ownerUserId, owner.ownerUserId),
        eq(schema.providerConnections.enabled, true),
      ),
    );

  if (connections.length === 0) {
    throw new NoProviderError(
      "No provider is connected for this project's owner. Add one in Settings → Providers.",
    );
  }

  /* Prefer a connection that actually advertises the requested model, so a
     pinned model does not silently run on whichever connection sorts first. */
  for (const connection of connections) {
    const models = await db
      .select()
      .from(schema.models)
      .where(
        and(eq(schema.models.providerId, connection.id), eq(schema.models.enabled, true)),
      );

    /* A model that failed its probe is known-broken. Picking one as an
       automatic default would fail the user's first task for a reason that has
       nothing to do with what they asked for. A pinned model is still honoured
       — the user asked for it by name, and the provider error explains itself. */
    const usable = models.filter((m) => m.probeOk !== false);

    const chosen = preferredModel
      ? models.find((m) => m.modelId === preferredModel)
      : (usable.find((m) => m.probeOk === true) ?? usable[0]);

    if (!chosen) continue;

    return {
      connectionId: connection.id,
      name: connection.name,
      model: chosen.modelId,
      adapter: adapterFor(connection),
      priceInPerMTok: chosen.priceInPerMTok ?? undefined,
      priceOutPerMTok: chosen.priceOutPerMTok ?? undefined,
      reasoningEffort: chosen.needsReasoningEffort ? "low" : undefined,
    };
  }

  throw new NoProviderError(
    preferredModel
      ? `No connected provider offers the model "${preferredModel}".`
      : "The connected provider has no models enabled. Refresh its model list in Settings → Providers.",
  );
}

export function adapterFor(connection: {
  kind: string;
  baseUrl: string;
  encryptedKey: string;
}): ProviderAdapter {
  /* Decryption happens here and nowhere else, in-process, at call time. The
     plaintext key never reaches a node, the browser, or a log line. */
  const apiKey = decryptSecret(connection.encryptedKey);

  switch (connection.kind) {
    case "openai_compatible":
      return new OpenAICompatibleAdapter({ baseUrl: connection.baseUrl, apiKey });
    default:
      throw new NoProviderError(`Unsupported provider kind: ${connection.kind}`);
  }
}

/* The model's tool definitions, generated from the same Zod schemas the node
   validates against. One source, so the model can never be told about a
   parameter the node would reject. */
let cached: ToolDefinition[] | undefined;

export function toolDefinitions(): ToolDefinition[] {
  if (cached) return cached;

  cached = TOOL_NAMES.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    parameters: z.toJSONSchema(TOOL_SCHEMAS[name], { io: "input" }) as Record<string, unknown>,
  }));
  return cached;
}

export function estimateCost(
  usage: { inputTokens: number; outputTokens: number },
  prices: { priceInPerMTok?: number; priceOutPerMTok?: number },
): number {
  /* Null prices mean the provider does not publish one. Returning 0 would
     render as "$0.00" and read as free; the caller shows "unpriced" instead. */
  if (prices.priceInPerMTok === undefined && prices.priceOutPerMTok === undefined) return 0;
  const inCost = (usage.inputTokens / 1_000_000) * (prices.priceInPerMTok ?? 0);
  const outCost = (usage.outputTokens / 1_000_000) * (prices.priceOutPerMTok ?? 0);
  return inCost + outCost;
}
