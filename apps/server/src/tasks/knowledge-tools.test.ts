import { expect, test, describe, beforeEach } from "bun:test";
import { db, schema } from "../db";
import { resetDatabase } from "../test/harness";
import { replay, resetListeners } from "./events";
import { getKnowledge } from "../projects/knowledge";
import {
  KNOWLEDGE_TOOLS,
  isKnowledgeTool,
  runKnowledgeTool,
  knowledgePromptSection,
} from "./knowledge-tools";

const USER = "u1";
const PROJECT = "p1";
const TASK = "t1";
const NODE = "n1";

beforeEach(async () => {
  resetDatabase();
  resetListeners();

  const now = Date.now();
  await db.insert(schema.users).values({
    id: USER,
    email: "u@x.com",
    passwordHash: "x",
    instanceRole: "user",
    status: "active",
    createdAt: now,
  });
  await db.insert(schema.projects).values({
    id: PROJECT,
    ownerUserId: USER,
    ownerOrgId: null,
    name: "AI Novel",
    slug: "ai-novel",
    repoUrl: null,
    branch: null,
    instructions: null,
    defaultModelId: null,
    defaultTier: null,
    spendCapUsd: null,
    createdAt: now,
  });
  await db.insert(schema.nodes).values({
    id: NODE,
    ownerUserId: USER,
    ownerOrgId: null,
    name: "MAIN.SRV",
    tokenHash: "hash",
    status: "online",
    os: "linux",
    arch: "x64",
    version: "0.1.0",
    capabilities: [],
    maxConcurrentTasks: 2,
    lastSeenAt: now,
    createdAt: now,
  });
  await db.insert(schema.tasks).values({
    id: TASK,
    projectId: PROJECT,
    workspaceId: null,
    nodeId: NODE,
    actorUserId: USER,
    title: "Continue the ai_novel project",
    prompt: "continue at /root/prog/ai_novel",
    status: "running",
    model: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    createdAt: now,
  });
});

function call(name: string, args: unknown) {
  return { id: "call-1", name, argumentsJson: JSON.stringify(args) };
}

async function lastResult() {
  const events = await replay(TASK);
  return events.find((e) => e.kind === "tool_result") as { ok: boolean; output: string } | undefined;
}

describe("tool names", () => {
  test("all five are recognised", () => {
    for (const tool of KNOWLEDGE_TOOLS) expect(isKnowledgeTool(tool.name)).toBe(true);
  });

  test("an ordinary node tool is not one of these", () => {
    expect(isKnowledgeTool("read_file")).toBe(false);
    expect(isKnowledgeTool("bash")).toBe(false);
  });
});

describe("set_project_brief", () => {
  test("saves the brief", async () => {
    await runKnowledgeTool(TASK, PROJECT, NODE, call("set_project_brief", { text: "A narrative generator." }));

    expect((await lastResult())!.ok).toBe(true);
    expect((await getKnowledge(PROJECT)).brief).toBe("A narrative generator.");
  });

  test("an empty string clears it", async () => {
    await runKnowledgeTool(TASK, PROJECT, NODE, call("set_project_brief", { text: "something" }));
    await runKnowledgeTool(TASK, PROJECT, NODE, call("set_project_brief", { text: "" }));
    expect((await getKnowledge(PROJECT)).brief).toBeNull();
  });
});

describe("set_workspace_path", () => {
  test("registers the path against the node the task is running on", async () => {
    await runKnowledgeTool(TASK, PROJECT, NODE, call("set_workspace_path", { path: "/root/prog/ai_novel" }));

    const result = await lastResult();
    expect(result!.ok).toBe(true);
    /* The load-bearing detail: it must say this does not move the task
       currently running, or the model will assume tool calls it already made
       this turn silently changed root. */
    expect(result!.output).toMatch(/from now on|already started in/i);

    const knowledge = await getKnowledge(PROJECT);
    expect(knowledge.workspaces).toEqual([
      expect.objectContaining({ nodeId: NODE, path: "/root/prog/ai_novel" }),
    ]);
  });

  test("refuses an empty path rather than storing one", async () => {
    await runKnowledgeTool(TASK, PROJECT, NODE, call("set_workspace_path", { path: "" }));
    expect((await lastResult())!.ok).toBe(false);
    expect((await getKnowledge(PROJECT)).workspaces).toEqual([]);
  });

  test("calling it again replaces the path rather than adding a second one", async () => {
    await runKnowledgeTool(TASK, PROJECT, NODE, call("set_workspace_path", { path: "/tmp/wrong" }));
    await runKnowledgeTool(TASK, PROJECT, NODE, call("set_workspace_path", { path: "/root/prog/ai_novel" }));

    const knowledge = await getKnowledge(PROJECT);
    expect(knowledge.workspaces).toHaveLength(1);
    expect(knowledge.workspaces[0]!.path).toBe("/root/prog/ai_novel");
  });
});

