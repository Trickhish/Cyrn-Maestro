import { expect, test, describe, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../app";
import { db, schema } from "../db";
import { resetDatabase, jsonPost, cookieFrom, body, signedInOwner } from "../test/harness";
import { encryptSecret, hashPassword } from "../lib/crypto";

/* Named, ordered fallback chains of models — "difficult programming",
 * "tester", "decision maker" — curated by hand rather than inferred, for
 * whatever ends up choosing a model per task to read. Mostly about ordering
 * staying intact under edits, and the same tenancy boundary every other
 * owner-scoped store here has: someone outside the owner must not see or
 * change a list, and an entry has to name a model the owner can actually
 * reach. */

const PASSWORD = "a-long-enough-password";

let ownerCookie: string;
let ownerId: string;
let providerId: string;

const withCookie = (cookie: string, init: RequestInit = {}) => ({
  ...init,
  headers: { ...(init.headers ?? {}), cookie },
});

async function seedModel(modelId: string, over: Partial<typeof schema.models.$inferInsert> = {}) {
  await db.insert(schema.models).values({
    id: crypto.randomUUID(),
    providerId,
    modelId,
    tier: "standard",
    tierSource: "inferred",
    contextWindow: null,
    priceInPerMTok: null,
    priceOutPerMTok: null,
    enabled: true,
    needsReasoningEffort: false,
    ...over,
  });
}

beforeEach(async () => {
  resetDatabase();

  const owner = await signedInOwner(app as never);
  ownerCookie = owner.cookie;
  ownerId = owner.actor.id;

  providerId = crypto.randomUUID();
  await db.insert(schema.providerConnections).values({
    id: providerId,
    ownerUserId: ownerId,
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
  await seedModel("claude-opus-4-5");
  await seedModel("claude-sonnet-4-5");
  await seedModel("claude-haiku-4-5");
});

const get = (cookie: string) => app.request("/api/model-lists", withCookie(cookie));

const create = (cookie: string, payload: unknown) =>
  app.request("/api/model-lists", withCookie(cookie, jsonPost(payload)));

const patch = (cookie: string, id: string, payload: unknown) =>
  app.request(`/api/model-lists/${id}`, {
    ...withCookie(cookie, jsonPost(payload)),
    method: "PATCH",
  });

const destroy = (cookie: string, id: string) =>
  app.request(`/api/model-lists/${id}`, withCookie(cookie, { method: "DELETE" }));

const addEntry = (cookie: string, listId: string, modelId: string) =>
  app.request(`/api/model-lists/${listId}/entries`, withCookie(cookie, jsonPost({ modelId })));

const removeEntry = (cookie: string, listId: string, entryId: string) =>
  app.request(`/api/model-lists/${listId}/entries/${entryId}`, withCookie(cookie, { method: "DELETE" }));

const reorder = (cookie: string, listId: string, entryIds: string[]) =>
  app.request(`/api/model-lists/${listId}/order`, {
    ...withCookie(cookie, jsonPost({ entryIds })),
    method: "PUT",
  });

async function createList(name = "difficult programming", description = "Hard, novel problems.") {
  const res = await create(ownerCookie, { name, description });
  return (await body(res)).list.id as string;
}

describe("creating a list", () => {
  test("with a name and a description", async () => {
    const res = await create(ownerCookie, {
      name: "difficult programming",
      description: "Hard, novel problems that need real reasoning.",
    });
    expect(res.status).toBe(201);

    const { lists } = await body(await get(ownerCookie));
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({
      name: "difficult programming",
      description: "Hard, novel problems that need real reasoning.",
      entries: [],
    });
  });

  test("the description is optional", async () => {
    const res = await create(ownerCookie, { name: "tester" });
    expect(res.status).toBe(201);
    expect((await body(res)).list.description).toBeNull();
  });

  test("needs a name", async () => {
    expect((await create(ownerCookie, { description: "x" })).status).toBe(400);
  });

  test("refuses a second list with the same name", async () => {
    await create(ownerCookie, { name: "tester" });
    const res = await create(ownerCookie, { name: "tester" });
    expect(res.status).toBe(400);

    const { lists } = await body(await get(ownerCookie));
    expect(lists).toHaveLength(1);
  });

  test("names can hold spaces and slashes, unlike an MCP server name", async () => {
    const res = await create(ownerCookie, { name: "manager/conductor" });
    expect(res.status).toBe(201);
  });

  test("records it in the audit log", async () => {
    await create(ownerCookie, { name: "tester" });
    const entries = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "model_list.created"));
    expect(entries).toHaveLength(1);
  });
});

describe("editing a list", () => {
  test("renames it", async () => {
    const id = await createList("tester", "runs the test suite");
    expect((await patch(ownerCookie, id, { name: "QA" })).status).toBe(200);
    expect((await body(await get(ownerCookie))).lists[0].name).toBe("QA");
  });

  test("updates the description alone", async () => {
    const id = await createList();
    await patch(ownerCookie, id, { description: "Updated." });
    const list = (await body(await get(ownerCookie))).lists[0];
    expect(list.name).toBe("difficult programming");
    expect(list.description).toBe("Updated.");
  });

  test("a list that does not exist is a 404", async () => {
    expect((await patch(ownerCookie, "no-such-list", { name: "x" })).status).toBe(404);
  });
});

describe("deleting a list", () => {
  test("removes it and its entries", async () => {
    const id = await createList();
    await addEntry(ownerCookie, id, "claude-opus-4-5");

    expect((await destroy(ownerCookie, id)).status).toBe(200);
    expect((await body(await get(ownerCookie))).lists).toEqual([]);
    expect(
      await db.select().from(schema.modelListEntries).where(eq(schema.modelListEntries.listId, id)),
    ).toEqual([]);
  });
});

describe("entries", () => {
  test("adding one puts it at the end", async () => {
    const id = await createList();
    await addEntry(ownerCookie, id, "claude-opus-4-5");
    await addEntry(ownerCookie, id, "claude-sonnet-4-5");

    const { entries } = (await body(await get(ownerCookie))).lists[0];
    expect(entries.map((e: { modelId: string }) => e.modelId)).toEqual([
      "claude-opus-4-5",
      "claude-sonnet-4-5",
    ]);
  });

  /* The whole point of a list: an entry that cannot resolve to anything is
     worse than no entry at all — it looks chosen but never runs. */
  test("refuses a model the owner has no provider for", async () => {
    const id = await createList();
    const res = await addEntry(ownerCookie, id, "gpt-99-nonexistent");
    expect(res.status).toBe(400);
    expect((await body(await get(ownerCookie))).lists[0].entries).toEqual([]);
  });

  test("refuses the same model twice", async () => {
    const id = await createList();
    await addEntry(ownerCookie, id, "claude-opus-4-5");
    const res = await addEntry(ownerCookie, id, "claude-opus-4-5");
    expect(res.status).toBe(400);
    expect((await body(await get(ownerCookie))).lists[0].entries).toHaveLength(1);
  });

  test("removing one closes the gap for anything added after", async () => {
    const id = await createList();
    await addEntry(ownerCookie, id, "claude-opus-4-5");
    const { id: middleId } = await body(await addEntry(ownerCookie, id, "claude-sonnet-4-5"));
    await addEntry(ownerCookie, id, "claude-haiku-4-5");

    await removeEntry(ownerCookie, id, middleId);

    const { entries } = (await body(await get(ownerCookie))).lists[0];
    expect(entries.map((e: { modelId: string }) => e.modelId)).toEqual([
      "claude-opus-4-5",
      "claude-haiku-4-5",
    ]);
  });

  test("removing an entry from someone else's list does nothing", async () => {
    const id = await createList();
    const { id: entryId } = await body(await addEntry(ownerCookie, id, "claude-opus-4-5"));

    expect((await removeEntry(ownerCookie, "some-other-list", entryId)).status).toBe(404);
    expect((await body(await get(ownerCookie))).lists[0].entries).toHaveLength(1);
  });
});

describe("reordering", () => {
  test("puts entries in the order sent", async () => {
    const id = await createList();
    const first = await body(await addEntry(ownerCookie, id, "claude-opus-4-5"));
    const second = await body(await addEntry(ownerCookie, id, "claude-sonnet-4-5"));
    const third = await body(await addEntry(ownerCookie, id, "claude-haiku-4-5"));

    const res = await reorder(ownerCookie, id, [third.id, first.id, second.id]);
    expect(res.status).toBe(200);

    const { entries } = (await body(await get(ownerCookie))).lists[0];
    expect(entries.map((e: { id: string }) => e.id)).toEqual([third.id, first.id, second.id]);
  });

  test("refuses an order that drops or invents an entry", async () => {
    const id = await createList();
    const first = await body(await addEntry(ownerCookie, id, "claude-opus-4-5"));
    await addEntry(ownerCookie, id, "claude-sonnet-4-5");

    expect((await reorder(ownerCookie, id, [first.id])).status).toBe(400);
    expect((await reorder(ownerCookie, id, [first.id, "made-up-id"])).status).toBe(400);
  });
});

describe("tenancy", () => {
  let strangerCookie: string;

  beforeEach(async () => {
    await db.insert(schema.users).values({
      id: crypto.randomUUID(),
      email: "outsider@example.com",
      passwordHash: await hashPassword(PASSWORD),
      instanceRole: "user",
      status: "active",
      createdAt: Date.now(),
    });
    strangerCookie = cookieFrom(
      await app.request("/api/auth/login", jsonPost({ email: "outsider@example.com", password: PASSWORD })),
    );
  });

  test("someone else's lists do not appear", async () => {
    await createList();
    expect((await body(await get(strangerCookie))).lists).toEqual([]);
  });

  test("a stranger cannot rename, delete, or add to someone else's list", async () => {
    const id = await createList();

    expect((await patch(strangerCookie, id, { name: "hijacked" })).status).toBe(404);
    expect((await destroy(strangerCookie, id)).status).toBe(404);
    expect((await addEntry(strangerCookie, id, "claude-opus-4-5")).status).toBe(404);

    const { lists } = await body(await get(ownerCookie));
    expect(lists[0].name).toBe("difficult programming");
  });

  test("a model list is not offered to a model the stranger's own providers serve", async () => {
    /* The stranger has no provider of their own here, so even a name that
       exists on the owner's provider must be refused for them. */
    const id = await createList();
    const res = await addEntry(strangerCookie, id, "claude-opus-4-5");
    expect(res.status).toBe(404);
  });
});
