import { expect, test, describe, beforeEach } from "bun:test";
import { db, schema } from "../db";
import { resetDatabase } from "../test/harness";
import { whereWeAre } from "./runner";
import type { Actor } from "../lib/auth";

/* Threading the project through to the tools makes them default correctly,
 * but says nothing to the model itself — which then asks "which project?" on
 * a page that is visibly about one. This is the sentence that closes that
 * gap, so it is worth its own coverage: the panel reading as if it belongs to
 * the project it is embedded in depends entirely on it. */

const alice: Actor = { id: "alice", email: "a@x.com", instanceRole: "user" };

beforeEach(async () => {
  resetDatabase();
  const now = Date.now();

  await db.insert(schema.users).values([
    { id: "alice", email: "a@x.com", passwordHash: "x", instanceRole: "user", status: "active", createdAt: now },
    { id: "bob", email: "b@x.com", passwordHash: "x", instanceRole: "instance_admin", status: "active", createdAt: now },
  ]);

  await db.insert(schema.projects).values([
    { id: "p-alice", ownerUserId: "alice", ownerOrgId: null, name: "AI Novel", slug: "ai-novel", repoUrl: null, branch: null, instructions: null, defaultModelId: null, spendCapUsd: null, createdAt: now },
    { id: "p-bob", ownerUserId: "bob", ownerOrgId: null, name: "Bob Secret", slug: "bob-secret", repoUrl: null, branch: null, instructions: null, defaultModelId: null, spendCapUsd: null, createdAt: now },
  ]);
});

describe("telling the model which project it is on", () => {
  test("names the project, so it does not ask which one", async () => {
    const out = await whereWeAre(alice, { projectId: "p-alice" });
    expect(out).toContain("AI Novel");
    expect(out).toContain("p-alice");
    expect(out).toContain("rather than asking the user which project");
  });

  /* The global screen genuinely is about everything, and claiming otherwise
     would make it refuse to look across projects. */
  test("says nothing at all when there is no project", async () => {
    expect(await whereWeAre(alice, {})).toBe("");
  });

  test("says nothing about a project the actor cannot see", async () => {
    expect(await whereWeAre(alice, { projectId: "p-bob" })).toBe("");
  });

  test("says nothing about a project that does not exist", async () => {
    expect(await whereWeAre(alice, { projectId: "nope" })).toBe("");
  });

  /* A pin the user set by hand only survives if the model is told to leave
     create_task's own model choice empty — otherwise it picks one and the
     chips silently stop meaning anything. */
  test("explains a pinned model, and how to honour it", async () => {
    const out = await whereWeAre(alice, { projectId: "p-alice", pinnedModel: "claude-sonnet-4-5" });
    expect(out).toContain("claude-sonnet-4-5");
    expect(out).toContain("leave create_task's model and modelList unset");
  });

  test("mentions a pinned machine without naming its id", async () => {
    const out = await whereWeAre(alice, { projectId: "p-alice", pinnedNodeId: "node-42" });
    expect(out).toContain("a specific machine");
    expect(out).not.toContain("node-42");
  });

  test("says nothing about pins when none are set", async () => {
    const out = await whereWeAre(alice, { projectId: "p-alice" });
    expect(out).not.toContain("pinned");
  });
});
