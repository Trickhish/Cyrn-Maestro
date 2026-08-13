import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { resolveProvider, modelListMembers } from "../providers/gateway";
import { can, projectScope, type Scope } from "../lib/permissions";
import { conductorToolDefinitions, runConductorTool, type ConductorContext } from "./tools";
import type { Actor } from "../lib/auth";
import type { ChatMessage } from "../providers/types";

/* The Conductor's loop.
 *
 * Same shape as the agent loop but with no node in it: tools resolve
 * in-process against the database, so a turn is model → tool → model with no
 * socket round trip and nothing to approve.
 *
 * It reports on the fleet AND acts on it: create_task lets it dispatch work
 * to a worker model, chosen directly or via a model list, and get_task lets
 * it read back what that work did. It still never touches a filesystem or a
 * shell itself — that stays the worker's job, running on the user's own
 * machines. */

const SYSTEM_PROMPT = `You are the Conductor inside Maestro, an orchestration console for AI coding agents.

You answer questions about the user's projects, machines and tasks by calling tools, and you can dispatch work to other models with create_task. You do not write code and you have no filesystem — other agents, running on the user's machines, do that work; you assign it and check on it.

How to answer:
- Call tools rather than guessing. If you do not know, look it up.
- Lead with what needs the user's attention: anything blocked on an approval comes first.
- Be specific and short. "Two tasks are running, one has been waiting nine minutes for you" beats a paragraph.
- Refer to a task by its title, and include its id in square brackets so the interface can link it.
- Never invent a task, project, machine or number. If a tool returns nothing, say so plainly.
- Cost figures are only meaningful when the provider publishes prices. If they are absent, talk about tokens instead of claiming something was free.

Dispatching work:
- Before choosing a model for create_task, call list_model_lists to see what profiles exist and what each is for — prefer naming a modelList that fits the task over picking a raw model yourself. Leave both unset to use the project's own default routing.
- A task you just dispatched takes real time to run. Do not poll get_task for it in a tight loop within this reply — tell the user it is dispatched and that they can ask again shortly.
- Before telling the user a dispatched task is done, call get_task and read what it actually did. If the work needs fixing, dispatch a follow-up create_task rather than trying to fix it yourself — you have no filesystem to fix it with.

Anything that needs looking at a machine is a task, not a question you answer yourself:
- You cannot read a directory, open a file, or run a command. A worker task can, on the machine holding the checkout. So "look at the code in /some/path", "what does this project do", "find out how it is structured" are all create_task work — dispatch it, say you have, and read the result back with get_task afterwards.
- Worker tasks can also write down what they find: they have tools to set the project's brief, register a fact (a directory, a URL, a port), and remember a note. When the user wants a project documented or its details filled in, dispatch a task that says explicitly what to inspect AND to record what it finds with those tools — a task that only reports back in its own transcript leaves the project knowing nothing.
- project_knowledge reads that back. Check it before claiming a project has no brief or no known location, and again after a task was asked to fill it in, so you are reporting what was actually recorded rather than what you asked for.`;