describe("add_project_fact", () => {
  test("registers a directory tied to the current node", async () => {
    await runKnowledgeTool(
      TASK,
      PROJECT,
      NODE,
      call("add_project_fact", { kind: "directory", label: "assets", value: "/root/prog/ai_novel/assets" }),
    );

    const [note] = (await getKnowledge(PROJECT)).notes;
    expect(note).toMatchObject({ kind: "directory", label: "assets", nodeId: NODE });
  });

  /* A URL is not the current machine's property, so the tool must not silently
     attach it to whichever node happened to run the call. */
  test("a url is not tied to the current node", async () => {
    await runKnowledgeTool(
      TASK,
      PROJECT,
      NODE,
      call("add_project_fact", { kind: "url", label: "repo", value: "https://github.com/x/ai-novel" }),
    );

    const [note] = (await getKnowledge(PROJECT)).notes;
    expect(note!.nodeId).toBeNull();
  });

  test("rejects a kind outside the enum", async () => {
    await runKnowledgeTool(
      TASK,
      PROJECT,
      NODE,
      call("add_project_fact", { kind: "database", label: "x", value: "y" }),
    );
    expect((await lastResult())!.ok).toBe(false);
    expect((await getKnowledge(PROJECT)).notes).toEqual([]);
  });

  test("requires both a label and a value", async () => {
    await runKnowledgeTool(TASK, PROJECT, NODE, call("add_project_fact", { kind: "port", label: "", value: "3000" }));
    expect((await lastResult())!.ok).toBe(false);
  });
});

describe("remember and forget", () => {
  test("remember adds a memory", async () => {
    await runKnowledgeTool(TASK, PROJECT, NODE, call("remember", { text: "Uses Postgres, not SQLite." }));
    expect((await lastResult())!.ok).toBe(true);

    const memories = (await getKnowledge(PROJECT)).notes.filter((n) => n.kind === "memory");
    expect(memories).toHaveLength(1);
  });

  test("forget removes a note by id", async () => {
    await runKnowledgeTool(TASK, PROJECT, NODE, call("remember", { text: "temporary" }));
    const [note] = (await getKnowledge(PROJECT)).notes;

    await runKnowledgeTool(TASK, PROJECT, NODE, call("forget", { id: note!.id }));
    expect((await lastResult())!.ok).toBe(true);
    expect((await getKnowledge(PROJECT)).notes).toEqual([]);
  });

  test("forgetting an id that does not exist is reported, not thrown", async () => {
    await runKnowledgeTool(TASK, PROJECT, NODE, call("forget", { id: "no-such-id" }));
    const result = await lastResult();
    expect(result!.ok).toBe(true);
    expect(result!.output).toMatch(/nothing/i);
  });
});

describe("malformed arguments", () => {
  test("invalid JSON is reported as a failed call, not a crash", async () => {
    await runKnowledgeTool(TASK, PROJECT, NODE, {
      id: "call-1",
      name: "remember",
      argumentsJson: "{not json",
    });
    expect((await lastResult())!.ok).toBe(false);
  });
});

describe("the system-prompt section", () => {
  test("is empty for a project that knows nothing", async () => {
    expect(knowledgePromptSection(await getKnowledge(PROJECT), NODE)).toBe("");
  });

  test("states where the current node is already working", async () => {
    await runKnowledgeTool(TASK, PROJECT, NODE, call("set_workspace_path", { path: "/root/prog/ai_novel" }));
    const section = knowledgePromptSection(await getKnowledge(PROJECT), NODE);

    expect(section).toContain("/root/prog/ai_novel");
    expect(section).toContain("MAIN.SRV");
  });

  test("does not claim a location on a node with no registered path", async () => {
    await runKnowledgeTool(
      TASK,
      PROJECT,
      NODE,
      call("add_project_fact", { kind: "url", label: "repo", value: "https://x" }),
    );
    const section = knowledgePromptSection(await getKnowledge(PROJECT), "some-other-node");
    expect(section).not.toContain("You are working in");
  });

  test("lists facts and memories with their ids, so forget can reference them", async () => {
    await runKnowledgeTool(
      TASK,
      PROJECT,
      NODE,
      call("add_project_fact", { kind: "port", label: "dev server", value: "4000" }),
    );
    await runKnowledgeTool(TASK, PROJECT, NODE, call("remember", { text: "Outline lives in outline.md." }));

    const section = knowledgePromptSection(await getKnowledge(PROJECT), NODE);
    expect(section).toContain('port "dev server": 4000');
    expect(section).toContain("Outline lives in outline.md.");
  });

  /* Facts overwrite and stay small on their own; memories only ever grow, so
     what reaches every prompt has to be capped or a long-lived project's
     context would grow without bound. */
  test("caps how many memories are shown", async () => {
    for (let i = 0; i < 25; i++) {
      await runKnowledgeTool(TASK, PROJECT, NODE, call("remember", { text: `memory ${i}` }));
    }
    const section = knowledgePromptSection(await getKnowledge(PROJECT), NODE);
    const shown = section.split("\n").filter((line) => line.startsWith("- [")).length;
    expect(shown).toBeLessThanOrEqual(20);
  });
});
