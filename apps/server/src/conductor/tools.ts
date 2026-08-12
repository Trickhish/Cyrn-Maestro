import { and, desc, eq, gte, inArray, like, or } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { db, schema } from "../db";
import { getLiveNode, onlineNodes } from "../nodes/registry";
import { isRunning } from "../tasks/runner";
import { createTask } from "../tasks/create";
import { resolveModelList } from "../providers/gateway";
import { can, projectScope, taskScope } from "../lib/permissions";
import { getKnowledge } from "../projects/knowledge";
import type { ToolDefinition } from "../providers/types";
import type { Actor } from "../lib/auth";

/* The Conductor's tools.
 *
 * These are Maestro's own API, not a workspace: no filesystem, no node, no
 * shell. The Conductor answers questions about the fleet, dispatches work to
 * other models, and reviews what they did — it never edits code itself.
 *
 * Every tool takes the signed-in actor and scopes its query to what that actor
 * owns — their own account, or (when embedded on a project's own page, via
 * ConductorContext) whichever owner actually holds that project, which may be
 * an organization rather than the actor personally. Either way the Conductor
 * acts AS the user and is never elevated: `can()` checks membership before
 * any org-scoped query runs, so asking about a project or org the actor
 * cannot see is simply an empty result. */

/* Threaded through every tool call from the request that started the turn.
   Set when the Conductor is embedded on a specific project's own page, so
   its tools default to that project instead of making the model guess or
   ask for an id it was never given. Absent on the global, cross-project
   screen, where every tool still works — it just needs an explicit id. */
export interface ConductorContext {
  projectId?: string;
  /* What the user pinned in the interface's routing chips. A floor the
     Conductor's own choice sits on top of: it may name a model or a list
     itself, but when it does not, a pin the user set by hand still wins over
     the project's default routing — otherwise the control would visibly do
     nothing once the Conductor is the thing dispatching. */
  pinnedModel?: string;
  pinnedNodeId?: string;
}

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

const ListModelLists = NoArgs;

const ProjectKnowledge = z.object({
  projectId: z
    .string()
    .optional()
    .describe("Defaults to the project this conversation is about, if any."),
});

const CreateTask = z
  .object({
    prompt: z.string().min(1).describe("What the worker model should do."),
    title: z.string().max(120).optional(),
    projectId: z
      .string()
      .optional()
      .describe("Defaults to the project this conversation is about, if any."),
    model: z.string().optional().describe("A specific connected model id to pin this task to."),
    modelList: z
      .string()
      .optional()
      .describe(
        "The name of a model list (see list_model_lists) to pick a model from instead of naming one directly.",
      ),
  })
  .refine((v) => !(v.model && v.modelList), {
    message: "Give a model or a modelList, not both.",
  });

export const CONDUCTOR_SCHEMAS = {
  list_projects: NoArgs,
  fleet_status: NoArgs,
  list_tasks: ListTasks,
  get_task: GetTask,
  search_history: SearchHistory,
  spend_report: SpendReport,
  list_model_lists: ListModelLists,
  project_knowledge: ProjectKnowledge,
  create_task: CreateTask,
} as const;

export type ConductorToolName = keyof typeof CONDUCTOR_SCHEMAS;

const DESCRIPTIONS: Record<ConductorToolName, string> = {
  list_projects: "List the user's projects, with how many tasks are running in each.",
  fleet_status: "Show the machines that can run work: which are online, their load, and their capabilities.",
  list_tasks: "List tasks. Use status 'needs_you' for anything blocked on an approval.",
  get_task: "Get one task in detail, including what it did and what it changed.",
  search_history: "Find past tasks by what they were asked to do.",
  spend_report: "Report token usage and cost, broken down by project.",
  list_model_lists:
    "List the model profiles set up for this project: a name and when to use it. Check this before choosing a model for create_task.",
  project_knowledge:
    "Read what a project has on record about itself: its brief, where it is checked out on each machine, and the facts and notes agents have registered. Read this before answering questions about a project, and again after a task was asked to fill it in.",
  create_task: "Dispatch a new task to a worker model. Pin a model, name a modelList, or leave both unset to use the project's default routing.",
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
  context: ConductorContext = {},
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
      return listProjects(actor, context);
    case "fleet_status":
      return fleetStatus(actor, context);
    case "list_tasks":
      return listTasks(actor, parsed.data as z.infer<typeof ListTasks>, context);
    case "get_task":
      return getTask(actor, parsed.data as z.infer<typeof GetTask>);
    case "search_history":
      return searchHistory(actor, parsed.data as z.infer<typeof SearchHistory>, context);
    case "spend_report":
      return spendReport(actor, parsed.data as z.infer<typeof SpendReport>, context);
    case "list_model_lists":
      return listModelLists(actor, context);
    case "project_knowledge":
      return projectKnowledge(actor, parsed.data as z.infer<typeof ProjectKnowledge>, context);
    case "create_task":
      return createTaskTool(actor, parsed.data as z.infer<typeof CreateTask>, context);
  }
}

