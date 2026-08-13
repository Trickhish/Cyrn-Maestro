import { eq } from "drizzle-orm";
import {
  newId,
  TOOL_SCHEMAS,
  type ToolName,
  type TaskStatus,
} from "@maestro/protocol";
import { db, schema } from "../db";
import { config } from "../config";
import { append, conversationFrom } from "./events";
import { resolveProvider, estimateCost, NoProviderError } from "../providers/gateway";
import { streamWithFailover } from "./failover";
import {
  resolveMcpTools,
  runMcpTool,
  isMcpTool,
  mcpPromptSection,
  describeServerTools,
  LIST_MCP_TOOLS_TOOL,
  type ResolvedMcp,
} from "../mcp/registry";
import { collectSkills, fetchSkillBody, skillsPromptSection, recordSkillProblems, LOAD_SKILL_TOOL, type SkillSummary } from "./skills";
import { KNOWLEDGE_TOOLS, isKnowledgeTool, runKnowledgeTool, knowledgePromptSection } from "./knowledge-tools";
import { getKnowledge } from "../projects/knowledge";
import { checkSpend } from "../router/spend";
import { ProviderError } from "../providers/types";
import { awaitResult, sendToNode, subscribeToTask, getLiveNode, noteReleased } from "../nodes/registry";
import { followUpOnTask } from "../conductor/followup";
import { adjudicate } from "../conductor/approvals";

/* The agent loop.
 *
 * The server owns the conversation: it calls the model, receives tool calls,
 * ships them to the node, feeds the results back, and repeats until the model
 * stops. The node never sees a credential and never decides what to do next.
 *
 * Every turn is reconstructed from task_events rather than kept in memory, so
 * a task survives a restart and a resumed thread is identical to the live one. */

const SYSTEM_PROMPT = `You are a coding agent running on a remote machine through Maestro.

You are working inside a single workspace directory. All paths are relative to it.

- Read a file before editing it, so the text you replace matches exactly.
- Prefer edit_file over write_file for files that already exist.
- Run tests or commands to verify your work rather than assuming it worked.
- When you are done, say briefly what you changed and what you verified.
- If a tool fails, read the error and adjust — do not repeat the same call.`;

interface RunState {
  abort: AbortController;
  /* Messages typed while the agent is working. Delivered at the next turn
     boundary rather than mid-stream, so the model sees a coherent
     conversation instead of an interruption inside its own turn. */
  queued: string[];
  awaitingApproval?: { callId: string; tool: ToolName; args: unknown };
}

const running = new Map<string, RunState>();

export function isRunning(taskId: string): boolean {
  return running.has(taskId);
}

export function steer(taskId: string, text: string): boolean {
  const state = running.get(taskId);
  if (!state) return false;
  state.queued.push(text);
  append(taskId, { kind: "user_message", text, queued: true });
  return true;
}

export function cancel(taskId: string): boolean {
  const state = running.get(taskId);
  if (!state) return false;
  state.abort.abort();
  return true;
}

/* An approval decision arrives from the UI. Resuming means re-issuing the same
   call with approved:true — the node refuses an approval it never asked for,
   so this cannot be used to run something the policy never escalated. */
export async function decideApproval(
  taskId: string,
  callId: string,
  approved: boolean,
  decidedBy: string,
): Promise<boolean> {
  const [approval] = await db
    .select()
    .from(schema.approvals)
    .where(eq(schema.approvals.callId, callId))
    .limit(1);

  if (!approval || approval.taskId !== taskId || approval.approved !== null) return false;

  await db
    .update(schema.approvals)
    .set({ approved, decidedBy, decidedAt: Date.now() })
    .where(eq(schema.approvals.id, approval.id));

  append(taskId, { kind: "approval_decided", callId, approved, decidedBy });
  return true;
}

export async function startTask(taskId: string): Promise<void> {
  if (running.has(taskId)) return;

  const state: RunState = { abort: new AbortController(), queued: [] };
  running.set(taskId, state);

  try {
    await runLoop(taskId, state);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finish(taskId, "failed", message);
    append(taskId, { kind: "status", status: "failed", detail: message });
  } finally {
    running.delete(taskId);
  }
}

