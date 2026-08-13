import { expect, test, describe, beforeEach, afterAll, mock } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db";
import { resetDatabase } from "../test/harness";

/* mock.module is process-wide, so the real module is captured first and put
   back at the end rather than left stubbed for every later test file. */
const realRunner = { ...(await import("./runner")) };
afterAll(() => {
  mock.module("./runner", () => realRunner);
});

/* Reporting back on dispatched work.
 *
 * This used to be the browser's job, which made a completion something only a
 * tab that happened to be open could notice — miss it and the report never
 * came, reload at the wrong moment and it came twice. These pin the rules that
 * replaced it: only the Conductor's own dispatches are reported, exactly once,
 * into the thread that dispatched them. */

/* The turn itself is a model call, so it is stubbed — what is under test is who
   gets reported on and how often, not what the model says about them. */
const turns: Array<{ actorId: string; question: string; projectId?: string }> = [];

mock.module("./runner", () => ({
  askConductor: async (
    actor: { id: string },
    _history: unknown,
    question: string,
    _signal: unknown,
    context: { projectId?: string } = {},
  ) => {
    turns.push({ actorId: actor.id, question, projectId: context.projectId });
    return { text: "It went fine.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model: "m" };
  },
  CONDUCTOR_LIST_NAME: "manager/conductor",
}));

const { followUpOnTask, followUpOnMissed } = await import("./followup");

beforeEach(async () => {
  resetDatabase();
  turns.length = 0;

  const now = Date.now();
  await db.insert(schema.users).values({
    id: "u1", email: "u@x.com", passwordHash: "x", instanceRole: "user", status: "active", createdAt: now,
  });
  await db.insert(schema.projects).values({
    id: "p1", ownerUserId: "u1", ownerOrgId: null, name: "P", slug: "p",
    repoUrl: null, branch: null, instructions: null, defaultModelId: null, spendCapUsd: null, createdAt: now,
  });
});

interface TaskOptions {
  status?: string;
  conductorActorId?: string | null;
  conductorProjectId?: string | null;
}

async function makeTask(id: string, options: TaskOptions = {}) {
  await db.insert(schema.tasks).values({
    id, projectId: "p1", workspaceId: null, nodeId: null, actorUserId: "u1",
    title: id, prompt: "x", status: (options.status ?? "completed") as never, model: null,
    conductorActorId: options.conductorActorId === undefined ? "u1" : options.conductorActorId,
    conductorProjectId: options.conductorProjectId ?? null,
    costUsd: 0, inputTokens: 0, outputTokens: 0, error: null,
    startedAt: Date.now(), endedAt: Date.now(), createdAt: Date.now(),
  });
}

const threadOf = (projectId: string | null) =>
  db
    .select()
    .from(schema.conductorMessages)
    .where(
      and(
        eq(schema.conductorMessages.actorUserId, "u1"),
        projectId
          ? eq(schema.conductorMessages.projectId, projectId)
          : isNull(schema.conductorMessages.projectId),
      ),
    );

describe("following up on a finished task", () => {
  test("reports a completed task into the thread that dispatched it", async () => {
    await makeTask("t1", { conductorProjectId: "p1" });
    await followUpOnTask("t1");

    expect(turns).toHaveLength(1);
    expect(turns[0].question).toContain("t1");
    expect(turns[0].question).toContain("completed");

    const thread = await threadOf("p1");
    expect(thread).toHaveLength(1);
    expect(thread[0].role).toBe("assistant");
    expect(thread[0].content).toBe("It went fine.");
  });

  /* The global Conductor dispatches into projects too, and its thread is the
     one with no project — reporting into the task's project would put the
     answer in a conversation the user never had. */
  test("reports into the global thread when that is where it came from", async () => {
    await makeTask("t1", { conductorProjectId: null });
    await followUpOnTask("t1");

    expect(await threadOf(null)).toHaveLength(1);
    expect(await threadOf("p1")).toHaveLength(0);
  });

  test("says nothing about a task a human dispatched", async () => {
    await makeTask("t1", { conductorActorId: null });
    await followUpOnTask("t1");

    expect(turns).toHaveLength(0);
    expect(await threadOf(null)).toHaveLength(0);
  });

  test("says nothing about a task that has not finished", async () => {
    await makeTask("t1", { status: "running" });
    await followUpOnTask("t1");

    expect(turns).toHaveLength(0);
  });

  test.each(["failed", "cancelled"])("reports a %s task too", async (status) => {
    await makeTask("t1", { status });
    await followUpOnTask("t1");

    expect(turns).toHaveLength(1);
    expect(turns[0].question).toContain(status);
  });

  /* The whole point of the claim: finish() can be reached more than once, and a
     boot sweep looks at rows a live trigger may also be holding. */
  test("reports once even when triggered repeatedly", async () => {
    await makeTask("t1");

    await followUpOnTask("t1");
    await followUpOnTask("t1");
    await followUpOnTask("t1");

    expect(turns).toHaveLength(1);
    expect(await threadOf(null)).toHaveLength(1);
  });

  test("concurrent triggers still produce one report", async () => {
    await makeTask("t1");

    await Promise.all([followUpOnTask("t1"), followUpOnTask("t1"), followUpOnTask("t1")]);

    expect(turns).toHaveLength(1);
  });
});

describe("the boot sweep", () => {
  test("picks up tasks that ended while the server was down", async () => {
    await makeTask("t1", { status: "completed" });
    await makeTask("t2", { status: "failed" });
    /* Not conductor-dispatched, and still running: neither is owed a report. */
    await makeTask("t3", { conductorActorId: null });
    await makeTask("t4", { status: "running" });

    expect(await followUpOnMissed()).toBe(2);
    expect(turns.map((t) => t.question.match(/\[(t\d)\]/)?.[1]).sort()).toEqual(["t1", "t2"]);
  });

  test("does not report again on a later boot", async () => {
    await makeTask("t1");

    await followUpOnMissed();
    expect(turns).toHaveLength(1);

    await followUpOnMissed();
    expect(turns).toHaveLength(1);
  });
});
