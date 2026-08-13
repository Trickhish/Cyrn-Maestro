import { expect, test, describe, beforeAll, beforeEach } from "bun:test";
import { db, schema } from "../db";
import { encryptSecret } from "../lib/crypto";
import { eq } from "drizzle-orm";
import {
  resolveProvider,
  resolveModelList,
  modelListMembers,
  toolDefinitions,
  estimateCost,
  NoProviderError,
} from "./gateway";
import { resetDatabase } from "../test/harness";
import { TOOL_NAMES } from "@maestro/protocol";

beforeAll(resetDatabase);

const ALICE = "alice-id";
const BOB = "bob-id";
const ORG = "org-acme";

async function seedUsers() {
  await db.insert(schema.users).values([
    { id: ALICE, email: "alice@x.com", passwordHash: "x", instanceRole: "user", status: "active", createdAt: Date.now() },
    { id: BOB, email: "bob@x.com", passwordHash: "x", instanceRole: "user", status: "active", createdAt: Date.now() },
  ]);
}

async function seedOrg() {
  await db.insert(schema.organizations).values({
    id: ORG, name: "Acme", slug: "acme", require2fa: false, createdAt: Date.now(),
  });
}

/* A connection owned by the organization itself, not by any member. */
async function giveOrgProvider(modelIds: string[]) {
  const providerId = crypto.randomUUID();
  await db.insert(schema.providerConnections).values({
    id: providerId,
    ownerUserId: null,
    ownerOrgId: ORG,
    name: "org-provider",
    kind: "openai_compatible",
    baseUrl: "https://provider.test/v1",
    encryptedKey: encryptSecret("org-key"),
    enabled: true,
    lastHealthAt: null,
    lastHealthOk: null,
    createdAt: Date.now(),
  });
  for (const modelId of modelIds) {
    await db.insert(schema.models).values({
      id: crypto.randomUUID(), providerId, modelId, tier: "standard",
      contextWindow: 200_000, priceInPerMTok: 3, priceOutPerMTok: 15, enabled: true,
      needsReasoningEffort: false,
    });
  }
  return providerId;
}

