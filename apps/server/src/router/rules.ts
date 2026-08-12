import { and, asc, eq, isNull, or } from "drizzle-orm";
import { db, schema } from "../db";
import type { Tier } from "./weigh";

/* The override ladder, in increasing priority:
 *
 *   1. organization defaults
 *   2. project defaults
 *   3. routing rules — project rules before organization ones
 *   4. the task's own pin
 *   5. manual dispatch
 *
 * Each level narrows the one above it. Levels 4 and 5 are handled by the
 * router itself, since a pin is an explicit instruction and needs no lookup;
 * this module resolves 1 to 3.
 *
 * Every resolved value carries the sentence explaining where it came from. A
 * choice a user cannot trace back to something they configured is a choice
 * they will assume is wrong. */

export interface Resolved<T> {
  value: T;
  because: string;
}

export interface Defaults {
  tier?: Resolved<Tier>;
  modelId?: Resolved<string>;
  nodeId?: Resolved<string>;
  spendCapUsd?: Resolved<number>;
}

export interface RuleContext {
  projectId: string;
  ownerOrgId?: string | null;
  ownerUserId?: string | null;
  prompt: string;
  /* What the weighting decided before any rule ran. A rule can match on it. */
  weighedTier: Tier;
}

export async function resolveDefaults(context: RuleContext): Promise<Defaults> {
  const out: Defaults = {};

  /* 1. Organization defaults, the outermost ring. */
  if (context.ownerOrgId) {
    const [org] = await db
      .select({
        name: schema.organizations.name,
        defaultModelId: schema.organizations.defaultModelId,
        defaultTier: schema.organizations.defaultTier,
        spendCapUsd: schema.organizations.spendCapUsd,
      })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, context.ownerOrgId))
      .limit(1);

    if (org?.defaultTier) {
      out.tier = { value: org.defaultTier as Tier, because: `${org.name}'s default tier` };
    }
    if (org?.defaultModelId) {
      out.modelId = { value: org.defaultModelId, because: `${org.name}'s default model` };
    }
    if (org?.spendCapUsd != null) {
      out.spendCapUsd = { value: org.spendCapUsd, because: `${org.name}'s spend cap` };
    }
  }

  /* 2. Project defaults, which narrow the organization's. */
  const [project] = await db
    .select({
      name: schema.projects.name,
      defaultModelId: schema.projects.defaultModelId,
      defaultTier: schema.projects.defaultTier,
      spendCapUsd: schema.projects.spendCapUsd,
    })
    .from(schema.projects)
    .where(eq(schema.projects.id, context.projectId))
    .limit(1);

  if (project?.defaultTier) {
    out.tier = { value: project.defaultTier as Tier, because: "the project's default tier" };
  }
  if (project?.defaultModelId) {
    out.modelId = { value: project.defaultModelId, because: "the project's default model" };
  }
  if (project?.spendCapUsd != null) {
    out.spendCapUsd = { value: project.spendCapUsd, because: "the project's spend cap" };
  }

  /* 3. Rules, which narrow both. First match wins. */
  const rule = await firstMatchingRule(context);
  if (rule) {
    if (rule.setTier) {
      out.tier = { value: rule.setTier as Tier, because: `rule "${rule.name}"` };
    }
    if (rule.setModelId) {
      out.modelId = { value: rule.setModelId, because: `rule "${rule.name}"` };
    }
    if (rule.setNodeId) {
      out.nodeId = { value: rule.setNodeId, because: `rule "${rule.name}"` };
    }
  }

  return out;
}

export async function firstMatchingRule(context: RuleContext) {
  const rules = await db
    .select()
    .from(schema.routingRules)
    .where(
      and(
        eq(schema.routingRules.enabled, true),
        or(
          eq(schema.routingRules.projectId, context.projectId),
          context.ownerOrgId
            ? and(
                eq(schema.routingRules.ownerOrgId, context.ownerOrgId),
                isNull(schema.routingRules.projectId),
              )
            : context.ownerUserId
              ? and(
                  eq(schema.routingRules.ownerUserId, context.ownerUserId),
                  isNull(schema.routingRules.projectId),
                )
              : undefined,
        ),
      ),
    )
    .orderBy(asc(schema.routingRules.priority), asc(schema.routingRules.createdAt));

  /* Project rules before organization ones at the same priority: the narrower
     scope is the more specific intention. */
  const ordered = [...rules].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const scopeA = a.projectId ? 0 : 1;
    const scopeB = b.projectId ? 0 : 1;
    if (scopeA !== scopeB) return scopeA - scopeB;
    return a.createdAt - b.createdAt;
  });

  return ordered.find((rule) => matches(rule, context));
}

export function matches(
  rule: { matchText: string | null; matchTier: string | null },
  context: { prompt: string; weighedTier: Tier },
): boolean {
  /* A rule with no conditions matches everything, which is a legitimate way to
     say "always use this model". */
  if (rule.matchTier && rule.matchTier !== context.weighedTier) return false;

  if (rule.matchText) {
    const needle = rule.matchText.trim();
    if (!needle) return true;

    /* Plain substring, case-insensitive. Regular expressions would be more
       powerful and would also let a typo in a settings field take down
       dispatch for the whole project. */
    if (!context.prompt.toLowerCase().includes(needle.toLowerCase())) return false;
  }

  return true;
}