export interface ConductorTurn {
  text: string;
  toolCalls: Array<{ name: string; args: unknown; result: string }>;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

/* Threading the project into the tools is not enough on its own: the tools
   then default correctly, but the model has no idea which project it is
   sitting on, so it asks the user "which one?" or calls list_projects for a
   choice it was never meant to make. Naming it here is what makes the
   embedded panel feel like it belongs to the project it is embedded in. */
export async function whereWeAre(actor: Actor, context: ConductorContext): Promise<string> {
  if (!context.projectId) return "";

  const scope = await projectScope(context.projectId);
  if (!scope || !(await can(actor, "project.read", scope))) return "";

  const [project] = await db
    .select({ name: schema.projects.name })
    .from(schema.projects)
    .where(eq(schema.projects.id, context.projectId))
    .limit(1);
  if (!project) return "";

  const pinned = [
    context.pinnedModel ? `the model ${context.pinnedModel}` : null,
    context.pinnedModelList ? `the "${context.pinnedModelList}" profile` : null,
    context.pinnedNodeId ? "a specific machine" : null,
  ].filter(Boolean);

  return `\n\nThis conversation is about the project "${project.name}" (id ${context.projectId}). Every tool already defaults to it, so use them directly rather than asking the user which project they mean, and only pass a projectId when you genuinely mean a different one.${
    pinned.length ? ` The user has pinned ${pinned.join(" and ")} for work dispatched from here; leave create_task's model and modelList unset to honour that.` : ""
  }`;
}

/* Coordinating work is its own job, and the user already has a list saying
   which models are good at it. Without this the Conductor ran on whatever the
   gateway happened to default to, which is both unpredictable and the one
   model choice on the page nobody could influence. */
export const CONDUCTOR_LIST_NAME = "manager/conductor";

/* Whose connections the Conductor itself runs on, and which model.
 *
 * The scope is the project's owner when embedded, not the actor — an org
 * project's Conductor should bill the org, the same rule dispatched tasks
 * already follow. Falling back rather than failing is deliberate: a missing
 * or fully-unavailable profile must not take the Conductor offline, since
 * without it the user cannot even ask what went wrong. */
export async function conductorProvider(actor: Actor, context: ConductorContext) {
  const personal: Scope = { ownerUserId: actor.id, ownerOrgId: null };
  const project = context.projectId ? await projectScope(context.projectId) : null;
  const scope =
    project && (await can(actor, "task.run", project)) ? project : personal;

  const profile = await modelListMembers(scope, CONDUCTOR_LIST_NAME);
  const members = "models" in profile ? profile.models : [];

  /* An override is a choice within the profile, not a way around it: the
     list is what says which models are fit to coordinate, and honouring a
     name outside it would make that list advisory. Anything else falls back
     to the profile's own first choice rather than erroring, since a stale
     pick must not be able to wedge the Conductor. */
  const wanted = context.conductorModel;
  const picked = wanted && members.includes(wanted) ? wanted : members[0];

  if (picked) {
    try {
      return await resolveProvider(scope, picked);
    } catch {
      /* Listed but unreachable right now — fall through to the default. */
    }
  }

  return resolveProvider(scope);
}

export async function askConductor(
  actor: Actor,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  question: string,
  signal?: AbortSignal,
  context: ConductorContext = {},
): Promise<ConductorTurn> {
  const provider = await conductorProvider(actor, context);

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT + (await whereWeAre(actor, context)) },
    ...history.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
    { role: "user", content: question },
  ];

  const toolCalls: ConductorTurn["toolCalls"] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let text = "";

  /* Bounded: a read-only question that needs more than a handful of lookups is
     a question the model has misunderstood, and looping costs real money. */
  for (let turn = 0; turn < 6; turn++) {
    let turnText = "";
    const calls: Array<{ id: string; name: string; argumentsJson: string }> = [];

    for await (const event of provider.adapter.stream(
      {
        model: provider.model,
        messages,
        tools: conductorToolDefinitions(),
        maxTokens: 2048,
        reasoningEffort: provider.reasoningEffort,
      },
      signal,
    )) {
      if (event.type === "text") turnText += event.delta;
      if (event.type === "tool_call") calls.push(event.call);
      if (event.type === "usage") {
        usage.inputTokens += event.inputTokens;
        usage.outputTokens += event.outputTokens;
      }
    }

    if (calls.length === 0) {
      text = turnText || text;
      break;
    }

    messages.push({
      role: "assistant",
      content: turnText,
      toolCalls: calls,
    });

    for (const call of calls) {
      let args: unknown = {};
      try {
        args = JSON.parse(call.argumentsJson || "{}");
      } catch {
        /* Hand the error back and let it correct itself, same as the agent loop. */
      }

      const result = await runConductorTool(actor, call.name, args, context);
      toolCalls.push({ name: call.name, args, result });

      messages.push({ role: "tool", toolCallId: call.id, content: result });
    }

    text = turnText || text;
  }

  return { text, toolCalls, usage, model: provider.model };
}
