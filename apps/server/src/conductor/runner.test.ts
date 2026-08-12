import { expect, test, describe, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { resetDatabase } from "../test/harness";
import { encryptSecret } from "../lib/crypto";
import { conductorProvider, whereWeAre, CONDUCTOR_LIST_NAME } from "./runner";
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

  test("names a pinned profile, since that is what the chip now shows", async () => {
    const out = await whereWeAre(alice, { projectId: "p-alice", pinnedModelList: "difficult programming" });
    expect(out).toContain('"difficult programming" profile');
  });
});

/* Coordinating is its own job with its own list. Before this the Conductor
 * ran on whatever the gateway defaulted to — unpredictable, and the one model
 * choice on the page nobody could influence. */
describe("which model the Conductor itself runs on", () => {
  async function giveProvider(
    owner: { ownerUserId?: string | null; ownerOrgId?: string | null },
    modelIds: string[],
  ) {
    const providerId = crypto.randomUUID();
    await db.insert(schema.providerConnections).values({
      id: providerId,
      ownerUserId: owner.ownerUserId ?? null,
      ownerOrgId: owner.ownerOrgId ?? null,
      name: "provider",
      kind: "openai_compatible",
      baseUrl: "https://provider.test/v1",
      encryptedKey: encryptSecret("k"),
      enabled: true,
      lastHealthAt: null,
      lastHealthOk: null,
      createdAt: Date.now(),
    });
    for (const modelId of modelIds) {
      await db.insert(schema.models).values({
        id: crypto.randomUUID(), providerId, modelId, tier: "standard",
        contextWindow: 200_000, priceInPerMTok: 3, priceOutPerMTok: 15, enabled: true,
      });
    }
  }

  async function giveList(
    owner: { ownerUserId?: string | null; ownerOrgId?: string | null },
    name: string,
    modelIds: string[],
  ) {
    const listId = crypto.randomUUID();
    await db.insert(schema.modelLists).values({
      id: listId,
      ownerUserId: owner.ownerUserId ?? null,
      ownerOrgId: owner.ownerOrgId ?? null,
      name,
      description: null,
      createdAt: Date.now(),
    });
    for (const [position, modelId] of modelIds.entries()) {
      await db.insert(schema.modelListEntries).values({
        id: crypto.randomUUID(), listId, modelId, groupId: null, position, createdAt: Date.now(),
      });
    }
  }

  test("uses the manager/conductor profile's first usable model", async () => {
    await giveProvider({ ownerUserId: "alice" }, ["coordinator", "something-else"]);
    await giveList({ ownerUserId: "alice" }, CONDUCTOR_LIST_NAME, ["coordinator"]);

    expect((await conductorProvider(alice, {})).model).toBe("coordinator");
  });

  test("skips an entry that is not currently usable", async () => {
    await giveProvider({ ownerUserId: "alice" }, ["down", "backup"]);
    await db.update(schema.models).set({ probeOk: false }).where(eq(schema.models.modelId, "down"));
    await giveList({ ownerUserId: "alice" }, CONDUCTOR_LIST_NAME, ["down", "backup"]);

    expect((await conductorProvider(alice, {})).model).toBe("backup");
  });

  /* A missing or dead profile must not take the Conductor offline: without it
     the user cannot even ask what went wrong. */
  test("falls back to the default when no such profile exists", async () => {
    await giveProvider({ ownerUserId: "alice" }, ["only-model"]);
    expect((await conductorProvider(alice, {})).model).toBe("only-model");
  });

  test("falls back to the default when nothing in the profile is available", async () => {
    await giveProvider({ ownerUserId: "alice" }, ["only-model"]);
    await giveList({ ownerUserId: "alice" }, CONDUCTOR_LIST_NAME, ["not-connected"]);

    expect((await conductorProvider(alice, {})).model).toBe("only-model");
  });

  test("an explicit override beats the profile", async () => {
    await giveProvider({ ownerUserId: "alice" }, ["coordinator", "forced"]);
    await giveList({ ownerUserId: "alice" }, CONDUCTOR_LIST_NAME, ["coordinator"]);

    const provider = await conductorProvider(alice, { conductorModel: "forced" });
    expect(provider.model).toBe("forced");
  });

  test("an override naming something unreachable falls back rather than failing", async () => {
    await giveProvider({ ownerUserId: "alice" }, ["coordinator"]);
    await giveList({ ownerUserId: "alice" }, CONDUCTOR_LIST_NAME, ["coordinator"]);

    const provider = await conductorProvider(alice, { conductorModel: "nonexistent" });
    expect(provider.model).toBe("coordinator");
  });

  /* An org project's Conductor should run on the org's connections and its
     lists, the same rule dispatched tasks already follow — otherwise the org's
     coordination quietly bills the member's personal account. */
  test("an org project's Conductor uses the org's profile, not the actor's", async () => {
    const now = Date.now();
    await db.insert(schema.organizations).values({
      id: "org-1", name: "Acme", slug: "acme", require2fa: false, createdAt: now,
    });
    await db.insert(schema.memberships).values({
      id: "m-1", userId: "alice", orgId: "org-1", role: "admin", createdAt: now,
    });
    await db.insert(schema.projects).values({
      id: "p-org", ownerUserId: null, ownerOrgId: "org-1", name: "Org Novel", slug: "org-novel",
      repoUrl: null, branch: null, instructions: null, defaultModelId: null, spendCapUsd: null, createdAt: now,
    });

    await giveProvider({ ownerUserId: "alice" }, ["personal-model"]);
    await giveList({ ownerUserId: "alice" }, CONDUCTOR_LIST_NAME, ["personal-model"]);
    await giveProvider({ ownerOrgId: "org-1" }, ["org-model"]);
    await giveList({ ownerOrgId: "org-1" }, CONDUCTOR_LIST_NAME, ["org-model"]);

    const provider = await conductorProvider(alice, { projectId: "p-org" });
    expect(provider.model).toBe("org-model");
  });

  test("a project the actor cannot reach falls back to their own scope", async () => {
    await giveProvider({ ownerUserId: "alice" }, ["mine"]);
    await giveList({ ownerUserId: "alice" }, CONDUCTOR_LIST_NAME, ["mine"]);

    const provider = await conductorProvider(alice, { projectId: "p-bob" });
    expect(provider.model).toBe("mine");
  });
});
