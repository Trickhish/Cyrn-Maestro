import { and, eq, desc, gte } from "drizzle-orm";
import { db, schema } from "../db";
import { onlineNodes, loadOf, type LiveNode } from "../nodes/registry";
import { weighTask, acceptableTiers, inferTier, type Tier } from "./weigh";

/* The router.
 *
 * Automatic by default, overridable at every level. It picks a node and a
 * model, and — the part that matters — it says why, before it acts. A router
 * that cannot be interrogated is a router nobody trusts, so every choice here
 * carries the sentence that will be shown in the composer chip and recorded in
 * the task's thread.
 *
 * v0.4 scores on what the server actually knows: capacity now, recent success,
 * and warm caches. Nothing here pretends to more insight than that. */

export interface Choice<T> {
  picked: T;
  because: string;
  /* What else was eligible, so the interface can offer a one-click override
     rather than making the user go and find the alternatives. */
  alternatives: T[];
}

export interface RoutingPlan {
  node: Choice<{ id: string; name: string }> | null;
  model: Choice<{ id: string; tier: Tier }> | null;
  tier: Tier;
  approvals: "ask_on_write" | "ask_on_all" | "auto";
  /* Set when the plan cannot be dispatched, with a sentence saying what to do
     about it. */
  blocked?: string;
  estimateUsd?: number;
}

export interface RouteInput {
  owner: { ownerUserId?: string | null; ownerOrgId?: string | null };
  prompt: string;
  /* Explicit choices from the caller, which always win over the router. */
  pinnedNodeId?: string | null;
  pinnedModel?: string | null;
  projectDefaultModel?: string | null;
  projectId: string;
}

export async function planRoute(input: RouteInput): Promise<RoutingPlan> {
  const weight = weighTask(input.prompt);

  const node = await chooseNode(input);
  const model = await chooseModel(input, weight.tier);

  const plan: RoutingPlan = {
    node,
    model,
    tier: model?.picked.tier ?? weight.tier,
    /* Writes ask by default. A workspace can opt out on the node, which is
       where the decision belongs — the machine owner decides. */
    approvals: "ask_on_write",
  };

  if (!node) {
    plan.blocked =
      "No node is online for this project's owner. Install one from Fleet → Add node.";
  } else if (!model) {
    plan.blocked = input.pinnedModel
      ? `No connected provider offers "${input.pinnedModel}".`
      : "No usable model is available. Refresh the provider's model list in Providers.";
  }

  return plan;
}

