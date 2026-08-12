import { expect, test, describe, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { newId } from "@maestro/protocol";
import { db, schema } from "../db";
import { resetDatabase } from "../test/harness";
import { encryptSecret } from "../lib/crypto";
import {
  createEnrollmentToken,
  handleNodeMessage,
  resetRegistry,
  type SocketSession,
} from "../nodes/registry";
import { runConductorTool, conductorToolDefinitions, CONDUCTOR_SCHEMAS } from "./tools";
import type { Actor } from "../lib/auth";

const alice: Actor = { id: "alice", email: "a@x.com", instanceRole: "user" };
const bob: Actor = { id: "bob", email: "b@x.com", instanceRole: "instance_admin" };

/* A socket that just records what the server sent it — same shape the node
   registry's own tests use, reused here so a task can actually be dispatched
   to a real (fake) online node rather than stubbing planRoute. It also plays
   the node's side of the one handshake the server-side run loop actually
   waits on: collectSkills() blocks up to 5s for a "skills.found" report, and
   without one every dispatch test would eat that full timeout waiting for a
   reply that never comes. Replying (with nothing) shortly after task.assign
   keeps these tests fast without weakening what they're checking. */
function fakeSocket(session: SocketSession) {
  const sent: unknown[] = [];
  const self = {
    send: (data: string) => {
      const message = JSON.parse(data);
      sent.push(message);
      if (message.type === "task.assign") {
        setTimeout(() => {
          void handleNodeMessage(
            session,
            self,
            JSON.stringify({
              type: "skills.found",
              id: newId(),
              taskId: message.taskId,
              skills: [],
              problems: [],
            }),
          );
        }, 30);
      }
    },
    close: () => {},
    sent,
  };
  return self;
}

async function enrollNode(ownerUserId: string) {
  const token = await createEnrollmentToken({ ownerUserId }, null);
  const session: SocketSession = {};
  const socket = fakeSocket(session);
  await handleNodeMessage(
    session,
    socket,
    JSON.stringify({
      type: "node.enroll",
      id: newId(),
      enrollmentToken: token,
      node: {
        name: "test-node",
        os: "linux",
        arch: "x64",
        version: "0.1.0",
        maxConcurrentTasks: 2,
        capabilities: ["bash"],
        workspaces: [],
      },
    }),
  );
}

async function giveProvider(ownerUserId: string, modelIds: string[]) {
  const providerId = crypto.randomUUID();
  await db.insert(schema.providerConnections).values({
    id: providerId,
    ownerUserId,
    ownerOrgId: null,
    name: `${ownerUserId}-provider`,
    kind: "openai_compatible",
    /* A port nothing listens on, not a DNS name — the connection is refused
       immediately rather than hanging on a lookup, so the background task
       this triggers fails fast and predictably in a test. */
    baseUrl: "http://127.0.0.1:1/v1",
    encryptedKey: encryptSecret(`key-for-${ownerUserId}`),
    enabled: true,
    lastHealthAt: null,
    lastHealthOk: null,
    createdAt: Date.now(),
  });
  for (const modelId of modelIds) {
    await db.insert(schema.models).values({
      id: crypto.randomUUID(),
      providerId,
      modelId,
      tier: "standard",
      contextWindow: 200_000,
      priceInPerMTok: 3,
      priceOutPerMTok: 15,
      enabled: true,
    });
  }
}

/* create_task's background run (createTask -> void startTask) is genuinely
   asynchronous — it fails against the fake provider connection above a beat
   after the tool call returns. Without waiting for it to actually finish, the
   next test's resetDatabase() can run first, and the failing run's own
   attempt to record its "failed" status then violates a foreign key against a
   task row that is already gone. */
async function settle(taskId: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .limit(1);
    if (row && !["queued", "assigned", "running"].includes(row.status)) return;
    await new Promise((r) => setTimeout(r, 15));
  }
}

