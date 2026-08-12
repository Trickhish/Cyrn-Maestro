import { and, desc, eq, gte, inArray, like, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { getLiveNode, onlineNodes } from "../nodes/registry";
import { isRunning } from "../tasks/runner";
import type { ToolDefinition } from "../providers/types";
import type { Actor } from "../lib/auth";

/* The Conductor's tools.
 *
 * These are Maestro's own API, not a workspace: no filesystem, no node, no
 * shell. The Conductor answers questions about the fleet and, later, dispatches
 * work — it never edits code itself.
 *
 * Every tool takes the signed-in actor and scopes its query to what that actor
 * owns. The Conductor acts AS the user and is never elevated: it cannot see a
 * project the user cannot see, and asking it to is simply an empty result. */

const ACTIVE = ["queued", "assigned", "running", "awaiting_approval"] as const;

const NoArgs = z.object({});

const ListTasks = z.object({
  status: z
    .enum(["active", "needs_you", "completed", "failed", "all"])
    .optional()
    .describe("Which tasks to list. Defaults to active."),
  projectId: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const GetTask = z.object({
  taskId: z.string().describe("The task's id, as given by list_tasks."),
});

const SearchHistory = z.object({
  query: z.string().describe("Text to look for in task titles and prompts."),
  limit: z.number().int().min(1).max(50).optional(),
});

const SpendReport = z.object({
  sinceHours: z.number().int().min(1).max(24 * 90).optional().describe("Defaults to 24."),
});

export const CONDUCTOR_SCHEMAS = {
  list_projects: NoArgs,
  fleet_status: NoArgs,
  list_tasks: ListTasks,
  get_task: GetTask,
  search_history: SearchHistory,
  spend_report: SpendReport,
} as const;

export type ConductorToolName = keyof typeof CONDUCTOR_SCHEMAS;

const DESCRIPTIONS: Record<ConductorToolName, string> = {
  list_projects: "List the user's projects, with how many tasks are running in each.",
  fleet_status: "Show the machines that can run work: which are online, their load, and their capabilities.",
  list_tasks: "List tasks. Use status 'needs_you' for anything blocked on an approval.",
  get_task: "Get one task in detail, including what it did and what it changed.",
  search_history: "Find past tasks by what they were asked to do.",
  spend_report: "Report token usage and cost, broken down by project.",
};

export function conductorToolDefinitions(): ToolDefinition[] {
  return (Object.keys(CONDUCTOR_SCHEMAS) as ConductorToolName[]).map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    parameters: z.toJSONSchema(CONDUCTOR_SCHEMAS[name], { io: "input" }) as Record<string, unknown>,
  }));
}

/* Results are returned as compact text rather than JSON. The model reads it
   either way, and text costs fewer tokens and is far easier to skim when it is
   quoted back in an answer. */
