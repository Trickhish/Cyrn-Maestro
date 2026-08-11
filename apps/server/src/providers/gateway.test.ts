import { expect, test, describe, beforeAll, beforeEach } from "bun:test";
import { db, schema } from "../db";
import { encryptSecret } from "../lib/crypto";
import { resolveProvider, toolDefinitions, estimateCost, NoProviderError } from "./gateway";
import { resetDatabase } from "../test/harness";
import { TOOL_NAMES } from "@maestro/protocol";

beforeAll(resetDatabase);

const ALICE = "alice-id";
const BOB = "bob-id";

async function seedUsers() {
  await db.insert(schema.users).values([
    { id: ALICE, email: "alice@x.com", passwordHash: "x", instanceRole: "user", status: "active", createdAt: Date.now() },
    { id: BOB, email: "bob@x.com", passwordHash: "x", instanceRole: "user", status: "active", createdAt: Date.now() },
  ]);
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

  test("org-owned projects fail closed until tenancy ships", async () => {
    await giveProvider(ALICE, ["model-a"]);
    await expect(
      resolveProvider({ ownerUserId: ALICE, ownerOrgId: "acme" }),
    ).rejects.toThrow(/not available yet/);
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
