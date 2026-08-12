import type { ToolDefinition } from "../providers/types";
import {
  setBrief,
  setWorkspacePath,
  upsertFact,
  addMemory,
  deleteNote,
  type ProjectKnowledge,
} from "../projects/knowledge";
import { append } from "./events";

/* Project knowledge, from the agent's side.
 *
 * Answered by the server, not the node — like load_skill, this is a Maestro
 * concept rather than a filesystem operation, so it needs no workspace and no
 * approval: nothing here touches a file, a shell, or a network address. It
 * only ever writes to Maestro's own record of the project.
 *
 * Five tools rather than one generic one, because a model asked to fill in a
 * `kind` field on a single do-everything tool is a model that occasionally
 * gets the field wrong; five narrow, named tools with their own descriptions
 * are more reliable to call correctly. */

export const KNOWLEDGE_TOOLS: ToolDefinition[] = [
  {
    name: "set_project_brief",
    description:
      "Set or replace this project's brief, prepended to every future task's instructions. Call this " +
      "once you understand what the project is, so the next task does not have to be told again.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The brief. Replaces whatever was there before." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "set_workspace_path",
    description:
      "Register where this project's code already lives on the machine this task is running on. Call " +
      "this the first time you are told a project already exists at a given path, instead of starting a " +
      "fresh checkout. Takes effect for tasks dispatched to this machine from now on — not for the rest " +
      "of the task currently running, which keeps using the directory it already started in.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the project's root on this machine." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "add_project_fact",
    description:
      'Register a labelled fact about the project: a directory besides the workspace root, a URL, or a ' +
      'port. Calling this again with the same label replaces the old value, so use a short, stable label ' +
      '— "docs", "staging", "dev server" — not a fresh one each time.',
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["directory", "url", "port"],
          description: "What this fact describes.",
        },
        label: { type: "string", description: 'A short, stable name, e.g. "docs" or "dev server".' },
        value: { type: "string", description: "The path, URL, or port number." },
      },
      required: ["kind", "label", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "remember",
    description:
      "Note something worth knowing for a future task on this project — a decision made, something " +
      "learned about how it works, a gotcha. Unlike add_project_fact this always adds a new memory " +
      "rather than replacing one; use it for anything that is not a single current value.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "forget",
    description:
      'Remove a registered fact or memory by its id, as shown in "What is already known about this ' +
      'project" at the top of your instructions.',
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

const NAMES = new Set(KNOWLEDGE_TOOLS.map((t) => t.name));

export function isKnowledgeTool(name: string): boolean {
  return NAMES.has(name);
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : "";
}

async function execute(
  name: string,
  args: Record<string, unknown>,
  projectId: string,
  nodeId: string,
): Promise<string> {
  switch (name) {
    case "set_project_brief": {
      const text = str(args, "text");
      await setBrief(projectId, text || null);
      return text ? "Brief saved." : "Brief cleared.";
    }

    case "set_workspace_path": {
      const path = str(args, "path");
      if (!path) throw new Error("Give a path.");
      await setWorkspacePath(projectId, nodeId, path);
      return (
        `Saved. Tasks dispatched to this machine from now on will start in ${path}. ` +
        `This task keeps running in the directory it already started in.`
      );
    }

    case "add_project_fact": {
      const kind = args.kind;
      if (kind !== "directory" && kind !== "url" && kind !== "port") {
        throw new Error('kind must be "directory", "url", or "port".');
      }
      const label = str(args, "label");
      const value = str(args, "value");
      if (!label || !value) throw new Error("Both a label and a value are required.");

      /* Only a directory is inherently tied to this machine's filesystem; a
         URL or a port is recorded as stated, without silently attaching it to
         wherever the model happened to be running when it said so. */
      await upsertFact(projectId, kind, label, value, kind === "directory" ? nodeId : null);
      return `Saved ${kind} "${label}".`;
    }

    case "remember": {
      const text = str(args, "text");
      if (!text) throw new Error("Give something to remember.");
      await addMemory(projectId, text);
      return "Remembered.";
    }

    case "forget": {
      const id = str(args, "id");
      if (!id) throw new Error("Give the id to forget.");
      const removed = await deleteNote(projectId, id);
      return removed ? "Forgotten." : "There was nothing with that id.";
    }

    default:
      throw new Error(`There is no tool called ${name}.`);
  }
}

function summarise(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "set_project_brief":
      return "set the project brief";
    case "set_workspace_path":
      return `workspace root → ${str(args, "path")}`;
    case "add_project_fact":
      return `${String(args.kind ?? "fact")} "${str(args, "label")}" → ${str(args, "value")}`;
    case "remember":
      return `remember: ${str(args, "text").slice(0, 80)}`;
    case "forget":
      return `forget ${str(args, "id")}`;
    default:
      return name;
  }
}

export async function runKnowledgeTool(
  taskId: string,
  projectId: string,
  nodeId: string,
  call: { id: string; name: string; argumentsJson: string },
): Promise<void> {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(call.argumentsJson || "{}");
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
  } catch {
    append(taskId, { kind: "tool_call", callId: call.id, tool: call.name, args: {}, summary: call.name });
    append(taskId, {
      kind: "tool_result",
      callId: call.id,
      ok: false,
      output: `The arguments for ${call.name} were not valid JSON. Send them again as a JSON object.`,
    });
    return;
  }

  append(taskId, {
    kind: "tool_call",
    callId: call.id,
    tool: call.name,
    args,
    summary: summarise(call.name, args),
  });

  try {
    const output = await execute(call.name, args, projectId, nodeId);
    append(taskId, { kind: "tool_result", callId: call.id, ok: true, output });
  } catch (err) {
    append(taskId, {
      kind: "tool_result",
      callId: call.id,
      ok: false,
      output: err instanceof Error ? err.message : String(err),
    });
  }
}

/* The block appended to the system prompt: what the project's own tools have
 * already registered, plus where "here" is right now — so the model does not
 * have to call a tool just to find out what it already knows. */
export function knowledgePromptSection(
  knowledge: ProjectKnowledge,
  currentNodeId: string | null,
): string {
  const here = knowledge.workspaces.find((w) => w.nodeId === currentNodeId);
  const facts = knowledge.notes.filter((n) => n.kind !== "memory");
  /* Facts overwrite, so they stay small on their own; memories only ever grow,
     so what reaches every prompt is capped to the most recent ones rather than
     the whole history. */
  const memories = knowledge.notes.filter((n) => n.kind === "memory").slice(0, 20);

  if (!here && facts.length === 0 && memories.length === 0) return "";

  const lines: string[] = ["", "## What is already known about this project"];

  if (here) {
    lines.push("", `You are working in ${here.path}${here.nodeName ? ` on ${here.nodeName}` : ""}.`);
  }

  if (facts.length > 0) {
    lines.push("", "Registered facts:");
    for (const fact of facts) {
      const where = fact.nodeName ? ` (${fact.nodeName})` : "";
      lines.push(`- [${fact.id}] ${fact.kind} "${fact.label}": ${fact.value}${where}`);
    }
  }

  if (memories.length > 0) {
    lines.push("", "Memories from earlier work on this project, most recent first:");
    for (const memory of memories) lines.push(`- [${memory.id}] ${memory.value}`);
  }

  lines.push(
    "",
    "Keep this current with set_project_brief, set_workspace_path, add_project_fact, remember and forget " +
      "— especially the first time you learn where a project already lives.",
  );

  return lines.join("\n");
}