export async function runConductorTool(
  actor: Actor,
  name: string,
  rawArgs: unknown,
): Promise<string> {
  if (!(name in CONDUCTOR_SCHEMAS)) {
    return `There is no tool called ${name}. Available: ${Object.keys(CONDUCTOR_SCHEMAS).join(", ")}.`;
  }

  const parsed = CONDUCTOR_SCHEMAS[name as ConductorToolName].safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return `Invalid arguments for ${name}: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
  }

  switch (name as ConductorToolName) {
    case "list_projects":
      return listProjects(actor);
    case "fleet_status":
      return fleetStatus(actor);
    case "list_tasks":
      return listTasks(actor, parsed.data as z.infer<typeof ListTasks>);
    case "get_task":
      return getTask(actor, parsed.data as z.infer<typeof GetTask>);
    case "search_history":
      return searchHistory(actor, parsed.data as z.infer<typeof SearchHistory>);
    case "spend_report":
      return spendReport(actor, parsed.data as z.infer<typeof SpendReport>);
  }
}

async function listProjects(actor: Actor): Promise<string> {
  const projects = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.ownerUserId, actor.id));

  if (projects.length === 0) return "No projects yet.";

  const tasks = await db
    .select({ projectId: schema.tasks.projectId, status: schema.tasks.status })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.tasks.projectId, schema.projects.id))
    .where(eq(schema.projects.ownerUserId, actor.id));

  return projects
    .map((p) => {
      const mine = tasks.filter((t) => t.projectId === p.id);
      const active = mine.filter((t) => ACTIVE.includes(t.status as never)).length;
      const blocked = mine.filter((t) => t.status === "awaiting_approval").length;
      return [
        `${p.name} (id ${p.id})`,
        `${mine.length} tasks total`,
        `${active} active`,
        blocked ? `${blocked} need you` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    })
    .join("\n");
}

async function fleetStatus(actor: Actor): Promise<string> {
  const rows = await db.select().from(schema.nodes).where(eq(schema.nodes.ownerUserId, actor.id));
  if (rows.length === 0) return "No machines are enrolled.";

  const live = onlineNodes(actor.id);

  const lines = rows.map((node) => {
    const connected = getLiveNode(node.id);
    return [
      node.name,
      connected ? "online" : node.status === "revoked" ? "revoked" : "offline",
      `${connected?.runningTaskIds.size ?? 0}/${node.maxConcurrentTasks} slots`,
      `${node.os ?? "?"}/${node.arch ?? "?"}`,
      (node.capabilities ?? []).join(","),
    ].join(" · ");
  });

  return `${live.length} of ${rows.length} online\n${lines.join("\n")}`;
}

async function listTasks(actor: Actor, args: z.infer<typeof ListTasks>): Promise<string> {
  const status = args.status ?? "active";

  const statusFilter =
    status === "active"
      ? inArray(schema.tasks.status, [...ACTIVE])
      : status === "needs_you"
        ? eq(schema.tasks.status, "awaiting_approval")
        : status === "completed"
          ? eq(schema.tasks.status, "completed")
          : status === "failed"
            ? or(eq(schema.tasks.status, "failed"), eq(schema.tasks.status, "cancelled"))
            : undefined;

  const rows = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      status: schema.tasks.status,
      model: schema.tasks.model,
      cost: schema.tasks.costUsd,
      startedAt: schema.tasks.startedAt,
      projectName: schema.projects.name,
      nodeName: schema.nodes.name,
    })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.tasks.projectId, schema.projects.id))
    .leftJoin(schema.nodes, eq(schema.tasks.nodeId, schema.nodes.id))
    .where(
      and(
        eq(schema.projects.ownerUserId, actor.id),
        ...(args.projectId ? [eq(schema.tasks.projectId, args.projectId)] : []),
        ...(statusFilter ? [statusFilter] : []),
      ),
    )
    .orderBy(desc(schema.tasks.createdAt))
    .limit(args.limit ?? 20);

  if (rows.length === 0) return `No ${status === "all" ? "" : `${status} `}tasks.`;

  return rows
    .map((t) => {
      const age = t.startedAt ? `${Math.round((Date.now() - t.startedAt) / 60000)}m` : "not started";
      return [
        `[${t.id}]`,
        t.title,
        `— ${t.projectName}`,
        t.status,
        age,
        t.nodeName ?? "",
        t.model ?? "",
        t.cost > 0 ? `$${t.cost.toFixed(4)}` : "",
        isRunning(t.id) ? "(loop live)" : "",
      ]
        .filter(Boolean)
        .join(" · ");
    })
    .join("\n");
}

async function getTask(actor: Actor, args: z.infer<typeof GetTask>): Promise<string> {
  const [task] = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      prompt: schema.tasks.prompt,
      status: schema.tasks.status,
      model: schema.tasks.model,
      cost: schema.tasks.costUsd,
      inputTokens: schema.tasks.inputTokens,
      outputTokens: schema.tasks.outputTokens,
      error: schema.tasks.error,
      projectName: schema.projects.name,
      ownerUserId: schema.projects.ownerUserId,
    })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.tasks.projectId, schema.projects.id))
    .where(eq(schema.tasks.id, args.taskId))
    .limit(1);

  /* Same message whether it does not exist or is not theirs, so the Conductor
     cannot be used to probe for other people's task ids. */
  if (!task || task.ownerUserId !== actor.id) return "No such task.";

  const events = await db
    .select({ kind: schema.taskEvents.kind, payload: schema.taskEvents.payload })
    .from(schema.taskEvents)
    .where(eq(schema.taskEvents.taskId, args.taskId))
    .orderBy(schema.taskEvents.seq);

  const actions: string[] = [];
  let lastSaid = "";

  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (event.kind === "tool_call") {
      actions.push(`${payload.tool} ${payload.summary}`);
    }
    if (event.kind === "assistant_message" && typeof payload.text === "string" && payload.text) {
      lastSaid = payload.text;
    }
    if (event.kind === "approval_requested") {
      actions.push(`asked to run: ${payload.summary}`);
    }
  }

  return [
    `${task.title} [${task.id}]`,
    `project: ${task.projectName}`,
    `status: ${task.status}${task.error ? ` — ${task.error}` : ""}`,
    `model: ${task.model ?? "unset"} · ${task.inputTokens} in / ${task.outputTokens} out${
      task.cost > 0 ? ` · $${task.cost.toFixed(4)}` : ""
    }`,
    `asked: ${task.prompt.slice(0, 400)}`,
    actions.length ? `did (${actions.length} steps):\n  ${actions.slice(0, 25).join("\n  ")}` : "did: nothing yet",
    lastSaid ? `said: ${lastSaid.slice(0, 600)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function searchHistory(actor: Actor, args: z.infer<typeof SearchHistory>): Promise<string> {
  const term = `%${args.query}%`;

  const rows = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      status: schema.tasks.status,
      createdAt: schema.tasks.createdAt,
      projectName: schema.projects.name,
    })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.tasks.projectId, schema.projects.id))
    .where(
      and(
        eq(schema.projects.ownerUserId, actor.id),
        or(like(schema.tasks.title, term), like(schema.tasks.prompt, term)),
      ),
    )
    .orderBy(desc(schema.tasks.createdAt))
    .limit(args.limit ?? 15);

  if (rows.length === 0) return `Nothing matches "${args.query}".`;

  return rows
    .map(
      (t) =>
        `[${t.id}] ${t.title} — ${t.projectName} · ${t.status} · ${new Date(t.createdAt).toISOString().slice(0, 16).replace("T", " ")}`,
    )
    .join("\n");
}