async function listProjects(actor: Actor, context: ConductorContext): Promise<string> {
  const scope = await scopeFor(context, actor);
  if (!scope || !(await can(actor, "project.read", scope))) return "No projects visible from here.";
  const owned = ownedBy(schema.projects, scope);

  const projects = await db.select().from(schema.projects).where(owned);

  if (projects.length === 0) return "No projects yet.";

  const tasks = await db
    .select({ projectId: schema.tasks.projectId, status: schema.tasks.status })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.tasks.projectId, schema.projects.id))
    .where(owned);

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

async function fleetStatus(actor: Actor, context: ConductorContext): Promise<string> {
  const scope = await scopeFor(context, actor);
  if (!scope || !(await can(actor, "node.read", scope))) return "No machines visible from here.";

  const rows = await db.select().from(schema.nodes).where(ownedBy(schema.nodes, scope));
  if (rows.length === 0) return "No machines are enrolled.";

  const live = onlineNodes(scope);

  const lines = rows.map((node) => {
    const connected = getLiveNode(node.id);
    return [
      node.name,
      connected ? "online" : node.status === "revoked" ? "revoked" : "offline",
      `${connected ? Math.max(connected.assigned.size, connected.reported.size) : 0}/${node.maxConcurrentTasks} slots`,
      `${node.os ?? "?"}/${node.arch ?? "?"}`,
      (node.capabilities ?? []).join(","),
    ].join(" · ");
  });

  return `${live.length} of ${rows.length} online\n${lines.join("\n")}`;
}

async function listTasks(
  actor: Actor,
  args: z.infer<typeof ListTasks>,
  context: ConductorContext,
): Promise<string> {
  const status = args.status ?? "active";
  const effectiveProjectId = args.projectId ?? context.projectId;

  const scope = await scopeFor(context, actor);
  if (!scope || !(await can(actor, "task.read", scope))) return "No tasks visible from here.";

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
        ownedBy(schema.projects, scope),
        ...(effectiveProjectId ? [eq(schema.tasks.projectId, effectiveProjectId)] : []),
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
  /* taskScope + can, not a hardcoded ownerUserId comparison — a task on an
     org-owned project is not "not theirs" just because the column it is
     compared against is the personal one. A task the Conductor itself just
     dispatched on an org project must be readable back, or "validate" is a
     promise this tool quietly cannot keep. */
  const scope = await taskScope(args.taskId);
  if (!scope || !(await can(actor, "task.read", scope))) return "No such task.";

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
    })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.tasks.projectId, schema.projects.id))
    .where(eq(schema.tasks.id, args.taskId))
    .limit(1);

  /* Same message whether it does not exist or is not theirs, so the Conductor
     cannot be used to probe for other people's task ids. */
  if (!task) return "No such task.";

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

