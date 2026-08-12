import { and, eq, gte, inArray, sum } from "drizzle-orm";
import { db, schema } from "../db";

/* Spend caps.
 *
 * Checked before a task starts and again after every model call, because a
 * single long task can cross a cap on its own — checking only at dispatch
 * would make the cap a suggestion.
 *
 * Caps are per rolling 30 days rather than per calendar month: a cap that
 * resets at midnight on the first is a cap that can be exhausted on the 2nd and
 * useless for four weeks, and nobody reads it that way when they set it. */

const WINDOW_MS = 30 * 24 * 3600_000;

export interface CapCheck {
  /* Undefined when no cap applies. */
  capUsd?: number;
  spentUsd: number;
  /* The sentence shown when a task is refused or stopped. */
  exceeded?: string;
}

export async function checkSpend(scope: {
  projectId: string;
  ownerOrgId?: string | null;
  ownerUserId?: string | null;
}): Promise<CapCheck> {
  const [project] = await db
    .select({ name: schema.projects.name, cap: schema.projects.spendCapUsd })
    .from(schema.projects)
    .where(eq(schema.projects.id, scope.projectId))
    .limit(1);

  /* The project's own cap first, since it is the tighter of the two when set. */
  if (project?.cap != null) {
    const spent = await spentOnProject(scope.projectId);
    if (spent >= project.cap) {
      return {
        capUsd: project.cap,
        spentUsd: spent,
        exceeded:
          `This project has spent $${spent.toFixed(2)} of its $${project.cap.toFixed(2)} cap ` +
          `over the last 30 days. Raise the cap in the project's settings, or wait for older ` +
          `spending to age out.`,
      };
    }
    return { capUsd: project.cap, spentUsd: spent };
  }

  if (scope.ownerOrgId) {
    const [org] = await db
      .select({ name: schema.organizations.name, cap: schema.organizations.spendCapUsd })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, scope.ownerOrgId))
      .limit(1);

    if (org?.cap != null) {
      const spent = await spentByOrg(scope.ownerOrgId);
      if (spent >= org.cap) {
        return {
          capUsd: org.cap,
          spentUsd: spent,
          exceeded:
            `${org.name} has spent $${spent.toFixed(2)} of its $${org.cap.toFixed(2)} cap over ` +
            `the last 30 days. An organization admin can raise it in Organization settings.`,
        };
      }
      return { capUsd: org.cap, spentUsd: spent };
    }
  }

  return { spentUsd: 0 };
}

async function spentOnProject(projectId: string): Promise<number> {
  const [row] = await db
    .select({ total: sum(schema.tasks.costUsd) })
    .from(schema.tasks)
    .where(
      and(eq(schema.tasks.projectId, projectId), gte(schema.tasks.createdAt, Date.now() - WINDOW_MS)),
    );
  return Number(row?.total ?? 0);
}

async function spentByOrg(orgId: string): Promise<number> {
  const projects = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.ownerOrgId, orgId));

  if (projects.length === 0) return 0;

  const [row] = await db
    .select({ total: sum(schema.tasks.costUsd) })
    .from(schema.tasks)
    .where(
      and(
        inArray(
          schema.tasks.projectId,
          projects.map((p) => p.id),
        ),
        gte(schema.tasks.createdAt, Date.now() - WINDOW_MS),
      ),
    );

  return Number(row?.total ?? 0);
}

/* A cap only means anything where the provider publishes prices. This provider
   does not, so every task costs a recorded zero — enforcing against that would
   be enforcing against nothing, and a cap the user believes is protecting them
   while it silently is not is worse than no cap at all. */
export function capIsMeaningful(spent: number, anyPricedModel: boolean): boolean {
  return anyPricedModel || spent > 0;
}