async function spendReport(actor: Actor, args: z.infer<typeof SpendReport>): Promise<string> {
  const since = Date.now() - (args.sinceHours ?? 24) * 3600_000;

  const rows = await db
    .select({
      projectName: schema.projects.name,
      cost: schema.tasks.costUsd,
      input: schema.tasks.inputTokens,
      output: schema.tasks.outputTokens,
    })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.tasks.projectId, schema.projects.id))
    .where(and(eq(schema.projects.ownerUserId, actor.id), gte(schema.tasks.createdAt, since)));

  if (rows.length === 0) return `No tasks in the last ${args.sinceHours ?? 24} hours.`;

  const byProject = new Map<string, { cost: number; input: number; output: number; tasks: number }>();
  for (const row of rows) {
    const entry = byProject.get(row.projectName) ?? { cost: 0, input: 0, output: 0, tasks: 0 };
    entry.cost += row.cost;
    entry.input += row.input;
    entry.output += row.output;
    entry.tasks += 1;
    byProject.set(row.projectName, entry);
  }

  const totalCost = rows.reduce((n, r) => n + r.cost, 0);
  const totalIn = rows.reduce((n, r) => n + r.input, 0);
  const totalOut = rows.reduce((n, r) => n + r.output, 0);

  const lines = [...byProject.entries()].map(
    ([name, e]) =>
      `${name}: ${e.tasks} tasks · ${e.input} in / ${e.output} out${e.cost > 0 ? ` · $${e.cost.toFixed(4)}` : ""}`,
  );

  /* This provider publishes no prices, so a zero here means "unpriced", not
     "free". Saying so stops the model reporting $0.00 as a fact. */
  const note =
    totalCost === 0
      ? "\n(No cost figures: the connected provider does not publish prices, so only token counts are known.)"
      : "";

  return `Last ${args.sinceHours ?? 24}h — ${rows.length} tasks · ${totalIn} in / ${totalOut} out${
    totalCost > 0 ? ` · $${totalCost.toFixed(4)}` : ""
  }\n${lines.join("\n")}${note}`;
}
