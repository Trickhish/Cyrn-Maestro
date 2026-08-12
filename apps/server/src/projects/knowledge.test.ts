import { expect, test, describe, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { resetDatabase } from "../test/harness";
import { getKnowledge, setBrief, setWorkspacePath, upsertFact, addMemory, deleteNote } from "./knowledge";

const USER = "u1";
const PROJECT = "p1";
const NODE = "n1";
const NODE2 = "n2";

async function seed() {
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
  for (const [id, name] of [[NODE, "MAIN.SRV"], [NODE2, "build-box"]] as const) {
    await db.insert(schema.nodes).values({
      id,
      ownerUserId: USER,
      ownerOrgId: null,
      name,
      tokenHash: `hash-${id}`,
      status: "online",
      os: "linux",
      arch: "x64",
      version: "0.1.0",
      capabilities: [],
      maxConcurrentTasks: 2,
      lastSeenAt: now,
      createdAt: now,
    });
  }
}

beforeEach(async () => {
  resetDatabase();
  await seed();
});

describe("brief", () => {
  test("is null on a fresh project", async () => {
    expect((await getKnowledge(PROJECT)).brief).toBeNull();
  });

  test("reuses projects.instructions rather than a second column", async () => {
    await setBrief(PROJECT, "A narrative generator.");
    const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, PROJECT));
    expect(row!.instructions).toBe("A narrative generator.");
  });

  test("clearing it with null actually clears it", async () => {
    await setBrief(PROJECT, "something");
    await setBrief(PROJECT, null);
    expect((await getKnowledge(PROJECT)).brief).toBeNull();
  });
});

describe("workspace path", () => {
  test("nothing until it is set", async () => {
    expect((await getKnowledge(PROJECT)).workspaces).toEqual([]);
  });

  test("registers a path for one machine", async () => {
    await setWorkspacePath(PROJECT, NODE, "/root/prog/ai_novel");
    const [ws] = (await getKnowledge(PROJECT)).workspaces;
    expect(ws).toMatchObject({ nodeId: NODE, nodeName: "MAIN.SRV", path: "/root/prog/ai_novel" });
  });

  /* This is the whole point: telling it again replaces the answer instead of
     leaving two conflicting rows for the same machine. */
  test("setting it again for the same machine replaces the path", async () => {
    await setWorkspacePath(PROJECT, NODE, "/tmp/wrong");
    await setWorkspacePath(PROJECT, NODE, "/root/prog/ai_novel");

    const workspaces = (await getKnowledge(PROJECT)).workspaces;
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!.path).toBe("/root/prog/ai_novel");
  });

  test("different machines keep independent paths", async () => {
    await setWorkspacePath(PROJECT, NODE, "/root/prog/ai_novel");
    await setWorkspacePath(PROJECT, NODE2, "/srv/ai_novel");

    const byNode = Object.fromEntries(
      (await getKnowledge(PROJECT)).workspaces.map((w) => [w.nodeId, w.path]),
    );
    expect(byNode[NODE]).toBe("/root/prog/ai_novel");
    expect(byNode[NODE2]).toBe("/srv/ai_novel");
  });

  /* A workspace row the task-dispatch path creates automatically (empty path,
     "the node decides") must not read as a registered location. */
  test("an auto-created empty-path row is not shown as a registered workspace", async () => {
    await db.insert(schema.workspaces).values({
      id: crypto.randomUUID(),
      projectId: PROJECT,
      nodeId: NODE,
      path: "",
      branch: null,
      provisionedAt: Date.now(),
      createdAt: Date.now(),
    });
    expect((await getKnowledge(PROJECT)).workspaces).toEqual([]);
  });
});

describe("facts", () => {
  test("adds a labelled fact", async () => {
    await upsertFact(PROJECT, "directory", "assets", "/root/prog/ai_novel/assets", NODE);

    const [note] = (await getKnowledge(PROJECT)).notes;
    expect(note).toMatchObject({
      kind: "directory",
      label: "assets",
      value: "/root/prog/ai_novel/assets",
      nodeName: "MAIN.SRV",
    });
  });

  /* Same reasoning as the workspace path: "docs" should have one current
     answer, not a pile of every value it was ever set to. */
  test("registering the same label again replaces the value", async () => {
    await upsertFact(PROJECT, "url", "staging", "https://old.example.com", null);
    await upsertFact(PROJECT, "url", "staging", "https://staging.example.com", null);

    const notes = (await getKnowledge(PROJECT)).notes;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.value).toBe("https://staging.example.com");
  });

  test("the same label under a different kind is a separate fact", async () => {
    await upsertFact(PROJECT, "url", "api", "https://api.example.com", null);
    await upsertFact(PROJECT, "port", "api", "4000", null);

    expect((await getKnowledge(PROJECT)).notes).toHaveLength(2);
  });

  test("a fact with no node is fine — a URL is not tied to a machine", async () => {
    await upsertFact(PROJECT, "url", "repo", "https://github.com/x/ai-novel", null);
    const [note] = (await getKnowledge(PROJECT)).notes;
    expect(note!.nodeId).toBeNull();
    expect(note!.nodeName).toBeNull();
  });

  test("returns the id of the row, including on an update", async () => {
    const first = await upsertFact(PROJECT, "port", "dev", "3000", null);
    const second = await upsertFact(PROJECT, "port", "dev", "3001", null);
    expect(second.id).toBe(first.id);
  });
});

describe("memories", () => {
  test("each call adds a new row rather than replacing one", async () => {
    await addMemory(PROJECT, "Uses Postgres, not SQLite.");
    await addMemory(PROJECT, "The generator script lives in scripts/generate.py.");

    const memories = (await getKnowledge(PROJECT)).notes.filter((n) => n.kind === "memory");
    expect(memories).toHaveLength(2);
  });

  test("identical text twice is two memories, not a duplicate error", async () => {
    await addMemory(PROJECT, "Remember to check the outline first.");
    await addMemory(PROJECT, "Remember to check the outline first.");
    const memories = (await getKnowledge(PROJECT)).notes.filter((n) => n.kind === "memory");
    expect(memories).toHaveLength(2);
  });

  test("has no label and no node", async () => {
    await addMemory(PROJECT, "note to self");
    const [note] = (await getKnowledge(PROJECT)).notes;
    expect(note!.label).toBeNull();
    expect(note!.nodeId).toBeNull();
  });
});

describe("deleting a note", () => {
  test("removes it", async () => {
    const { id } = await addMemory(PROJECT, "temporary");
    expect(await deleteNote(PROJECT, id)).toBe(true);
    expect((await getKnowledge(PROJECT)).notes).toEqual([]);
  });

  test("reports false for a note that does not exist", async () => {
    expect(await deleteNote(PROJECT, "no-such-id")).toBe(false);
  });

  /* The id alone must not be enough — otherwise any project could delete any
     other project's note by guessing or reusing an id. */
  test("cannot delete a note belonging to a different project", async () => {
    const { id } = await addMemory(PROJECT, "mine");
    expect(await deleteNote("some-other-project", id)).toBe(false);
    expect((await getKnowledge(PROJECT)).notes).toHaveLength(1);
  });
});
