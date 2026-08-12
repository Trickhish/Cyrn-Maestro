import { newId, skillSummary } from "@maestro/protocol";
import { sendToNode, subscribeToTask } from "../nodes/registry";
import { append } from "./events";

/* Skills, from the server's side.
 *
 * The node reports what the checkout contains; the server puts one line per
 * skill into the system prompt and hands the model a tool to load a body when
 * it decides one is relevant.
 *
 * That split is the whole economics of the feature. Twenty skills cost about
 * forty lines of context instead of twenty procedures, and the model spends
 * tokens on a procedure only when it has already decided to follow it. */

export interface SkillSummary {
  name: string;
  description: string;
  version?: string;
  path: string;
}

export const LOAD_SKILL_TOOL = {
  name: "load_skill",
  description:
    "Load the full instructions for one of the skills listed in your prompt. Call this before following a procedure, not after.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The skill's name, exactly as listed." },
    },
    required: ["name"],
    additionalProperties: false,
  },
} as const;

/* Waits for the node's report, which arrives shortly after it accepts a task.
 *
 * Bounded, and an empty list on timeout: a node that never answers must not
 * hold a task forever, and an agent with no skills is still an agent. */
export function collectSkills(taskId: string, timeoutMs = 5_000): Promise<{
  skills: SkillSummary[];
  problems: Array<{ path: string; message: string }>;
}> {
  return new Promise((resolve) => {
    const finish = (value: { skills: SkillSummary[]; problems: Array<{ path: string; message: string }> }) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };

    const timer = setTimeout(() => finish({ skills: [], problems: [] }), timeoutMs);

    const unsubscribe = subscribeToTask(taskId, (message) => {
      if (message.type === "skills.found") {
        finish({ skills: message.skills, problems: message.problems });
      }
    });
  });
}

/* Asks the node for one skill's body. */
export function fetchSkillBody(
  taskId: string,
  nodeId: string,
  name: string,
  timeoutMs = 10_000,
): Promise<string | null> {
  return new Promise((resolve) => {
    const requestId = newId();

    const finish = (body: string | null) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(body);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    const unsubscribe = subscribeToTask(taskId, (message) => {
      if (message.type === "skill.body" && message.requestId === requestId) {
        finish(message.body);
      }
    });

    const sent = sendToNode(nodeId, { type: "skill.fetch", id: newId(), taskId, requestId, name });
    if (!sent) finish(null);
  });
}

/* The block appended to the system prompt: names and descriptions only. */
export function skillsPromptSection(skills: SkillSummary[]): string {
  if (skills.length === 0) return "";

  return [
    "",
    "## Skills available in this workspace",
    "",
    "These are procedures this project has written down. Load one with load_skill",
    "before following it — the summaries below are not the instructions.",
    "",
    ...skills.map((skill) => skillSummary(skill)),
  ].join("\n");
}

/* Records what the node found, so the thread shows which procedures were in
   scope and flags any that failed to parse. A skill its author believes is
   active but that never loads is worse than an error. */
export function recordSkillProblems(
  taskId: string,
  problems: Array<{ path: string; message: string }>,
): void {
  for (const problem of problems) {
    append(taskId, {
      kind: "log",
      stream: "stderr",
      chunk: `Skill not loaded — ${problem.path}: ${problem.message}\n`,
    });
  }
}
