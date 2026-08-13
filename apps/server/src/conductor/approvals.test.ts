import { expect, test, describe, beforeEach, afterAll, mock } from "bun:test";
import { db, schema } from "../db";
import { resetDatabase } from "../test/harness";

/* mock.module replaces the module for the whole process, not just this file, so
   the real one is captured first and put back at the end — otherwise every
   later file that uses conductorProvider gets this stub instead. */
const realRunner = { ...(await import("./runner")) };
afterAll(() => {
  mock.module("./runner", () => realRunner);
});

/* The Conductor answering a worker's approval prompt.
 *
 * The prompt is the machine owner's control, so the rules that matter here are
 * the ones that decide when it is NOT answered: the setting, the budget, and
 * every failure. All of those must come back null, which means a human decides.
 * A bug that turns a failure into an approval runs code on someone's machine. */

let reply = '{"approve": true, "reason": "ordinary build step"}';
let fail: Error | null = null;
const asked: string[] = [];

mock.module("./runner", () => ({
  conductorProvider: async () => ({
    model: "m",
    reasoningEffort: undefined,
    adapter: {
      async *stream({ messages }: { messages: Array<{ content: string }> }) {
        asked.push(messages.map((m) => m.content).join("\n"));
        if (fail) throw fail;
        yield { type: "text", delta: reply };
      },
    },
  }),
  CONDUCTOR_LIST_NAME: "manager/conductor",
}));

const { adjudicate, parseDecision, AUTO_APPROVAL_LIMIT } = await import("./approvals");

beforeEach(async () => {
  resetDatabase();
  reply = '{"approve": true, "reason": "ordinary build step"}';
  fail = null;
  asked.length = 0;

  const now = Date.now();
  await db.insert(schema.users).values({
    id: "u1", email: "u@x.com", passwordHash: "x", instanceRole: "user", status: "active", createdAt: now,
  });
  await db.insert(schema.projects).values({
    id: "p1", ownerUserId: "u1", ownerOrgId: null, name: "P", slug: "p",
    repoUrl: null, branch: null, instructions: null, defaultModelId: null, spendCapUsd: null,
    conductorApproves: true, createdAt: now,
  });
  await db.insert(schema.tasks).values({
    id: "t1", projectId: "p1", workspaceId: null, nodeId: null, actorUserId: "u1",
    title: "Build it", prompt: "Run the build", status: "running", model: null,
    costUsd: 0, inputTokens: 0, outputTokens: 0, error: null,
    startedAt: now, endedAt: null, createdAt: now,
  });
});

const ask = () =>
  adjudicate({ taskId: "t1", projectId: "p1", tool: "bash", summary: "npm run build", reason: "may change the machine" });

describe("deciding an approval", () => {
  test("approves when the model says yes", async () => {
    expect(await ask()).toEqual({ approved: true, reason: "ordinary build step" });
  });

  test("refuses when the model says no", async () => {
    reply = '{"approve": false, "reason": "this publishes"}';
    expect(await ask()).toEqual({ approved: false, reason: "this publishes" });
  });

  /* A refusal is a real answer — the worker is told no and moves on. It must
     not be confused with deferring, which sends the question to a human. */
  test("a refusal is a decision, not a deferral", async () => {
    reply = '{"approve": false, "reason": "no"}';
    expect(await ask()).not.toBeNull();
  });

  test("passes the command and the task to the model", async () => {
    await ask();
    expect(asked[0]).toContain("npm run build");
    expect(asked[0]).toContain("Run the build");
  });
});

describe("when a human must decide instead", () => {
  test("the project has not turned it on", async () => {
    await db.update(schema.projects).set({ conductorApproves: false });
    expect(await ask()).toBeNull();
    expect(asked).toHaveLength(0);
  });

  test("the provider throws", async () => {
    fail = new Error("no credentials");
    expect(await ask()).toBeNull();
  });

  test.each([
    ["prose instead of JSON", "Yes, that looks fine to me."],
    ["empty", ""],
    ["malformed JSON", '{"approve": tru'],
    ["a missing verdict", '{"reason": "looks fine"}'],
    ["a non-boolean verdict", '{"approve": "yes"}'],
  ])("the answer is %s", async (_label, text) => {
    reply = text;
    expect(await ask()).toBeNull();
  });

  test("the task's account is suspended", async () => {
    await db.update(schema.users).set({ status: "suspended" });
    expect(await ask()).toBeNull();
  });

  test("the budget for one task is spent", async () => {
    for (let i = 0; i < AUTO_APPROVAL_LIMIT; i++) {
      await db.insert(schema.approvals).values({
        id: `a${i}`, taskId: "t1", callId: `c${i}`, tool: "bash", summary: "x", reason: "y",
        approved: true, decidedBy: null, decidedByConductor: true, decisionReason: "ok",
        decidedAt: Date.now(), requestedAt: Date.now(),
      });
    }

    expect(await ask()).toBeNull();
    expect(asked).toHaveLength(0);
  });

  /* Approvals a person made do not count against the Conductor's budget. */
  test("a human's own decisions do not spend the budget", async () => {
    for (let i = 0; i < AUTO_APPROVAL_LIMIT; i++) {
      await db.insert(schema.approvals).values({
        id: `a${i}`, taskId: "t1", callId: `c${i}`, tool: "bash", summary: "x", reason: "y",
        approved: true, decidedBy: "u1", decidedByConductor: false, decisionReason: null,
        decidedAt: Date.now(), requestedAt: Date.now(),
      });
    }

    expect(await ask()).not.toBeNull();
  });
});

describe("reading the model's verdict", () => {
  test("takes a clean yes and no", () => {
    expect(parseDecision('{"approve": true, "reason": "fine"}')).toEqual({ approved: true, reason: "fine" });
    expect(parseDecision('{"approve": false, "reason": "no"}')).toEqual({ approved: false, reason: "no" });
  });

  test("finds the verdict inside surrounding chatter", () => {
    expect(parseDecision('Sure — {"approve": true, "reason": "fine"} hope that helps'))
      .toEqual({ approved: true, reason: "fine" });
  });

  test("supplies a reason when the model omits one", () => {
    expect(parseDecision('{"approve": true}')?.reason).toBeTruthy();
  });

  /* Anything that is not a well-formed boolean verdict is not a yes. */
  test.each(["", "yes", "{}", '{"approve": 1}', '{"approve": "true"}', "{approve: true}"])(
    "rejects %p",
    (text) => {
      expect(parseDecision(text)).toBeNull();
    },
  );
});
