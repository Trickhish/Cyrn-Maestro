import { expect, test, describe, beforeEach, afterEach } from "bun:test";
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

/* A proxy that re-publishes the same model under many routing aliases —
 * "auto/", "no-think/", vendor-specific renames — can dump hundreds of
 * variants into one provider's list. Disabling a model here is the one
 * control that reaches every place the router picks a model, independent
 * of anything the upstream proxy itself lets you turn off. */
describe("enabling and disabling a model", () => {
  const setEnabled = (modelId: string, enabled: boolean) =>
    app.request(`/api/providers/${providerId}/models/${encodeURIComponent(modelId)}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });

  const enabledOf = async (modelId: string) =>
    (
      await db
        .select({ enabled: schema.models.enabled })
        .from(schema.models)
        .where(and(eq(schema.models.providerId, providerId), eq(schema.models.modelId, modelId)))
        .limit(1)
    )[0]?.enabled;

  test("starts enabled", async () => {
    await seedModels([{ id: "auto/claude-sonnet-5" }]);
    expect(await enabledOf("auto/claude-sonnet-5")).toBe(true);
  });

  test("can be disabled and re-enabled", async () => {
    await seedModels([{ id: "auto/claude-sonnet-5" }]);

    expect((await setEnabled("auto/claude-sonnet-5", false)).status).toBe(200);
    expect(await enabledOf("auto/claude-sonnet-5")).toBe(false);

    expect((await setEnabled("auto/claude-sonnet-5", true)).status).toBe(200);
    expect(await enabledOf("auto/claude-sonnet-5")).toBe(true);
  });

  test("does not touch tier or price", async () => {
    await seedModels([{ id: "claude-sonnet-5", tier: "heavy", source: "manual" }]);
    await setEnabled("claude-sonnet-5", false);

    const row = await tierOf("claude-sonnet-5");
    expect(row.tier).toBe("heavy");
    expect(row.source).toBe("manual");
  });

  test("a disabled model still appears in the list, marked disabled", async () => {
    await seedModels([{ id: "no-think/claude-sonnet-5" }]);
    expect((await setEnabled("no-think/claude-sonnet-5", false)).status).toBe(200);

    const providers = (await body(await app.request("/api/providers", withCookie(cookie)))).providers;
    const model = providers[0].models.find(
      (m: { modelId: string }) => m.modelId === "no-think/claude-sonnet-5",
    );
    expect(model.enabled).toBe(false);
  });

  test("is recorded in the audit log under its own action, not tier_changed", async () => {
    await seedModels([{ id: "claude-sonnet-5" }]);
    await setEnabled("claude-sonnet-5", false);

    const entries = await db.select().from(schema.auditLog);
    expect(entries.some((e) => e.action === "model.disabled")).toBe(true);
    expect(entries.some((e) => e.action === "model.tier_changed")).toBe(false);
  });

  test("re-enabling is its own distinct action too", async () => {
    await seedModels([{ id: "claude-sonnet-5" }]);
    await setEnabled("claude-sonnet-5", false);
    await setEnabled("claude-sonnet-5", true);

    const entries = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "model.enabled"));
    expect(entries).toHaveLength(1);
  });

  test("another user cannot disable your models", async () => {
    await seedModels([{ id: "claude-sonnet-5" }]);

    await db.insert(schema.users).values({
      id: "stranger2",
      email: "stranger2@x.com",
      passwordHash: await Bun.password.hash(PASSWORD, { algorithm: "argon2id" }),
      instanceRole: "user",
      status: "active",
      createdAt: Date.now(),
    });
    const strangerCookie = cookieFrom(
      await app.request("/api/auth/login", json({ email: "stranger2@x.com", password: PASSWORD })),
    );

    const res = await app.request(`/api/providers/${providerId}/models/claude-sonnet-5`, {
      method: "PATCH",
      headers: { cookie: strangerCookie, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
    expect(await enabledOf("claude-sonnet-5")).toBe(true);
  });
});

describe("removing a provider", () => {
  const destroy = (c: string) => app.request(`/api/providers/${providerId}`, withCookie(c, { method: "DELETE" }));

  test("removes it from the list", async () => {
    const res = await destroy(cookie);
    expect(res.status).toBe(200);

    const providers = (await body(await app.request("/api/providers", withCookie(cookie)))).providers;
    expect(providers).toHaveLength(0);
  });

  /* The key itself has no read path back out, so a mistaken removal cannot be
     undone by re-reading it — only by re-entering it from wherever it lives.
     The models are at least meant to disappear cleanly with it. */
  test("cascades to its models", async () => {
    await seedModels([{ id: "claude-sonnet-5" }, { id: "claude-haiku-4-5" }]);
    await destroy(cookie);

    const rows = await db.select().from(schema.models).where(eq(schema.models.providerId, providerId));
    expect(rows).toEqual([]);
  });

  test("is recorded in the audit log", async () => {
    await destroy(cookie);
    const entries = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "provider.removed"));
    expect(entries).toHaveLength(1);
  });

  test("another user cannot remove your provider", async () => {
    await db.insert(schema.users).values({
      id: "stranger3",
      email: "stranger3@x.com",
      passwordHash: await Bun.password.hash(PASSWORD, { algorithm: "argon2id" }),
      instanceRole: "user",
      status: "active",
      createdAt: Date.now(),
    });
    const strangerCookie = cookieFrom(
      await app.request("/api/auth/login", json({ email: "stranger3@x.com", password: PASSWORD })),
    );

    expect((await destroy(strangerCookie)).status).toBe(404);
    const providers = (await body(await app.request("/api/providers", withCookie(cookie)))).providers;
    expect(providers).toHaveLength(1);
  });

  test("a provider that does not exist is a 404", async () => {
    const res = await app.request("/api/providers/no-such-provider", withCookie(cookie, { method: "DELETE" }));
    expect(res.status).toBe(404);
  });
});

/* A refresh is what the provider offers now, not everything it has ever
 * offered. Models withdrawn upstream used to stay in the picker and in every
 * list forever, so a catalogue that had shrunk from 669 to 379 still showed
 * 669 with nothing saying which were real. */
describe("refreshing a provider's models", () => {
  const realFetch = globalThis.fetch;

  /* Only /models is stubbed; probing is skipped with ?probe=0 so the test
     asserts reconciliation rather than the probe budget. */
  function offering(ids: string[]) {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  }

  const refresh = () =>
    app.request(`/api/providers/${providerId}/refresh?probe=0`, withCookie(cookie, { method: "POST" }));

  const storedIds = async () =>
    (await db.select().from(schema.models).where(eq(schema.models.providerId, providerId)))
      .map((m) => m.modelId)
      .sort();

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("adds what is newly offered", async () => {
    offering(["a", "b"]);
    expect((await refresh()).status).toBe(200);
    expect(await storedIds()).toEqual(["a", "b"]);
  });

  test("drops what the provider no longer offers, and says how many", async () => {
    await seedModels([{ id: "gone-1" }, { id: "gone-2" }, { id: "kept" }]);

    offering(["kept", "new"]);
    const res = await refresh();
    expect((await body(res)).removed).toBe(2);
    expect(await storedIds()).toEqual(["kept", "new"]);
  });

  /* The guard that matters: a provider having a bad moment must not be read
     as "it offers nothing", which would delete the catalogue and take every
     hand-set tier and price with it. */
  test("an empty listing changes nothing", async () => {
    await seedModels([{ id: "a" }, { id: "b" }]);

    offering([]);
    const res = await refresh();
    expect((await body(res)).removed).toBe(0);
    expect(await storedIds()).toEqual(["a", "b"]);
  });

  test("a hand-set tier survives a refresh that keeps the model", async () => {
    await seedModels([{ id: "kept", tier: "heavy", source: "manual" }]);

    offering(["kept"]);
    await refresh();
    expect((await tierOf("kept")).tier).toBe("heavy");
    expect((await tierOf("kept")).source).toBe("manual");
  });

  test("only this provider's models are reconciled", async () => {
    const other = crypto.randomUUID();
    await db.insert(schema.providerConnections).values({
      id: other, ownerUserId: (await db.select().from(schema.users).limit(1))[0].id,
      ownerOrgId: null, name: "Other", kind: "openai_compatible",
      baseUrl: "https://other.test/v1", encryptedKey: encryptSecret("k"),
      enabled: true, lastHealthAt: null, lastHealthOk: null, createdAt: Date.now(),
    });
    await db.insert(schema.models).values({
      id: crypto.randomUUID(), providerId: other, modelId: "theirs",
      tier: "standard", tierSource: "inferred", contextWindow: null,
      priceInPerMTok: null, priceOutPerMTok: null, enabled: true, needsReasoningEffort: false,
    });

    offering(["mine"]);
    await refresh();

    const theirs = await db.select().from(schema.models).where(eq(schema.models.providerId, other));
    expect(theirs).toHaveLength(1);
  });
});

/* One connection to a proxy fronts many upstreams, and they fail, rate-limit
 * and cost independently. Turning one off should not mean clicking through
 * thirty models, and must not touch the rest of the connection. */
describe("enabling and disabling a whole upstream", () => {
  const setOwner = (c: string, ownedBy: string, enabled: boolean) =>
    app.request(`/api/providers/${providerId}/owners/${encodeURIComponent(ownedBy)}`, {
      method: "PATCH",
      headers: { cookie: c, "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });

  async function seedOwned(rows: Array<{ id: string; ownedBy: string }>) {
    for (const row of rows) {
      await db.insert(schema.models).values({
        id: crypto.randomUUID(), providerId, modelId: row.id, ownedBy: row.ownedBy,
        tier: "standard", tierSource: "inferred", contextWindow: null,
        priceInPerMTok: null, priceOutPerMTok: null, enabled: true, needsReasoningEffort: false,
      });
    }
  }

  const enabledOf = async (ownedBy: string) =>
    (await db.select().from(schema.models).where(eq(schema.models.ownedBy, ownedBy)))
      .filter((m) => m.enabled).length;

  test("turns off every model that upstream serves", async () => {
    await seedOwned([
      { id: "a1", ownedBy: "antigravity" },
      { id: "a2", ownedBy: "antigravity" },
      { id: "g1", ownedBy: "groq" },
    ]);

    const res = await setOwner(cookie, "antigravity", false);
    expect((await body(res)).models).toBe(2);
    expect(await enabledOf("antigravity")).toBe(0);
  });

  /* The whole reason to group rather than remove the connection: the rest of
     it keeps working while one upstream is down. */
  test("leaves the other upstreams alone", async () => {
    await seedOwned([{ id: "a1", ownedBy: "antigravity" }, { id: "g1", ownedBy: "groq" }]);
    await setOwner(cookie, "antigravity", false);
    expect(await enabledOf("groq")).toBe(1);
  });

  test("turns them back on again", async () => {
    await seedOwned([{ id: "a1", ownedBy: "antigravity" }]);
    await setOwner(cookie, "antigravity", false);
    await setOwner(cookie, "antigravity", true);
    expect(await enabledOf("antigravity")).toBe(1);
  });

  test("is recorded in the audit log", async () => {
    await seedOwned([{ id: "a1", ownedBy: "antigravity" }]);
    await setOwner(cookie, "antigravity", false);

    const entries = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "provider.owner_disabled"));
    expect(entries).toHaveLength(1);
  });

  test("another user cannot reach into your provider", async () => {
    await seedOwned([{ id: "a1", ownedBy: "antigravity" }]);
    await db.insert(schema.users).values({
      id: "stranger-owner", email: "so@x.com",
      passwordHash: await Bun.password.hash(PASSWORD, { algorithm: "argon2id" }),
      instanceRole: "user", status: "active", createdAt: Date.now(),
    });
    const strangerCookie = cookieFrom(
      await app.request("/api/auth/login", json({ email: "so@x.com", password: PASSWORD })),
    );

    expect((await setOwner(strangerCookie, "antigravity", false)).status).toBe(404);
    expect(await enabledOf("antigravity")).toBe(1);
  });

  test("an upstream nobody serves changes nothing", async () => {
    const res = await setOwner(cookie, "nonexistent", false);
    expect((await body(res)).models).toBe(0);
  });
});

/* Testing one upstream is the narrow version of the question a refresh asks
 * broadly: thirty calls to find out whether antigravity is back, rather than
 * three hundred to find out about everything. It records verdicts and nothing
 * else — testing must never change which models exist. */
describe("testing one upstream's models", () => {
  const realFetch = globalThis.fetch;

  /* Every probe is a chat completion; this makes one model fail and the rest
     succeed, so the counts mean something. */
  function probesFailingFor(deadModelIds: string[]) {
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const sent = String((init?.body as string) ?? "");
      if (deadModelIds.some((id) => sent.includes(`"${id}"`))) {
        return new Response(JSON.stringify({ error: { message: "no credentials" } }), { status: 404 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function seedOwned(rows: Array<{ id: string; ownedBy: string }>) {
    for (const row of rows) {
      await db.insert(schema.models).values({
        id: crypto.randomUUID(), providerId, modelId: row.id, ownedBy: row.ownedBy,
        tier: "standard", tierSource: "inferred", contextWindow: null,
        priceInPerMTok: null, priceOutPerMTok: null, enabled: true, needsReasoningEffort: false,
      });
    }
  }

  const test1 = (c: string, ownedBy: string) =>
    app.request(`/api/providers/${providerId}/owners/${encodeURIComponent(ownedBy)}/test`, {
      method: "POST",
      headers: { cookie: c },
    });

  test("probes only that upstream, and reports how many work", async () => {
    await seedOwned([
      { id: "ag-1", ownedBy: "antigravity" },
      { id: "ag-2", ownedBy: "antigravity" },
      { id: "gq-1", ownedBy: "groq" },
    ]);
    probesFailingFor(["ag-2"]);

    const res = await test1(cookie, "antigravity");
    expect(await body<{ tested: number; usable: number }>(res)).toEqual({ tested: 2, usable: 1 });

    /* The other upstream was not touched, so it keeps its unknown verdict. */
    const [groq] = await db.select().from(schema.models).where(eq(schema.models.modelId, "gq-1"));
    expect(groq.probeOk).toBeNull();
  });

  test("records the verdict against each model", async () => {
    await seedOwned([{ id: "ag-1", ownedBy: "antigravity" }, { id: "ag-2", ownedBy: "antigravity" }]);
    probesFailingFor(["ag-2"]);
    await test1(cookie, "antigravity");

    const rows = await db.select().from(schema.models).where(eq(schema.models.ownedBy, "antigravity"));
    expect(rows.find((r) => r.modelId === "ag-1")!.probeOk).toBe(true);
    expect(rows.find((r) => r.modelId === "ag-2")!.probeOk).toBe(false);
  });

  /* The property that separates this from a refresh. */
  test("never adds or removes a model", async () => {
    await seedOwned([{ id: "ag-1", ownedBy: "antigravity" }]);
    probesFailingFor([]);

    const before = (await db.select().from(schema.models).where(eq(schema.models.providerId, providerId))).length;
    await test1(cookie, "antigravity");
    const after = (await db.select().from(schema.models).where(eq(schema.models.providerId, providerId))).length;
    expect(after).toBe(before);
  });

  test("an upstream with no models costs nothing", async () => {
    probesFailingFor([]);
    expect(await body<{ tested: number; usable: number }>(await test1(cookie, "nobody"))).toEqual({ tested: 0, usable: 0 });
  });

  test("a stranger cannot spend your API budget", async () => {
    await seedOwned([{ id: "ag-1", ownedBy: "antigravity" }]);
    await db.insert(schema.users).values({
      id: "stranger-test", email: "st@x.com",
      passwordHash: await Bun.password.hash(PASSWORD, { algorithm: "argon2id" }),
      instanceRole: "user", status: "active", createdAt: Date.now(),
    });
    const strangerCookie = cookieFrom(
      await app.request("/api/auth/login", json({ email: "st@x.com", password: PASSWORD })),
    );

    expect((await test1(strangerCookie, "antigravity")).status).toBe(404);
  });
});

/* Several ids routinely point at one underlying model — "cc/claude-opus-5"
 * and "claude/claude-opus-5" behind two prefixes. Collapsing them is
 * automatic, which makes the guards the important part: it must never turn
 * off a model a list depends on, and repeated refreshes must settle. */
describe("collapsing aliases of the same model", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function offering(entries: Array<{ id: string; root?: string; owned_by?: string }>) {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: entries }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  }

  const refresh = () =>
    app.request(`/api/providers/${providerId}/refresh?probe=0`, withCookie(cookie, { method: "POST" }));

  const enabledOf = async (modelId: string) =>
    (
      await db
        .select({ enabled: schema.models.enabled })
        .from(schema.models)
        .where(and(eq(schema.models.providerId, providerId), eq(schema.models.modelId, modelId)))
        .limit(1)
    )[0]?.enabled;

  test("keeps one id per root and disables the rest", async () => {
    offering([
      { id: "cc/opus", root: "opus" },
      { id: "claude/opus", root: "opus" },
      { id: "solo", root: "solo" },
    ]);

    const res = await refresh();
    expect((await body<{ collapsed: number }>(res)).collapsed).toBe(1);

    const enabled = (await Promise.all([enabledOf("cc/opus"), enabledOf("claude/opus")])).filter(Boolean);
    expect(enabled).toHaveLength(1);
    /* An unaliased model is never touched. */
    expect(await enabledOf("solo")).toBe(true);
  });

  /* The guard that matters most: the conductor profile names specific ids, and
     collapsing the wrong one would break routing with nothing said. */
  test("never disables a model a list names", async () => {
    offering([
      { id: "cc/opus", root: "opus" },
      { id: "claude/opus", root: "opus" },
    ]);
    await refresh();

    const listId = crypto.randomUUID();
    const [user] = await db.select().from(schema.users).limit(1);
    await db.insert(schema.modelLists).values({
      id: listId, ownerUserId: user.id, ownerOrgId: null,
      name: "manager/conductor", description: null, createdAt: Date.now(),
    });
    await db.insert(schema.modelListEntries).values({
      id: crypto.randomUUID(), listId, modelId: "claude/opus", groupId: null, position: 0, createdAt: Date.now(),
    });
    /* Put it back on, as a user would after noticing. */
    await db.update(schema.models).set({ enabled: true }).where(eq(schema.models.modelId, "claude/opus"));

    await refresh();
    expect(await enabledOf("claude/opus")).toBe(true);
  });

  test("a model a group names is protected too", async () => {
    offering([
      { id: "cc/opus", root: "opus" },
      { id: "claude/opus", root: "opus" },
    ]);
    await refresh();

    const [user] = await db.select().from(schema.users).limit(1);
    const groupId = crypto.randomUUID();
    await db.insert(schema.modelGroups).values({
      id: groupId, ownerUserId: user.id, ownerOrgId: null, name: "Opus", createdAt: Date.now(),
    });
    await db.insert(schema.modelGroupMembers).values({
      id: crypto.randomUUID(), groupId, modelId: "claude/opus", position: 0, createdAt: Date.now(),
    });
    await db.update(schema.models).set({ enabled: true }).where(eq(schema.models.modelId, "claude/opus"));

    await refresh();
    expect(await enabledOf("claude/opus")).toBe(true);
  });

  /* Effort variants share a parent, not a root, and are real choices. */
  test("leaves effort variants alone", async () => {
    offering([
      { id: "opus", root: "opus" },
      { id: "opus-high", root: "opus-high" },
      { id: "opus-low", root: "opus-low" },
    ]);

    expect((await body<{ collapsed: number }>(await refresh())).collapsed).toBe(0);
    expect(await enabledOf("opus-high")).toBe(true);
    expect(await enabledOf("opus-low")).toBe(true);
  });

  /* Repeated refreshes must settle rather than flip which alias survives. */
  test("is stable across refreshes", async () => {
    offering([
      { id: "cc/opus", root: "opus" },
      { id: "claude/opus", root: "opus" },
    ]);
    await refresh();
    const first = await enabledOf("cc/opus");

    expect((await body<{ collapsed: number }>(await refresh())).collapsed).toBe(0);
    expect(await enabledOf("cc/opus")).toBe(first);
  });


  /* The case the provider's own `root` misses: for no-think variants it points
     at the id itself, so every one looks unique and the pairs slip through. */
  test("collapses no-think pairs the provider calls unique", async () => {
    offering([
      { id: "no-think/cc/opus", root: "no-think/cc/opus", owned_by: "claude" },
      { id: "no-think/claude/opus", root: "no-think/claude/opus", owned_by: "claude" },
    ]);
    expect((await body<{ collapsed: number }>(await refresh())).collapsed).toBe(1);
  });

  /* Not thinking is a different model to talk to, so a modifier must never be
     stripped the way a vendor prefix is. */
  test("never merges a no-think variant into its thinking twin", async () => {
    offering([
      { id: "cc/opus", root: "a", owned_by: "claude" },
      { id: "no-think/cc/opus", root: "b", owned_by: "claude" },
    ]);
    expect((await body<{ collapsed: number }>(await refresh())).collapsed).toBe(0);
    expect(await enabledOf("cc/opus")).toBe(true);
    expect(await enabledOf("no-think/cc/opus")).toBe(true);
  });

  /* The same model from two upstreams is the redundancy model groups exist to
     exploit — collapsing it would remove the fallback. */
  test("keeps the same model served by a different upstream", async () => {
    offering([
      { id: "cc/sonnet", root: "sonnet", owned_by: "claude" },
      { id: "claude/sonnet", root: "sonnet", owned_by: "claude" },
      { id: "antigravity/sonnet", root: "sonnet", owned_by: "antigravity" },
    ]);
    expect((await body<{ collapsed: number }>(await refresh())).collapsed).toBe(1);
    expect(await enabledOf("antigravity/sonnet")).toBe(true);
  });

  test("a provider that reports no root collapses nothing", async () => {
    offering([{ id: "a" }, { id: "b" }]);
    expect((await body<{ collapsed: number }>(await refresh())).collapsed).toBe(0);
    expect(await enabledOf("a")).toBe(true);
    expect(await enabledOf("b")).toBe(true);
  });
});