async function runLoop(taskId: string, state: RunState): Promise<void> {
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).limit(1);
  if (!task) throw new Error("That task no longer exists.");

  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, task.projectId))
    .limit(1);
  if (!project) throw new Error("That task's project no longer exists.");

  /* Checked before a single token is spent. A cap that only stops the next
     task is not a cap. */
  const spendBefore = await checkSpend({
    projectId: task.projectId,
    ownerOrgId: project.ownerOrgId,
    ownerUserId: project.ownerUserId,
  });
  if (spendBefore.exceeded) throw new Error(spendBefore.exceeded);

  /* Whose credentials: the project's owner, never the actor's. */
  let provider = await resolveProvider(
    { ownerUserId: project.ownerUserId, ownerOrgId: project.ownerOrgId },
    task.model ?? project.defaultModelId,
  );

  const node = task.nodeId ? getLiveNode(task.nodeId) : undefined;
  if (!node) throw new Error("The node for this task is not connected.");

  append(taskId, {
    kind: "routing_decision",
    nodeName: node.name,
    model: provider.model,
    because: task.modelPinned ? "pinned on the task" : "the project's default",
  });

  await db
    .update(schema.tasks)
    .set({ status: "running", model: provider.model, startedAt: Date.now() })
    .where(eq(schema.tasks.id, taskId));
  append(taskId, { kind: "status", status: "running" });

  /* Node log frames are forwarded straight into the event log so `bash` output
     is watchable as it arrives rather than appearing all at once at the end. */
  let rejection: string | undefined;

  const unsubscribe = subscribeToTask(taskId, (message) => {
    if (message.type === "task.log") {
      append(taskId, {
        kind: "log",
        callId: message.callId,
        stream: message.stream,
        chunk: message.chunk,
      });
    }

    /* A node that refuses the assignment must fail the task, not be ignored.
       Carrying on produces a run where every tool call fails for a reason that
       has nothing to do with what the node actually said. */
    if (message.type === "task.rejected") {
      rejection =
        message.reason === "at_capacity"
          ? `${node.name} is already running its maximum number of tasks.`
          : `${node.name} refused this task: ${message.reason}${message.detail ? ` — ${message.detail}` : ""}`;
      state.abort.abort();
    }
  });

  /* The node reports what the current checkout contains, so skills follow the
     branch rather than a copy the server took at some point in the past. */
  const { skills, problems } = await collectSkills(taskId);
  recordSkillProblems(taskId, problems);

  /* MCP tools are merged into the same list the node's tools live in, so the
     model sees one surface rather than two categories it has to reason about. */
  const mcp = await resolveMcpTools({ ownerUserId: project.ownerUserId, ownerOrgId: project.ownerOrgId });
  for (const problem of mcp.problems) {
    append(taskId, {
      kind: "log",
      stream: "stderr",
      chunk: `MCP server ${problem.server}: ${problem.message}\n`,
    });
  }

  /* Read once at the top of the task, same as skills: what the project's own
     tools have already registered, so the model is oriented before its first
     turn rather than having to ask. */
  const knowledge = await getKnowledge(project.id);

  const system = [
    SYSTEM_PROMPT,
    project.instructions,
    knowledgePromptSection(knowledge, task.nodeId),
    skillsPromptSection(skills),
    mcpPromptSection(mcp),
  ]
    .filter(Boolean)
    .join("\n\n");
  let toolCallCount = 0;
  const startedAt = Date.now();

  /* Servers the model has asked to see, this task. A server's real tool
     schemas join extraTools only after list_mcp_tools names it — the same
     shape load_skill uses for a skill's body, but for tool availability
     rather than instruction text. Ninety unopened schemas cost nothing; the
     ones actually in play cost what they always did. */
  const openedServers = new Set<string>();

  try {
    for (let turn = 0; turn < 100; turn++) {
      if (state.abort.signal.aborted) {
        /* A rejection from the node is a failure, not a user cancellation —
           saying "stopped by the user" would be a lie in the transcript. */
        if (rejection) {
          await finish(taskId, "failed", rejection);
          append(taskId, { kind: "status", status: "failed", detail: rejection });
          return;
        }
        await finish(taskId, "cancelled", "Stopped by the user.");
        append(taskId, { kind: "status", status: "cancelled", detail: "Stopped by the user." });
        return;
      }
      if (Date.now() - startedAt > config.taskLimits.wallClockMs) {
        await finish(taskId, "failed", "Task exceeded its time limit.");
        append(taskId, { kind: "status", status: "failed", detail: "Task exceeded its time limit." });
        return;
      }

      /* Anything typed while the last turn ran is delivered now, at the turn
         boundary. The event was already appended when it was typed, so
         conversationFrom picks it up in order. */
      state.queued.length = 0;

      const messages = await conversationFrom(taskId);

      let text = "";
      const calls: Array<{ id: string; name: string; argumentsJson: string }> = [];
      let finishReason = "stop";

      try {
        for await (const event of streamWithFailover(
          () => provider,
          (next: typeof provider) => {
            provider = next;
          },
          {
            owner: { ownerUserId: project.ownerUserId, ownerOrgId: project.ownerOrgId },
            taskId,
            system,
            messages,
            /* Offered only when there is something to load; a tool with nothing
               behind it is an invitation to hallucinate a skill name. */
            extraTools: [
              ...(skills.length > 0 ? [LOAD_SKILL_TOOL as never] : []),
              ...(KNOWLEDGE_TOOLS as never[]),
              ...(mcp.servers.length > 0 ? [LIST_MCP_TOOLS_TOOL as never] : []),
              /* Only the servers the model has opened this task — see
                 openedServers above. */
              ...mcp.definitions.filter((d) =>
                mcp.tools.some(
                  (t) => t.qualifiedName === d.name && openedServers.has(t.serverName),
                ),
              ),
            ],
            pinned: task.modelPinned,
          },
          state.abort.signal,
        )) {
          switch (event.type) {
            case "text":
              text += event.delta;
              append(taskId, { kind: "assistant_delta", text: event.delta });
              break;
            case "tool_call":
              calls.push(event.call);
              break;
            case "usage": {
              const cost = estimateCost(event, provider);
              append(taskId, {
                kind: "usage",
                model: provider.model,
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                costUsd: cost,
              });
              await bumpUsage(taskId, event.inputTokens, event.outputTokens, cost);

              /* A single long task can cross a cap on its own, so it is checked
                 again after every call rather than only at dispatch. */
              const during = await checkSpend({
                projectId: task.projectId,
                ownerOrgId: project.ownerOrgId,
                ownerUserId: project.ownerUserId,
              });
              if (during.exceeded) {
                await finish(taskId, "failed", during.exceeded);
                append(taskId, { kind: "status", status: "failed", detail: during.exceeded });
                return;
              }
              break;
            }
            case "done":
              finishReason = event.finishReason;
              break;
          }
        }
      } catch (err) {
        if (state.abort.signal.aborted) {
          const detail = rejection ?? "Stopped by the user.";
          const status = rejection ? "failed" : "cancelled";
          await finish(taskId, status, detail);
          append(taskId, { kind: "status", status, detail });
          return;
        }
        throw err;
      }

      if (text || calls.length) {
        append(taskId, {
          kind: "assistant_message",
          text,
          model: provider.model,
          nodeName: node.name,
        });
      }

      if (calls.length === 0) {
        await finish(taskId, "completed");
        append(taskId, { kind: "status", status: "completed" });
        return;
      }

      if (finishReason === "length") {
        await finish(taskId, "failed", "The model hit its output limit mid-turn.");
        append(taskId, {
          kind: "status",
          status: "failed",
          detail: "The model hit its output limit mid-turn.",
        });
        return;
      }

      for (const call of calls) {
        toolCallCount++;
        if (toolCallCount > config.taskLimits.maxToolCalls) {
          await finish(taskId, "failed", "Task exceeded its tool-call limit.");
          append(taskId, {
            kind: "status",
            status: "failed",
            detail: "Task exceeded its tool-call limit.",
          });
          return;
        }

        /* MCP names are namespaced with a double underscore, and models
           routinely write one — "web_tools_dns_lookup" for
           "web_tools__dns_lookup". The call then falls through to the node,
           which has never heard of it and answers with its own six tools, so
           a working integration looks broken. Matching the name the model
           almost certainly meant is cheaper than a turn spent correcting it,
           and unambiguous: a single candidate or nothing. */
        const mcpName = resolveMcpName(call.name, mcp.tools);

        if (call.name === LOAD_SKILL_TOOL.name) {
          await loadSkillCall(taskId, task.nodeId!, call, skills);
        } else if (call.name === LIST_MCP_TOOLS_TOOL.name) {
          await listMcpToolsCall(taskId, call, mcp, openedServers);
        } else if (isKnowledgeTool(call.name)) {
          await runKnowledgeTool(taskId, project.id, task.nodeId!, call);
        } else if (mcpName) {
          await mcpCall(
            taskId,
            task.projectId,
            { ownerUserId: project.ownerUserId, ownerOrgId: project.ownerOrgId },
            { ...call, name: mcpName },
            mcp.needsApproval,
            state,
          );
        } else {
          await executeCall(taskId, task.nodeId!, task.projectId, call, state);
        }
        if (state.abort.signal.aborted) break;
      }
    }

    await finish(taskId, "failed", "Task ran too many turns without finishing.");
    append(taskId, {
      kind: "status",
      status: "failed",
      detail: "Task ran too many turns without finishing.",
    });
  } finally {
    unsubscribe();
  }
}

