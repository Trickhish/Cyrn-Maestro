import { expect, test, describe, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { app } from "../app";
import { db, schema } from "../db";
import { resetDatabase, jsonPost as json, cookieFrom, body } from "../test/harness";
import { encryptSecret } from "../lib/crypto";
import { inferTier } from "../router/weigh";

const PASSWORD = "a-long-enough-password";
let cookie: string;
let providerId: string;

const withCookie = (c: string, init: RequestInit = {}) => ({
  ...init,
  headers: { ...(init.headers ?? {}), cookie: c },
});

async function seedModels(models: Array<{ id: string; tier?: string; source?: string }>) {
  for (const model of models) {
    await db.insert(schema.models).values({
      id: crypto.randomUUID(),
      providerId,
      modelId: model.id,
      tier: (model.tier ?? inferTier(model.id)) as never,
      tierSource: (model.source ?? "inferred") as never,
      contextWindow: null,
      priceInPerMTok: null,
      priceOutPerMTok: null,
      enabled: true,
      needsReasoningEffort: false,
    });
  }
}

const tierOf = async (modelId: string) =>
  (
    await db
      .select({ tier: schema.models.tier, source: schema.models.tierSource })
      .from(schema.models)
      .where(and(eq(schema.models.providerId, providerId), eq(schema.models.modelId, modelId)))
      .limit(1)
  )[0];

beforeEach(async () => {
  resetDatabase();
  cookie = cookieFrom(
    await app.request("/api/auth/register", json({ email: "owner@x.com", password: PASSWORD })),
  );

  const [user] = await db.select().from(schema.users).limit(1);
  providerId = crypto.randomUUID();
  await db.insert(schema.providerConnections).values({
    id: providerId,
    ownerUserId: user.id,
    ownerOrgId: null,
    name: "Test",
    kind: "openai_compatible",
    baseUrl: "https://provider.test/v1",
    encryptedKey: encryptSecret("k"),
    enabled: true,
    lastHealthAt: null,
    lastHealthOk: null,
    createdAt: Date.now(),
  });
});

describe("model tiers", () => {
  test("are classified automatically from the model name", async () => {
    await seedModels([{ id: "claude-opus-5" }, { id: "claude-haiku-4-5" }, { id: "claude-sonnet-5" }]);

    expect((await tierOf("claude-opus-5")).tier).toBe("heavy");
    expect((await tierOf("claude-haiku-4-5")).tier).toBe("light");
    expect((await tierOf("claude-sonnet-5")).tier).toBe("standard");
  });

  test("an admin can correct one, and it is marked as set by hand", async () => {
    await seedModels([{ id: "gpt-oss-120b-medium" }]);

    const res = await app.request(
      `/api/providers/${providerId}/models/gpt-oss-120b-medium`,
      withCookie(cookie, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ tier: "heavy" }),
      }),
    );
    expect(res.status).toBe(200);

    const row = await tierOf("gpt-oss-120b-medium");
    expect(row.tier).toBe("heavy");
    expect(row.source).toBe("manual");
  });

  test("the correction is visible in the provider list", async () => {
    await seedModels([{ id: "claude-sonnet-5", tier: "heavy", source: "manual" }]);

    const providers = (await body(await app.request("/api/providers", withCookie(cookie)))).providers;
    const model = providers[0].models.find((m: { modelId: string }) => m.modelId === "claude-sonnet-5");

    expect(model.tier).toBe("heavy");
    expect(model.tierSource).toBe("manual");
  });

  test("resetting puts everything back to the automatic guess", async () => {
    await seedModels([
      { id: "claude-opus-5", tier: "light", source: "manual" },
      { id: "claude-haiku-4-5", tier: "heavy", source: "manual" },
    ]);

    const res = await app.request(
      `/api/providers/${providerId}/models/reclassify`,
      withCookie(cookie, { method: "POST" }),
    );
    expect((await body(res)).reclassified).toBe(2);

    expect((await tierOf("claude-opus-5")).tier).toBe("heavy");
    expect((await tierOf("claude-haiku-4-5")).tier).toBe("light");
    expect((await tierOf("claude-opus-5")).source).toBe("inferred");
  });

  test("changing the tier is recorded in the audit log", async () => {
    await seedModels([{ id: "claude-sonnet-5" }]);
    await app.request(
      `/api/providers/${providerId}/models/claude-sonnet-5`,
      withCookie(cookie, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ tier: "heavy" }),
      }),
    );

    const entries = await db.select().from(schema.auditLog);
    expect(entries.some((e) => e.action === "model.tier_changed")).toBe(true);
  });

  test("another user cannot change your model tiers", async () => {
    await seedModels([{ id: "claude-sonnet-5" }]);

    await db.insert(schema.users).values({
      id: "stranger",
      email: "stranger@x.com",
      passwordHash: await Bun.password.hash(PASSWORD, { algorithm: "argon2id" }),
      instanceRole: "user",
      status: "active",
      createdAt: Date.now(),
    });
    const strangerCookie = cookieFrom(
      await app.request("/api/auth/login", json({ email: "stranger@x.com", password: PASSWORD })),
    );

    const res = await app.request(`/api/providers/${providerId}/models/claude-sonnet-5`, {
      method: "PATCH",
      headers: { cookie: strangerCookie, "content-type": "application/json" },
      body: JSON.stringify({ tier: "heavy" }),
    });
    expect(res.status).toBe(404);
  });

  test("an unknown tier is refused", async () => {
    await seedModels([{ id: "claude-sonnet-5" }]);
    const res = await app.request(`/api/providers/${providerId}/models/claude-sonnet-5`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ tier: "enormous" }),
    });
    expect(res.status).toBe(400);
  });
});