async function chooseNode(input: RouteInput): Promise<RoutingPlan["node"]> {
  const online = onlineNodes(input.owner);
  if (online.length === 0) return null;

  const describe = (n: LiveNode) => ({ id: n.nodeId, name: n.name });

  if (input.pinnedNodeId) {
    const pinned = online.find((n) => n.nodeId === input.pinnedNodeId);
    if (pinned) {
      return {
        picked: describe(pinned),
        because: "you picked this machine",
        alternatives: online.filter((n) => n.nodeId !== pinned.nodeId).map(describe),
      };
    }
  }

  const withRoom = online.filter((n) => loadOf(n) < n.maxConcurrentTasks);
  if (withRoom.length === 0) return null;

  /* A node that recently ran this project has a warm checkout and warm build
     caches, which is worth more than a marginal difference in free slots. */
  const recent = await db
    .select({ nodeId: schema.tasks.nodeId })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.projectId, input.projectId),
        gte(schema.tasks.createdAt, Date.now() - 6 * 3600_000),
      ),
    )
    .orderBy(desc(schema.tasks.createdAt))
    .limit(20);

  const warm = new Set(recent.map((r) => r.nodeId).filter(Boolean) as string[]);

  const scored = withRoom
    .map((node) => {
      const free = node.maxConcurrentTasks - loadOf(node);
      /* Free capacity dominates; warmth breaks ties and nudges an otherwise
         equal choice toward the machine that will start faster. */
      const score = free * 10 + (warm.has(node.nodeId) ? 3 : 0);
      return { node, score, free, warm: warm.has(node.nodeId) };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  const because = best.warm
    ? "idle, and it already has this project checked out"
    : best.free === best.node.maxConcurrentTasks
      ? "idle"
      : `the least loaded machine (${best.free} of ${best.node.maxConcurrentTasks} slots free)`;

  return {
    picked: describe(best.node),
    because,
    alternatives: scored.slice(1).map((s) => describe(s.node)),
  };
}

async function chooseModel(input: RouteInput, tier: Tier): Promise<RoutingPlan["model"]> {
  const connections = await db
    .select()
    .from(schema.providerConnections)
    .where(
      and(
        input.owner.ownerOrgId
          ? eq(schema.providerConnections.ownerOrgId, input.owner.ownerOrgId)
          : eq(schema.providerConnections.ownerUserId, input.owner.ownerUserId!),
        eq(schema.providerConnections.enabled, true),
      ),
    );

  if (connections.length === 0) return null;

  const rows = (
    await Promise.all(
      connections.map((connection) =>
        db
          .select()
          .from(schema.models)
          .where(
            and(eq(schema.models.providerId, connection.id), eq(schema.models.enabled, true)),
          ),
      ),
    )
  ).flat();

  /* A model that failed its probe is known-broken. Offering it as an automatic
     choice fails the user's first task for a reason unrelated to what they
     asked for. */
  const usable = rows.filter((m) => m.probeOk !== false);
  if (usable.length === 0) return null;

  const describe = (m: (typeof usable)[number]) => ({
    id: m.modelId,
    tier: (m.tier as Tier) ?? inferTier(m.modelId),
  });

  /* A pin is an explicit instruction. It is honoured even if the model looks
     wrong for the tier — the user asked for it by name. */
  if (input.pinnedModel) {
    const pinned = rows.find((m) => m.modelId === input.pinnedModel);
    if (!pinned) return null;
    return {
      picked: describe(pinned),
      because: "you pinned this model",
      alternatives: usable.filter((m) => m.modelId !== pinned.modelId).slice(0, 6).map(describe),
    };
  }

  if (input.projectDefaultModel) {
    const preferred = usable.find((m) => m.modelId === input.projectDefaultModel);
    if (preferred) {
      return {
        picked: describe(preferred),
        because: "the project's default model",
        alternatives: usable.filter((m) => m.modelId !== preferred.modelId).slice(0, 6).map(describe),
      };
    }
  }

  const wanted = acceptableTiers(tier);

  const ranked = usable
    .map((model) => {
      const modelTier = (model.tier as Tier) ?? inferTier(model.modelId);
      const rank = wanted.indexOf(modelTier);
      return { model, modelTier, rank };
    })
    /* Never below the tier the task needs: a heavy task on a light model
       produces a confident wrong answer, which is worse than failing. */
    .filter((entry) => entry.rank !== -1)
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      /* Within a tier, prefer the cheaper one where prices are known. */
      const priceA = a.model.priceOutPerMTok ?? Number.POSITIVE_INFINITY;
      const priceB = b.model.priceOutPerMTok ?? Number.POSITIVE_INFINITY;
      if (priceA !== priceB) return priceA - priceB;
      /* Otherwise prefer one that has actually been proven to answer. */
      return Number(b.model.probeOk === true) - Number(a.model.probeOk === true);
    });

  if (ranked.length === 0) return null;

  const best = ranked[0];
  const exact = best.modelTier === tier;

  return {
    picked: describe(best.model),
    because: exact
      ? `${tier} work`
      : `nothing in the ${tier} tier is available, so a ${best.modelTier} model instead`,
    alternatives: ranked.slice(1, 7).map((entry) => describe(entry.model)),
  };
}

export { weighTask, inferTier };
export type { Tier };