/* load_skill is answered by the server, not the node's tool executor: it is a
   Maestro concept rather than a filesystem operation, and the model must not
   be able to reach arbitrary files by naming them as a skill. */
async function loadSkillCall(
  taskId: string,
  nodeId: string,
  call: { id: string; name: string; argumentsJson: string },
  skills: SkillSummary[],
): Promise<void> {
  let name = "";
  try {
    name = String((JSON.parse(call.argumentsJson || "{}") as { name?: unknown }).name ?? "");
  } catch {
    /* Handled below as an unknown skill. */
  }

  /* Recorded under its real name so the conversation rebuilt for the next turn
     matches what the model actually called. */
  append(taskId, {
    kind: "tool_call",
    callId: call.id,
    tool: LOAD_SKILL_TOOL.name,
    args: { name },
    summary: `skill ${name}`,
  });

  /* Only skills the node actually reported. Without this check the name is an
     arbitrary path fragment the model chose. */
  const known = skills.find((skill) => skill.name === name);
  if (!known) {
    append(taskId, {
      kind: "tool_result",
      callId: call.id,
      ok: false,
      output: `There is no skill called "${name}". Available: ${
        skills.map((s) => s.name).join(", ") || "none"
      }.`,
    });
    return;
  }

  const body = await fetchSkillBody(taskId, nodeId, name);

  append(taskId, {
    kind: "tool_result",
    callId: call.id,
    ok: Boolean(body),
    output:
      body ??
      `The skill "${name}" could not be read from the workspace. Continue without it.`,
  });
}