async function searchHistory(
  actor: Actor,
  args: z.infer<typeof SearchHistory>,
  context: ConductorContext,
): Promise<string> {
  const scope = await scopeFor(context, actor);
  if (!scope || !(await can(actor, "task.read", scope))) return "Nothing visible from here.";

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
    .where(and(ownedBy(schema.projects, scope), or(like(schema.tasks.title, term), like(schema.tasks.prompt, term))))
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

async function spendReport(
  actor: Actor,
  args: z.infer<typeof SpendReport>,
  context: ConductorContext,
): Promise<string> {
  const scope = await scopeFor(context, actor);
  if (!scope || !(await can(actor, "project.read", scope))) return "No spend visible from here.";

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
    .where(and(ownedBy(schema.projects, scope), gte(schema.tasks.createdAt, since)));

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

/* Every owned table in this schema follows the same owner-column pair, so one
   condition builder covers projects, tasks-via-projects and nodes alike. */
function ownedBy<T extends { ownerUserId: SQLiteColumn; ownerOrgId: SQLiteColumn }>(
  table: T,
  scope: { ownerUserId?: string | null; ownerOrgId?: string | null },
) {
  return scope.ownerOrgId ? eq(table.ownerOrgId, scope.ownerOrgId) : eq(table.ownerUserId, scope.ownerUserId!);
}

/* The scope model lists and task dispatch resolve against: the project this
   conversation is about when there is one (which may be an org's, not the
   actor's own), otherwise the actor's personal scope. Resolved once so a
   project embed and the global screen behave consistently. */
async function scopeFor(context: ConductorContext, actor: Actor) {
  if (context.projectId) return projectScope(context.projectId);
  return { ownerUserId: actor.id, ownerOrgId: null };
}

async function listModelLists(actor: Actor, context: ConductorContext): Promise<string> {
  const scope = await scopeFor(context, actor);
  if (!scope || !(await can(actor, "provider.read", scope))) return "No model lists visible from here.";

  const lists = await db.select().from(schema.modelLists).where(ownedBy(schema.modelLists, scope));

  if (lists.length === 0) return "No model lists set up yet.";

  return lists.map((l) => `${l.name} — ${l.description || "(no description)"}`).join("\n");
}

/* What the project has on record about itself. The Conductor cannot look at a
   checkout — only a worker task on the machine holding it can — so this is
   how it reads back what such a task registered, and how it answers "what do
   we know about this project" without guessing. */
async function projectKnowledge(
  actor: Actor,
  args: z.infer<typeof ProjectKnowledge>,
  context: ConductorContext,
): Promise<string> {
  const projectId = args.projectId ?? context.projectId;
  if (!projectId) return "No project — pass a projectId (use list_projects to find one).";

  const scope = await projectScope(projectId);
  if (!scope || !(await can(actor, "project.read", scope))) {
    return "That project doesn't exist, or isn't yours.";
  }

  const knowledge = await getKnowledge(projectId);

  const workspaces = knowledge.workspaces.length
    ? knowledge.workspaces.map((w) => `  ${w.nodeName}: ${w.path}`).join("\n")
    : "  (none recorded — no task has reported where this project lives)";

  const notes = knowledge.notes.length
    ? knowledge.notes
        .map((n) => `  ${n.kind}${n.label ? ` ${n.label}` : ""}: ${n.value}${n.nodeName ? ` (on ${n.nodeName})` : ""}`)
        .join("\n")
    : "  (none recorded)";

  return [
    `brief: ${knowledge.brief || "(not set)"}`,
    `checked out at:\n${workspaces}`,
    `facts and notes:\n${notes}`,
  ].join("\n");
}

async function createTaskTool(
  actor: Actor,
  args: z.infer<typeof CreateTask>,
  context: ConductorContext,
): Promise<string> {
  const projectId = args.projectId ?? context.projectId;
  if (!projectId) {
    return "No project to dispatch to — pass a projectId (use list_projects to find one).";
  }

  /* Checked before anything else touches this project, including resolving a
     model list — a project the actor cannot reach must behave the same as
     one that does not exist, not leak its list names in an error message. */
  const scope = await projectScope(projectId);
  if (!scope || !(await can(actor, "task.run", scope))) {
    return "That project doesn't exist, or isn't yours.";
  }

  let model = args.model;
  if (args.modelList) {
    const resolved = await resolveModelList(scope, args.modelList);
    if ("error" in resolved) return resolved.error;
    model = resolved.modelId;
  }
  /* Only when the Conductor did not choose for itself — an explicit model or
     list it picked for this particular task is a deliberate decision, and a
     standing pin should not silently override it. */
  model = model ?? context.pinnedModel;

  try {
    const created = await createTask(actor, {
      projectId,
      prompt: args.prompt,
      title: args.title,
      model,
      nodeId: context.pinnedNodeId,
    });
    return `Dispatched [${created.taskId}] "${created.title}" to ${created.nodeName} on ${created.model}.`;
  } catch (err) {
    /* Never let a thrown error escape a tool call — every result here is a
       string the model reads and reacts to, same as every other tool. */
    return err instanceof Error && err.message
      ? err.message
      : "Could not dispatch that task.";
  }
}