beforeEach(async () => {
  resetDatabase();
  resetRegistry();
  const now = Date.now();

  await db.insert(schema.users).values([
    { id: "alice", email: "a@x.com", passwordHash: "x", instanceRole: "user", status: "active", createdAt: now },
    { id: "bob", email: "b@x.com", passwordHash: "x", instanceRole: "instance_admin", status: "active", createdAt: now },
  ]);

  await db.insert(schema.projects).values([
    { id: "p-alice", ownerUserId: "alice", ownerOrgId: null, name: "Alice API", slug: "alice-api", repoUrl: null, branch: null, instructions: null, defaultModelId: null, spendCapUsd: null, createdAt: now },
    { id: "p-bob", ownerUserId: "bob", ownerOrgId: null, name: "Bob Secret", slug: "bob-secret", repoUrl: null, branch: null, instructions: null, defaultModelId: null, spendCapUsd: null, createdAt: now },
  ]);

  await db.insert(schema.tasks).values([
    { id: "t-alice-run", projectId: "p-alice", workspaceId: null, nodeId: null, actorUserId: "alice", title: "Fix the flaky auth test", prompt: "the auth test is flaky", status: "running", model: "m", costUsd: 0.5, inputTokens: 100, outputTokens: 20, error: null, startedAt: now - 60_000, endedAt: null, createdAt: now },
    { id: "t-alice-wait", projectId: "p-alice", workspaceId: null, nodeId: null, actorUserId: "alice", title: "Rotate staging credentials", prompt: "rotate creds", status: "awaiting_approval", model: "m", costUsd: 0, inputTokens: 50, outputTokens: 5, error: null, startedAt: now - 600_000, endedAt: null, createdAt: now },
    { id: "t-bob", projectId: "p-bob", workspaceId: null, nodeId: null, actorUserId: "bob", title: "Bob private work", prompt: "secret thing", status: "running", model: "m", costUsd: 9, inputTokens: 1, outputTokens: 1, error: null, startedAt: now, endedAt: null, createdAt: now },
  ]);
});

describe("scoping", () => {
  /* The Conductor acts AS the user and is never elevated. Asking it about
     someone else's work must return nothing, not a refusal that confirms the
     work exists. */
  test("only lists the caller's projects", async () => {
    const out = await runConductorTool(alice, "list_projects", {});
    expect(out).toContain("Alice API");
    expect(out).not.toContain("Bob Secret");
  });

  test("only lists the caller's tasks", async () => {
    const out = await runConductorTool(alice, "list_tasks", { status: "all" });
    expect(out).toContain("Fix the flaky auth test");
    expect(out).not.toContain("Bob private work");
  });

  test("an instance admin gets no extra reach", async () => {
    const out = await runConductorTool(bob, "list_tasks", { status: "all" });
    expect(out).toContain("Bob private work");
    expect(out).not.toContain("Fix the flaky auth test");
  });

  /* "No such task" for both cases, so the tool cannot be used to probe for
     other people's task ids. */
  test("another user's task is indistinguishable from a missing one", async () => {
    const foreign = await runConductorTool(alice, "get_task", { taskId: "t-bob" });
    const missing = await runConductorTool(alice, "get_task", { taskId: "does-not-exist" });
    expect(foreign).toBe(missing);
    expect(foreign).toBe("No such task.");
  });

  test("search does not cross owners", async () => {
    const out = await runConductorTool(alice, "search_history", { query: "secret" });
    expect(out).not.toContain("Bob private work");
  });

  test("spend does not include another owner's cost", async () => {
    const out = await runConductorTool(alice, "spend_report", {});
    expect(out).not.toContain("9.0000");
    expect(out).toContain("Alice API");
  });
});

describe("what it reports", () => {
  test("needs_you finds exactly what is blocked on a human", async () => {
    const out = await runConductorTool(alice, "list_tasks", { status: "needs_you" });
    expect(out).toContain("Rotate staging credentials");
    expect(out).not.toContain("Fix the flaky auth test");
  });

  test("task ids are included so the interface can link them", async () => {
    const out = await runConductorTool(alice, "list_tasks", { status: "all" });
    expect(out).toContain("[t-alice-run]");
  });

  test("an empty result says so rather than returning nothing", async () => {
    const out = await runConductorTool(alice, "search_history", { query: "zzzzz" });
    expect(out).toContain("Nothing matches");
  });

  test("fleet_status reports honestly with no machines", async () => {
    expect(await runConductorTool(alice, "fleet_status", {})).toContain("No machines");
  });

  /* This provider publishes no prices, so a zero must not be reported as
     "free" — the model needs to be told the difference. */
  test("spend explains a zero rather than implying it was free", async () => {
    await db.update(schema.tasks).set({ costUsd: 0 });
    const out = await runConductorTool(alice, "spend_report", {});
    expect(out).toContain("does not publish prices");
  });
});