/* Answered from what resolveMcpTools already fetched — no new connection, no
   approval, since this only describes tools rather than running one. Opening
   a server is remembered for the rest of the task: the next turn's extraTools
   includes its real definitions, the same way a loaded skill's body stays
   available without asking again. */
export async function listMcpToolsCall(
  taskId: string,
  call: { id: string; name: string; argumentsJson: string },
  mcp: ResolvedMcp,
  openedServers: Set<string>,
): Promise<void> {
  let server = "";
  try {
    server = String((JSON.parse(call.argumentsJson || "{}") as { server?: unknown }).server ?? "");
  } catch {
    /* Handled below as an unknown server. */
  }

  append(taskId, {
    kind: "tool_call",
    callId: call.id,
    tool: LIST_MCP_TOOLS_TOOL.name,
    args: { server },
    summary: `mcp ${server}`,
  });

  const output = describeServerTools(mcp, server);
  const known = mcp.servers.some((s) => s.name === server);
  if (known) openedServers.add(server);

  append(taskId, { kind: "tool_result", callId: call.id, ok: known, output });
}

/* An MCP tool call. It runs on the server rather than the node, but it goes
   through the same approval path as anything else — reaching a production
   database over MCP deserves the prompt that `psql` would have got. */
async function mcpCall(
  taskId: string,
  projectId: string,
  owner: { ownerUserId?: string | null; ownerOrgId?: string | null },
  call: { id: string; name: string; argumentsJson: string },
  needsApproval: Set<string>,
  state: RunState,
): Promise<void> {
  let args: unknown = {};
  try {
    args = JSON.parse(call.argumentsJson || "{}");
  } catch {
    append(taskId, {
      kind: "tool_call",
      callId: call.id,
      tool: call.name,
      args: {},
      summary: call.name,
    });
    append(taskId, {
      kind: "tool_result",
      callId: call.id,
      ok: false,
      output: `The arguments for ${call.name} were not valid JSON. Send them again as a JSON object.`,
    });
    return;
  }

  const summary = `${call.name} ${JSON.stringify(args).slice(0, 120)}`;
  append(taskId, { kind: "tool_call", callId: call.id, tool: call.name, args, summary });

  if (needsApproval.has(call.name)) {
    await db.insert(schema.approvals).values({
      id: crypto.randomUUID(),
      taskId,
      callId: call.id,
      tool: call.name,
      summary,
      reason: "mcp_tool",
      approved: null,
      decidedBy: null,
      decidedAt: null,
      requestedAt: Date.now(),
    });

    append(taskId, {
      kind: "approval_requested",
      callId: call.id,
      tool: call.name,
      summary,
      reason: "mcp_tool",
    });

    /* The same gate as a shell command's, answered the same way when the
       project has asked for it. */
    const auto = await adjudicate({
      taskId,
      projectId,
      tool: call.name,
      summary,
      reason: "an MCP tool that is marked as needing approval",
    });

    let allowed: boolean;

    if (auto) {
      await db
        .update(schema.approvals)
        .set({
          approved: auto.approved,
          decidedByConductor: true,
          decisionReason: auto.reason,
          decidedAt: Date.now(),
        })
        .where(eq(schema.approvals.callId, call.id));

      append(taskId, {
        kind: "approval_decided",
        callId: call.id,
        approved: auto.approved,
        decidedBy: `the Conductor — ${auto.reason}`,
      });

      allowed = auto.approved;
    } else {
      await db.update(schema.tasks).set({ status: "awaiting_approval" }).where(eq(schema.tasks.id, taskId));
      append(taskId, { kind: "status", status: "awaiting_approval" });

      allowed = await waitForDecision(call.id, state);

      await db.update(schema.tasks).set({ status: "running" }).where(eq(schema.tasks.id, taskId));
      append(taskId, { kind: "status", status: "running" });
    }

    if (!allowed) {
      append(taskId, {
        kind: "tool_result",
        callId: call.id,
        ok: false,
        output: auto ? `The Conductor did not approve that: ${auto.reason}` : "The call was denied.",
      });
      return;
    }
  }

  const started = Date.now();
  const result = await runMcpTool(owner, call.name, args);

  append(taskId, {
    kind: "tool_result",
    callId: call.id,
    ok: result.ok,
    output: result.output,
    durationMs: Date.now() - started,
  });
}

