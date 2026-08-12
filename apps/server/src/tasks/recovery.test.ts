import { expect, test, describe, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { resetDatabase } from "../test/harness";
import { resetListeners, replay } from "./events";
import { recoverOrphanedTasks } from "./recovery";

/* A task's loop lives in the server process. When that process dies the row is
   left mid-flight, and nothing will ever move it — so the UI spins forever and
   the node holds the slot. These pin the cleanup. */

beforeEach(async () => {
  resetDatabase();
  resetListeners();

  const now = Date.now();
  await db.insert(schema.users).values({
    id: "u1", email: "u@x.com", passwordHash: "x", instanceRole: "user", status: "active", createdAt: now,
  });
  await db.insert(schema.projects).values({
    id: "p1", ownerUserId: "u1", ownerOrgId: null, name: "P", slug: "p",
    repoUrl: null, branch: null, instructions: null, defaultModelId: null, spendCapUsd: null, createdAt: now,
  });
});

async function makeTask(id: string, status: string) {
  await db.insert(schema.tasks).values({
    id, projectId: "p1", workspaceId: null, nodeId: null, actorUserId: "u1",
    title: id, prompt: "x", status: status as never, model: null,
    costUsd: 0, inputTokens: 0, outputTokens: 0, error: null,
    startedAt: Date.now(), endedAt: null, createdAt: Date.now(),
  });
}

const statusOf = async (id: string) =>
  (await db.select({ s: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1))[0]?.s;

describe("recovery on boot", () => {
  test("fails a task left running by a dead process", async () => {
    await makeTask("t-running", "running");
    expect(await recoverOrphanedTasks()).toBe(1);
    expect(await statusOf("t-running")).toBe("failed");
  });

  test("covers every state a task can be stuck in", async () => {
    await makeTask("t-queued", "queued");
    await makeTask("t-assigned", "assigned");
    await makeTask("t-running", "running");
    await makeTask("t-waiting", "awaiting_approval");

    expect(await recoverOrphanedTasks()).toBe(4);
    for (const id of ["t-queued", "t-assigned", "t-running", "t-waiting"]) {
      expect(await statusOf(id)).toBe("failed");
    }
  });

  test("leaves finished tasks alone", async () => {
    await makeTask("t-done", "completed");
    await makeTask("t-failed", "failed");
    await makeTask("t-cancelled", "cancelled");

    expect(await recoverOrphanedTasks()).toBe(0);
    expect(await statusOf("t-done")).toBe("completed");
    expect(await statusOf("t-cancelled")).toBe("cancelled");
  });

  /* The transcript is the record of what happened, so a task that died with
     the server has to say so rather than just stopping mid-sentence. */
  test("records why, in the thread as well as the row", async () => {
    await makeTask("t-running", "running");
    await recoverOrphanedTasks();

    const [row] = await db
      .select({ error: schema.tasks.error, endedAt: schema.tasks.endedAt })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, "t-running"))
      .limit(1);

    expect(row.error).toContain("server restarted");
    expect(row.endedAt).toBeGreaterThan(0);

    const events = await replay("t-running");
    const last = events.at(-1);
    expect(last?.kind).toBe("status");
    expect((last as { status: string }).status).toBe("failed");
  });

  test("says specifically when a task was waiting on a human", async () => {
    await makeTask("t-waiting", "awaiting_approval");
    await recoverOrphanedTasks();

    const [row] = await db
      .select({ error: schema.tasks.error })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, "t-waiting"))
      .limit(1);

    expect(row.error).toContain("waiting for approval");
  });

  test("is safe to run twice", async () => {
    await makeTask("t-running", "running");
    expect(await recoverOrphanedTasks()).toBe(1);
    expect(await recoverOrphanedTasks()).toBe(0);
  });
});