describe("tool surface", () => {
  /* Dispatching is now in scope; steering, cancelling and approving a task
     mid-run still are not — those are task-control tools, not the "assign
     and validate" scope this feature added. */
  test("can dispatch and see model lists, but still cannot control a running task", () => {
    const names = conductorToolDefinitions().map((t) => t.name);
    expect(names).toContain("create_task");
    expect(names).toContain("list_model_lists");
    for (const forbidden of ["cancel_task", "steer_task", "decide_approval"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  test("every tool has a schema and a description", () => {
    for (const tool of conductorToolDefinitions()) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.parameters).toBeDefined();
      expect(Object.keys(CONDUCTOR_SCHEMAS)).toContain(tool.name);
    }
  });

  test("an unknown tool is a readable message, not a crash", async () => {
    const out = await runConductorTool(alice, "delete_everything", {});
    expect(out).toContain("no tool called");
  });

  test("bad arguments come back readable", async () => {
    const out = await runConductorTool(alice, "get_task", { wrong: true });
    expect(out).toContain("Invalid arguments");
  });
});

describe("list_model_lists", () => {
  test("shows the name and the description it was written for", async () => {
    await db.insert(schema.modelLists).values({
      id: "l1", ownerUserId: "alice", ownerOrgId: null,
      name: "difficult programming", description: "Hard refactors and tricky bugs.",
      createdAt: Date.now(),
    });
    const out = await runConductorTool(alice, "list_model_lists", {});
    expect(out).toBe("difficult programming — Hard refactors and tricky bugs.");
  });

  test("does not leak another owner's lists", async () => {
    await db.insert(schema.modelLists).values({
      id: "l2", ownerUserId: "bob", ownerOrgId: null,
      name: "bob's list", description: null, createdAt: Date.now(),
    });
    const out = await runConductorTool(alice, "list_model_lists", {});
    expect(out).not.toContain("bob's list");
  });

  test("says plainly when there are none", async () => {
    const out = await runConductorTool(alice, "list_model_lists", {});
    expect(out).toContain("No model lists set up yet.");
  });
});

describe("create_task", () => {
  test("dispatches to a real online node and returns a linkable id", async () => {
    await enrollNode("alice");
    await giveProvider("alice", ["worker-model"]);

    const out = await runConductorTool(
      alice,
      "create_task",
      { prompt: "write a hello world script", model: "worker-model" },
      { projectId: "p-alice" },
    );

    expect(out).toStartWith("Dispatched [");
    expect(out).toContain("worker-model");

    const taskId = out.match(/\[([^\]]+)\]/)?.[1];
    const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId!));
    expect(rows).toHaveLength(1);
    expect(rows[0].modelPinned).toBe(true);

    /* Dispatch is what this test checks; the fake provider connection has
       nothing real behind it, so the background run is stopped rather than
       left to fail against a nonexistent host into the next test's setup. */
    await settle(taskId!);
  });

  /* Validation depends on being able to read back a task it just dispatched —
     regression coverage for get_task's ownership check, not just create_task. */
  test("a dispatched task is immediately readable back via get_task", async () => {
    await enrollNode("alice");
    await giveProvider("alice", ["worker-model"]);

    const dispatch = await runConductorTool(
      alice,
      "create_task",
      { prompt: "write a hello world script", model: "worker-model" },
      { projectId: "p-alice" },
    );
    const taskId = dispatch.match(/\[([^\]]+)\]/)?.[1]!;

    const out = await runConductorTool(alice, "get_task", { taskId });
    expect(out).not.toBe("No such task.");
    expect(out).toContain("worker-model");

    await settle(taskId);
  });

  test("picks the first available model from a named modelList", async () => {
    await enrollNode("alice");
    await giveProvider("alice", ["down-model", "backup-model"]);
    await db.update(schema.models).set({ probeOk: false }).where(eq(schema.models.modelId, "down-model"));

    await db.insert(schema.modelLists).values({
      id: "l3", ownerUserId: "alice", ownerOrgId: null, name: "normal programming", description: null, createdAt: Date.now(),
    });
    await db.insert(schema.modelListEntries).values([
      { id: "e1", listId: "l3", modelId: "down-model", groupId: null, position: 0, createdAt: Date.now() },
      { id: "e2", listId: "l3", modelId: "backup-model", groupId: null, position: 1, createdAt: Date.now() },
    ]);

    const out = await runConductorTool(
      alice,
      "create_task",
      { prompt: "do the thing", modelList: "normal programming" },
      { projectId: "p-alice" },
    );
    expect(out).toContain("backup-model");
    await settle(out.match(/\[([^\]]+)\]/)![1]);
  });

  test("a modelList with nothing available is a clear error, no task created", async () => {
    await enrollNode("alice");
    await giveProvider("alice", ["only-model"]);
    await db.update(schema.models).set({ probeOk: false }).where(eq(schema.models.modelId, "only-model"));
    await db.insert(schema.modelLists).values({
      id: "l4", ownerUserId: "alice", ownerOrgId: null, name: "normal programming", description: null, createdAt: Date.now(),
    });
    await db.insert(schema.modelListEntries).values({
      id: "e3", listId: "l4", modelId: "only-model", groupId: null, position: 0, createdAt: Date.now(),
    });

    const before = await db.select().from(schema.tasks);
    const out = await runConductorTool(
      alice,
      "create_task",
      { prompt: "do the thing", modelList: "normal programming" },
      { projectId: "p-alice" },
    );
    expect(out).toContain("is currently available");
    const after = await db.select().from(schema.tasks);
    expect(after.length).toBe(before.length);
  });

  test("naming both a model and a modelList is refused before anything runs", async () => {
    const out = await runConductorTool(
      alice,
      "create_task",
      { prompt: "do the thing", model: "a", modelList: "b" },
      { projectId: "p-alice" },
    );
    expect(out).toContain("Invalid arguments");
  });

  test("no project in the args or the context is a readable error", async () => {
    const out = await runConductorTool(alice, "create_task", { prompt: "do the thing" }, {});
    expect(out).toContain("No project to dispatch to");
  });

  test("cannot dispatch into another owner's project, and does not leak its list names", async () => {
    await db.insert(schema.modelLists).values({
      id: "l5", ownerUserId: "bob", ownerOrgId: null, name: "bob's secret list", description: null, createdAt: Date.now(),
    });
    const out = await runConductorTool(
      alice,
      "create_task",
      { prompt: "do the thing", modelList: "bob's secret list" },
      { projectId: "p-bob" },
    );
    expect(out).toContain("isn't yours");
    expect(out).not.toContain("bob's secret list");
  });

  /* createTask() throws (no node, no model, at capacity) rather than
     returning a result — the tool must never let that escape as an
     exception the turn loop cannot handle, same as every other tool here. */
  test("a routing failure (no node online) surfaces as text, not a thrown error", async () => {
    await giveProvider("alice", ["worker-model"]);

    const out = await runConductorTool(
      alice,
      "create_task",
      { prompt: "do the thing", model: "worker-model" },
      { projectId: "p-alice" },
    );
    expect(out.toLowerCase()).toContain("node");
  });

  test("falls back to the project's default routing when no model or list is given", async () => {
    await enrollNode("alice");
    await giveProvider("alice", ["only-model"]);

    const out = await runConductorTool(
      alice,
      "create_task",
      { prompt: "do the thing" },
      { projectId: "p-alice" },
    );
    expect(out).toStartWith("Dispatched [");
    await settle(out.match(/\[([^\]]+)\]/)![1]);
  });
});
