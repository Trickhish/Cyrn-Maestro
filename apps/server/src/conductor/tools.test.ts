import { expect, test, describe, beforeEach } from "bun:test";
import { db, schema } from "../db";
import { resetDatabase } from "../test/harness";
import { runConductorTool, conductorToolDefinitions, CONDUCTOR_SCHEMAS } from "./tools";
import type { Actor } from "../lib/auth";

const alice: Actor = { id: "alice", email: "a@x.com", instanceRole: "user" };
const bob: Actor = { id: "bob", email: "b@x.com", instanceRole: "instance_admin" };

beforeEach(async () => {
  resetDatabase();
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
  test("is read-only: nothing here can start, stop or approve", () => {
    const names = conductorToolDefinitions().map((t) => t.name);
    for (const forbidden of ["create_task", "cancel_task", "steer_task", "decide_approval"]) {
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