async function executeCall(
  taskId: string,
  nodeId: string,
  projectId: string,
  call: { id: string; name: string; argumentsJson: string },
  state: RunState,
): Promise<void> {
  const tool = call.name as ToolName;

  /* Malformed JSON from the model is common enough to handle as a normal
     outcome: hand the error back and let it correct itself next turn. */
  let args: unknown;
  try {
    args = JSON.parse(call.argumentsJson || "{}");
  } catch {
    append(taskId, {
      kind: "tool_call",
      callId: call.id,
      tool: (TOOL_SCHEMAS as Record<string, unknown>)[tool] ? tool : "bash",
      args: {},
      summary: call.name,
    });
    append(taskId, {
      kind: "tool_result",
      callId: call.id,
      ok: false,
      output: `The arguments for ${call.name} were not valid JSON. Send them again as a JSON object.`,
    });
    return;
  }

  if (!(tool in TOOL_SCHEMAS)) {
    append(taskId, { kind: "tool_call", callId: call.id, tool: "bash", args, summary: call.name });
    append(taskId, {
      kind: "tool_result",
      callId: call.id,
      ok: false,
      output: `There is no tool called ${call.name}. Available tools: ${Object.keys(TOOL_SCHEMAS).join(", ")}.`,
    });
    return;
  }

  append(taskId, { kind: "tool_call", callId: call.id, tool, args, summary: summarise(tool, args) });

  const result = await dispatchToNode(taskId, nodeId, projectId, call.id, tool, args, state, false);

  append(taskId, {
    kind: "tool_result",
    callId: call.id,
    ok: result.ok,
    output: result.output,
    truncated: result.truncated,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
  });
}

