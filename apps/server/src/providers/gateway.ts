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

type OwnerScope = { ownerUserId?: string | null; ownerOrgId?: string | null };

/* Every enabled model across the owner's own enabled provider connections —
   the raw set that both fallback candidates and model-list resolution pick
   from. Shared so the two never drift into judging "usable" differently. */
async function usableModelsFor(owner: OwnerScope) {
  const connections = await db
    .select()
    .from(schema.providerConnections)
    .where(
      and(
        owner.ownerOrgId
          ? eq(schema.providerConnections.ownerOrgId, owner.ownerOrgId)
          : eq(schema.providerConnections.ownerUserId, owner.ownerUserId!),
        eq(schema.providerConnections.enabled, true),
      ),
    );

  return (
    await Promise.all(
      connections.map((connection) =>
        db
          .select()
          .from(schema.models)
          .where(and(eq(schema.models.providerId, connection.id), eq(schema.models.enabled, true))),
      ),
    )
  ).flat();
}

/* Candidates for a task, best first: the one the router chose, then the models
   it would fall back to. Used when a provider rate-limits mid-run — the task
   moves to the next candidate rather than dying. */
export async function candidatesFor(owner: OwnerScope, firstChoice: string): Promise<string[]> {
  const models = await usableModelsFor(owner);

  const [chosen] = models.filter((m) => m.modelId === firstChoice);
  const wantedTier = chosen?.tier ?? "standard";

  /* Only same-or-higher tier: falling back to a smaller model would turn a
     transient rate limit into a quietly worse answer. */
  const order = { light: 0, standard: 1, heavy: 2 } as const;
  const fallbacks = models
    .filter((m) => m.probeOk !== false && m.modelId !== firstChoice)
    .filter((m) => order[m.tier as keyof typeof order] >= order[wantedTier as keyof typeof order])
    .sort((a, b) => (a.priceOutPerMTok ?? 0) - (b.priceOutPerMTok ?? 0))
    .map((m) => m.modelId);

  return [firstChoice, ...fallbacks];
}

/* Resolves a named model list to one concrete, currently-usable model id —
 * walking entries in preference order and, for a group entry, that group's
 * own members in their order, until one is actually connected, enabled and
 * not known to be failing its probe. This is the "tried one by one until one
 * is available" behaviour lists were built for; nothing has called it until
 * the Conductor needed to hand a worker task a model by category rather than
 * a raw id. */
export async function resolveModelList(
  owner: OwnerScope,
  listName: string,
): Promise<{ modelId: string } | { error: string }> {
  const members = await modelListMembers(owner, listName);
  if ("error" in members) return members;
  return members.models.length > 0
    ? { modelId: members.models[0] }
    : { error: `No model in "${listName}" is currently available.` };
}

/* Every currently-usable model a list resolves to, in its own preference
   order — the same walk resolveModelList does, without stopping at the first
   hit. Resolving is what dispatch needs; the whole set is what a picker needs,
   and what constrains an override to the list the user actually chose. */
export async function modelListMembers(
  owner: OwnerScope,
  listName: string,
): Promise<{ models: string[] } | { error: string }> {
  const [list] = await db
    .select()
    .from(schema.modelLists)
    .where(
      and(
        owner.ownerOrgId
          ? eq(schema.modelLists.ownerOrgId, owner.ownerOrgId)
          : eq(schema.modelLists.ownerUserId, owner.ownerUserId!),
        eq(schema.modelLists.name, listName),
      ),
    )
    .limit(1);

  if (!list) {
    const names = await db
      .select({ name: schema.modelLists.name })
      .from(schema.modelLists)
      .where(
        owner.ownerOrgId
          ? eq(schema.modelLists.ownerOrgId, owner.ownerOrgId)
          : eq(schema.modelLists.ownerUserId, owner.ownerUserId!),
      );
    return {
      error:
        names.length > 0
          ? `No model list named "${listName}". Available: ${names.map((n) => n.name).join(", ")}.`
          : `No model list named "${listName}", and none exist yet.`,
    };
  }

  const entries = await db
    .select()
    .from(schema.modelListEntries)
    .where(eq(schema.modelListEntries.listId, list.id))
    .orderBy(schema.modelListEntries.position);

  const usable = new Set(
    (await usableModelsFor(owner)).filter((m) => m.probeOk !== false).map((m) => m.modelId),
  );

  const models: string[] = [];
  for (const entry of entries) {
    if (entry.modelId) {
      if (usable.has(entry.modelId)) models.push(entry.modelId);
      continue;
    }
    if (entry.groupId) {
      const members = await db
        .select()
        .from(schema.modelGroupMembers)
        .where(eq(schema.modelGroupMembers.groupId, entry.groupId))
        .orderBy(schema.modelGroupMembers.position);
      /* A group stands in for one model, so it contributes its own first
         usable member and not every variant of the same thing. */
      const member = members.find((m) => usable.has(m.modelId));
      if (member) models.push(member.modelId);
    }
  }

  return { models: [...new Set(models)] };
}

/* Owner scope, not actor. The member running the task is irrelevant to which
   account pays for it. */
export async function resolveProvider(
  owner: { ownerUserId?: string | null; ownerOrgId?: string | null },
  preferredModel?: string | null,
): Promise<ResolvedProvider> {
  if (!owner.ownerOrgId && !owner.ownerUserId) {
    throw new NoProviderError("This project has no owner, so there are no credentials to use.");
  }

  /* The owner's connections and nobody else's. An org project never reaches
     for the member's personal key, and a personal project never reaches for an
     org's — in either direction that would misattribute the cost and push the
     work through an account whoever owns it does not control. */
  const connections = await db
    .select()
    .from(schema.providerConnections)
    .where(
      and(
        owner.ownerOrgId
          ? eq(schema.providerConnections.ownerOrgId, owner.ownerOrgId)
          : eq(schema.providerConnections.ownerUserId, owner.ownerUserId!),
        eq(schema.providerConnections.enabled, true),
      ),
    );

  if (connections.length === 0) {
    throw new NoProviderError(
      owner.ownerOrgId
        ? "This organization has no provider connected, so its tasks cannot run. An organization admin can add one in Organization → Providers."
        : "No provider is connected for this project's owner. Add one in Settings → Providers.",
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