async function giveProvider(userId: string, modelIds: string[], enabled = true) {
  const providerId = crypto.randomUUID();
  await db.insert(schema.providerConnections).values({
    id: providerId,
    ownerUserId: userId,
    ownerOrgId: null,
    name: `${userId}-provider`,
    kind: "openai_compatible",
    baseUrl: "https://provider.test/v1",
    encryptedKey: encryptSecret(`key-for-${userId}`),
    enabled,
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
  return providerId;
}

beforeEach(async () => {
  resetDatabase();
  await seedUsers();
  await seedOrg();
});

describe("whose credentials a task uses", () => {
  test("resolves the owner's connection", async () => {
    await giveProvider(ALICE, ["model-a"]);
    const resolved = await resolveProvider({ ownerUserId: ALICE });
    expect(resolved.model).toBe("model-a");
  });

  /* The rule the README states once and this enforces: a task uses the
     project owner's credentials and nothing else. Bob having a working key is
     irrelevant to a project Alice owns. */
  test("never falls back to another user's connection", async () => {
    await giveProvider(BOB, ["model-b"]);
    await expect(resolveProvider({ ownerUserId: ALICE })).rejects.toBeInstanceOf(NoProviderError);
  });

  test("fails loudly when the owner has no provider at all", async () => {
    await expect(resolveProvider({ ownerUserId: ALICE })).rejects.toThrow(
      /No provider is connected/,
    );
  });

  test("ignores a disabled connection", async () => {
    await giveProvider(ALICE, ["model-a"], false);
    await expect(resolveProvider({ ownerUserId: ALICE })).rejects.toBeInstanceOf(NoProviderError);
  });

  /* The rule in the other direction, and the one that costs real money if it
     is wrong: an org project must never quietly spend a member's personal
     credit, even when that member has a perfectly good key attached. */
  test("an org project never falls back to a member's personal connection", async () => {
    await giveProvider(ALICE, ["model-a"]);
    await expect(resolveProvider({ ownerOrgId: ORG })).rejects.toThrow(
      /organization has no provider/,
    );
  });

  test("an org project uses the org's own connection", async () => {
    await giveOrgProvider(["org-model"]);
    const resolved = await resolveProvider({ ownerOrgId: ORG });
    expect(resolved.model).toBe("org-model");
  });

  test("a personal project never reaches for an org connection", async () => {
    await giveOrgProvider(["org-model"]);
    await expect(resolveProvider({ ownerUserId: ALICE })).rejects.toThrow(
      /No provider is connected/,
    );
  });

  /* The error has to say what to do about it. "No provider" with no next step
     is how a member ends up filing a bug against the wrong thing. */
  test("the org error points at who can fix it", async () => {
    await expect(resolveProvider({ ownerOrgId: ORG })).rejects.toThrow(/organization admin/);
  });

  test("an unowned project has no credentials", async () => {
    await expect(resolveProvider({ ownerUserId: null })).rejects.toBeInstanceOf(NoProviderError);
  });
});

describe("model selection", () => {
  test("honours a pinned model", async () => {
    await giveProvider(ALICE, ["cheap", "expensive"]);
    const resolved = await resolveProvider({ ownerUserId: ALICE }, "expensive");
    expect(resolved.model).toBe("expensive");
  });

  /* Silently substituting a different model would bill the user for a run they
     did not ask for and produce results they cannot explain. */
  test("refuses rather than substituting when the pinned model is absent", async () => {
    await giveProvider(ALICE, ["cheap"]);
    await expect(resolveProvider({ ownerUserId: ALICE }, "nonexistent")).rejects.toThrow(
      /No connected provider offers/,
    );
  });
});

/* This is the "tried one by one until one is available" behaviour lists were
   built for — resolveModelList is the first thing that actually walks them. */
describe("resolving a model list", () => {
  async function makeList(name: string, entries: Array<{ modelId?: string; groupId?: string }>) {
    const listId = crypto.randomUUID();
    await db.insert(schema.modelLists).values({
      id: listId, ownerUserId: ALICE, ownerOrgId: null, name, description: null, createdAt: Date.now(),
    });
    for (const [position, entry] of entries.entries()) {
      await db.insert(schema.modelListEntries).values({
        id: crypto.randomUUID(),
        listId,
        modelId: entry.modelId ?? null,
        groupId: entry.groupId ?? null,
        position,
        createdAt: Date.now(),
      });
    }
    return listId;
  }

  test("picks the first entry that is usable", async () => {
    await giveProvider(ALICE, ["cheap", "expensive"]);
    await makeList("normal programming", [{ modelId: "cheap" }, { modelId: "expensive" }]);

    const result = await resolveModelList({ ownerUserId: ALICE }, "normal programming");
    expect(result).toEqual({ modelId: "cheap" });
  });

  test("skips an entry whose model is failing its probe", async () => {
    await giveProvider(ALICE, ["down", "backup"]);
    await db.update(schema.models).set({ probeOk: false }).where(eq(schema.models.modelId, "down"));
    await makeList("normal programming", [{ modelId: "down" }, { modelId: "backup" }]);

    const result = await resolveModelList({ ownerUserId: ALICE }, "normal programming");
    expect(result).toEqual({ modelId: "backup" });
  });

  test("resolves a group entry to its first usable member", async () => {
    await giveProvider(ALICE, ["opus-vendor-a", "opus-vendor-b"]);
    await db.update(schema.models).set({ probeOk: false }).where(eq(schema.models.modelId, "opus-vendor-a"));

    const groupId = crypto.randomUUID();
    await db.insert(schema.modelGroups).values({
      id: groupId, ownerUserId: ALICE, ownerOrgId: null, name: "Claude Opus", createdAt: Date.now(),
    });
    await db.insert(schema.modelGroupMembers).values([
      { id: crypto.randomUUID(), groupId, modelId: "opus-vendor-a", position: 0, createdAt: Date.now() },
      { id: crypto.randomUUID(), groupId, modelId: "opus-vendor-b", position: 1, createdAt: Date.now() },
    ]);
    await makeList("difficult programming", [{ groupId }]);

    const result = await resolveModelList({ ownerUserId: ALICE }, "difficult programming");
    expect(result).toEqual({ modelId: "opus-vendor-b" });
  });

  test("names the owner's actual lists when the requested one does not exist", async () => {
    await makeList("decision maker", []);
    const result = await resolveModelList({ ownerUserId: ALICE }, "nonexistent");
    expect(result).toEqual({ error: expect.stringContaining("decision maker") });
  });

  test("is a clear error, not a crash, when nothing in the list is available", async () => {
    await giveProvider(ALICE, ["only-model"]);
    await db.update(schema.models).set({ probeOk: false }).where(eq(schema.models.modelId, "only-model"));
    await makeList("normal programming", [{ modelId: "only-model" }]);

    const result = await resolveModelList({ ownerUserId: ALICE }, "normal programming");
    expect(result).toEqual({ error: expect.stringContaining("normal programming") });
  });

  test("never resolves another user's list", async () => {
    await giveProvider(BOB, ["bobs-model"]);
    await makeList("normal programming", [{ modelId: "bobs-model" }]);

    const result = await resolveModelList({ ownerUserId: BOB }, "normal programming");
    expect(result).toEqual({ error: expect.stringContaining("No model list named") });
  });

  /* Resolving is what dispatch needs; the whole set is what a picker needs,
     and what constrains an override to the list the user actually chose. */
  describe("its full membership", () => {
    test("is every usable entry, in the list's own order", async () => {
      await giveProvider(ALICE, ["first", "second"]);
      await makeList("manager/conductor", [{ modelId: "first" }, { modelId: "second" }]);

      expect(await modelListMembers({ ownerUserId: ALICE }, "manager/conductor")).toEqual({
        models: ["first", "second"],
      });
    });

    test("leaves out entries that are not currently usable", async () => {
      await giveProvider(ALICE, ["up", "down"]);
      await db.update(schema.models).set({ probeOk: false }).where(eq(schema.models.modelId, "down"));
      await makeList("manager/conductor", [{ modelId: "down" }, { modelId: "up" }]);

      expect(await modelListMembers({ ownerUserId: ALICE }, "manager/conductor")).toEqual({
        models: ["up"],
      });
    });

    /* A group stands in for one model, so it contributes its own first usable
       member rather than every variant of the same thing. */
    test("a group contributes one model, not all of its members", async () => {
      await giveProvider(ALICE, ["opus-a", "opus-b", "plain"]);

      const groupId = crypto.randomUUID();
      await db.insert(schema.modelGroups).values({
        id: groupId, ownerUserId: ALICE, ownerOrgId: null, name: "Claude Opus", createdAt: Date.now(),
      });
      await db.insert(schema.modelGroupMembers).values([
        { id: crypto.randomUUID(), groupId, modelId: "opus-a", position: 0, createdAt: Date.now() },
        { id: crypto.randomUUID(), groupId, modelId: "opus-b", position: 1, createdAt: Date.now() },
      ]);
      await makeList("manager/conductor", [{ groupId }, { modelId: "plain" }]);

      expect(await modelListMembers({ ownerUserId: ALICE }, "manager/conductor")).toEqual({
        models: ["opus-a", "plain"],
      });
    });

    test("an empty result is not an error, so the caller can fall back", async () => {
      await giveProvider(ALICE, ["something"]);
      await makeList("manager/conductor", [{ modelId: "not-connected" }]);

      expect(await modelListMembers({ ownerUserId: ALICE }, "manager/conductor")).toEqual({
        models: [],
      });
    });

    test("a list that does not exist is still an error", async () => {
      const result = await modelListMembers({ ownerUserId: ALICE }, "nope");
      expect(result).toEqual({ error: expect.stringContaining("No model list named") });
    });
  });
});

describe("tool definitions handed to the model", () => {
  test("cover every tool a node implements", () => {
    expect(toolDefinitions().map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  test("carry a JSON Schema with the real parameters", () => {
    const bash = toolDefinitions().find((t) => t.name === "bash")!;
    const params = bash.parameters as { properties?: Record<string, unknown>; required?: string[] };
    expect(params.properties).toHaveProperty("command");
    expect(params.required).toContain("command");
  });

  test("every tool has a description, since that is what the model routes on", () => {
    for (const tool of toolDefinitions()) {
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });
});

describe("cost", () => {
  test("prices input and output separately", () => {
    const cost = estimateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      { priceInPerMTok: 3, priceOutPerMTok: 15 },
    );
    expect(cost).toBeCloseTo(18, 6);
  });

  /* An unpriced model must not render as "$0.00", which reads as free. */
  test("returns zero when the provider publishes no price", () => {
    expect(estimateCost({ inputTokens: 1000, outputTokens: 1000 }, {})).toBe(0);
  });
});