/* Sends a tool call and waits for its result, handling the approval round trip
   in between. Returns a failed result rather than throwing, so one refused
   command does not end the task. */
async function dispatchToNode(
  taskId: string,
  nodeId: string,
  /* Carried down because whether the Conductor may answer an approval is a
     property of the project, and this is where an approval is answered. */
  projectId: string,
  callId: string,
  tool: ToolName,
  args: unknown,
  state: RunState,
  approved: boolean,
): Promise<{ ok: boolean; output: string; truncated?: boolean; durationMs?: number; exitCode?: number }> {
  return new Promise((resolve) => {
    const done = (value: Awaited<ReturnType<typeof dispatchToNode>>) => {
      cleanup();
      resolve(value);
    };

    const stopWaiting = awaitResult(callId, async (message) => {
      if (message.type === "tool.result") {
        done({
          ok: message.ok,
          output: message.output,
          truncated: message.truncated,
          durationMs: message.durationMs,
          exitCode: message.exitCode,
        });
        return;
      }

      if (message.type === "tool.approval_request") {
        await db.insert(schema.approvals).values({
          id: crypto.randomUUID(),
          taskId,
          callId,
          tool: message.tool,
          summary: message.summary,
          reason: message.reason,
          approved: null,
          decidedBy: null,
          decidedAt: null,
          requestedAt: Date.now(),
        });

        /* Recorded before anyone decides, so the trail shows what was asked
           even when the answer comes from the Conductor a second later. */
        append(taskId, {
          kind: "approval_requested",
          callId,
          tool: message.tool,
          summary: message.summary,
          reason: message.reason,
        });

        /* Only when the project has asked for it, and only ever as a decision
           the node was already willing to act on. Anything unclear, unavailable
           or over budget comes back null and the human is asked, exactly as
           before — see conductor/approvals.ts. */
        const auto = await adjudicate({
          taskId,
          projectId,
          tool: message.tool,
          summary: message.summary,
          reason: message.reason,
        });

        let decision: boolean;

        if (auto) {
          await db
            .update(schema.approvals)
            .set({
              approved: auto.approved,
              decidedByConductor: true,
              decisionReason: auto.reason,
              decidedAt: Date.now(),
            })
            .where(eq(schema.approvals.callId, callId));

          append(taskId, {
            kind: "approval_decided",
            callId,
            approved: auto.approved,
            decidedBy: `the Conductor — ${auto.reason}`,
          });

          decision = auto.approved;
        } else {
          /* Nobody is coming unless the task says it is waiting, so this is
             only set once the Conductor has declined to answer. */
          await db
            .update(schema.tasks)
            .set({ status: "awaiting_approval" })
            .where(eq(schema.tasks.id, taskId));
          append(taskId, { kind: "status", status: "awaiting_approval" });

          decision = await waitForDecision(callId, state);
        }

        if (!decision) {
          done({
            ok: false,
            output: auto ? `The Conductor did not approve that: ${auto.reason}` : "The command was denied.",
          });
          return;
        }

        /* Only worth saying when the task actually stopped. A Conductor
           decision never moved it off "running", and announcing a resume it
           never paused for is noise in the thread. */
        if (!auto) {
          await db.update(schema.tasks).set({ status: "running" }).where(eq(schema.tasks.id, taskId));
          append(taskId, { kind: "status", status: "running" });
        }

        const retry = await dispatchToNode(taskId, nodeId, projectId, callId, tool, args, state, true);
        done(retry);
      }
    });

    const onAbort = () => done({ ok: false, output: "The task was stopped." });
    state.abort.signal.addEventListener("abort", onAbort, { once: true });

    function cleanup() {
      stopWaiting();
      state.abort.signal.removeEventListener("abort", onAbort);
    }

    const sent = sendToNode(nodeId, {
      type: "tool.call",
      id: newId(),
      taskId,
      callId,
      tool,
      args,
      ...(approved ? { approved: true } : {}),
    });

    if (!sent) done({ ok: false, output: "The node for this task disconnected." });
  });
}

/* Polls the approvals row rather than holding a callback, so a decision made
   from another browser tab — or after a server restart — still resumes the
   task. */
async function waitForDecision(callId: string, state: RunState): Promise<boolean> {
  while (!state.abort.signal.aborted) {
    const [row] = await db
      .select({ approved: schema.approvals.approved })
      .from(schema.approvals)
      .where(eq(schema.approvals.callId, callId))
      .limit(1);

    if (row?.approved === true) return true;
    if (row?.approved === false) return false;

    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function bumpUsage(taskId: string, input: number, output: number, cost: number) {
  const [task] = await db
    .select({
      inputTokens: schema.tasks.inputTokens,
      outputTokens: schema.tasks.outputTokens,
      costUsd: schema.tasks.costUsd,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);

  await db
    .update(schema.tasks)
    .set({
      inputTokens: (task?.inputTokens ?? 0) + input,
      outputTokens: (task?.outputTokens ?? 0) + output,
      costUsd: (task?.costUsd ?? 0) + cost,
    })
    .where(eq(schema.tasks.id, taskId));
}

async function finish(taskId: string, status: TaskStatus, error?: string) {
  await db
    .update(schema.tasks)
    .set({ status, endedAt: Date.now(), error: error ?? null })
    .where(eq(schema.tasks.id, taskId));

  /* Tell the node the task is over so it frees the slot. A node that is never
     told fills to its concurrency limit and then rejects every new assignment,
     which surfaces as unrelated tool failures rather than anything mentioning
     capacity. */
  const [task] = await db
    .select({ nodeId: schema.tasks.nodeId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);

  if (status === "completed" || status === "failed" || status === "cancelled") {
    if (task?.nodeId) {
      noteReleased(task.nodeId, taskId);
      sendToNode(task.nodeId, { type: "task.release", id: newId(), taskId, status });
    }

    /* Tell the Conductor how its own dispatch went. Detached on purpose: this
       is a model call, and the task is already finished and recorded — nothing
       here should wait on commentary about it. Does nothing for a task a human
       dispatched. */
    void followUpOnTask(taskId);
  }
}

export function summarise(tool: ToolName, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "bash":
      return String(a.command ?? "");
    case "write_file":
      return String(a.path ?? "");
    case "edit_file":
      return String(a.path ?? "");
    case "read_file":
      return String(a.path ?? "");
    case "list_dir":
      return String(a.path ?? ".");
    case "glob":
      return String(a.pattern ?? "");
    case "grep":
      return String(a.pattern ?? "");
    default:
      return tool;
  }
}

export { NoProviderError, ProviderError };


/* The MCP tool a call meant, if any.
 *
 * An exact match first. Failing that, one whose qualified name matches once
 * every run of underscores is collapsed — which is exactly the mistake a model
 * makes with a "__" namespace separator. Ambiguity is treated as no match: two
 * candidates mean guessing, and guessing which remote tool to run is worse
 * than saying the name was wrong. */
export function resolveMcpName(name: string, tools: Array<{ qualifiedName: string }>): string | null {
  if (tools.some((t) => t.qualifiedName === name)) return name;
  if (!isMcpTool(name) && !name.includes("_")) return null;

  const flat = (s: string) => s.replace(/_+/g, "_");
  const matches = tools.filter((t) => flat(t.qualifiedName) === flat(name));
  return matches.length === 1 ? matches[0].qualifiedName : null;
}
