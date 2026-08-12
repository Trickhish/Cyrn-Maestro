import { expect, test, describe, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../app";
import { db, schema } from "../db";
import { resetDatabase, jsonPost, cookieFrom, body, signedInOwner } from "../test/harness";
import { encryptSecret, hashPassword } from "../lib/crypto";

/* Groups: one name for several ids of the same underlying model — the id
 * sprawl a real fleet accumulates from dated snapshots, proxy aliases, and
 * per-vendor renames. Mostly the same shape as model-lists.routes.test.ts:
 * ordering staying intact under edits, and the same tenancy boundary every
 * owner-scoped store here has. */

const PASSWORD = "a-long-enough-password";

let ownerCookie: string;
let ownerId: string;
let providerId: string;

const withCookie = (cookie: string, init: RequestInit = {}) => ({
  ...init,
  headers: { ...(init.headers ?? {}), cookie },
});

async function seedModel(modelId: string) {
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
  await seedModel("claude-opus-5");
  await seedModel("cc/claude-opus-5-xhigh");
  await seedModel("agy/claude-opus-4-6-thinking-high");
});

const get = (cookie: string) => app.request("/api/model-groups", withCookie(cookie));

const create = (cookie: string, payload: unknown) =>
  app.request("/api/model-groups", withCookie(cookie, jsonPost(payload)));

const patch = (cookie: string, id: string, payload: unknown) =>
  app.request(`/api/model-groups/${id}`, { ...withCookie(cookie, jsonPost(payload)), method: "PATCH" });

const destroy = (cookie: string, id: string) =>
  app.request(`/api/model-groups/${id}`, withCookie(cookie, { method: "DELETE" }));

const addMember = (cookie: string, groupId: string, modelId: string) =>
  app.request(`/api/model-groups/${groupId}/members`, withCookie(cookie, jsonPost({ modelId })));

const removeMember = (cookie: string, groupId: string, memberId: string) =>
  app.request(`/api/model-groups/${groupId}/members/${memberId}`, withCookie(cookie, { method: "DELETE" }));

const reorder = (cookie: string, groupId: string, memberIds: string[]) =>
  app.request(`/api/model-groups/${groupId}/order`, {
    ...withCookie(cookie, jsonPost({ memberIds })),
    method: "PUT",
  });

async function createGroup(name = "claude opus") {
  const res = await create(ownerCookie, { name });
  return (await body(res)).group.id as string;
}

describe("creating a group", () => {
  test("with a name", async () => {
    const res = await create(ownerCookie, { name: "claude opus" });
    expect(res.status).toBe(201);

    const { groups } = await body(await get(ownerCookie));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ name: "claude opus", members: [] });
  });

  test("needs a name", async () => {
    expect((await create(ownerCookie, {})).status).toBe(400);
  });

  test("refuses a second group with the same name", async () => {
    await create(ownerCookie, { name: "claude opus" });
    const res = await create(ownerCookie, { name: "claude opus" });
    expect(res.status).toBe(400);
    expect((await body(await get(ownerCookie))).groups).toHaveLength(1);
  });

  test("records it in the audit log", async () => {
    await create(ownerCookie, { name: "claude opus" });
    const entries = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "model_group.created"));
    expect(entries).toHaveLength(1);
  });
});

describe("renaming and deleting", () => {
  test("renames it", async () => {
    const id = await createGroup();
    expect((await patch(ownerCookie, id, { name: "opus" })).status).toBe(200);
    expect((await body(await get(ownerCookie))).groups[0].name).toBe("opus");
  });

  test("a group that does not exist is a 404", async () => {
    expect((await patch(ownerCookie, "no-such-group", { name: "x" })).status).toBe(404);
  });

  test("deleting removes it and its members", async () => {
    const id = await createGroup();
    await addMember(ownerCookie, id, "claude-opus-5");

    expect((await destroy(ownerCookie, id)).status).toBe(200);
    expect((await body(await get(ownerCookie))).groups).toEqual([]);
    expect(
      await db.select().from(schema.modelGroupMembers).where(eq(schema.modelGroupMembers.groupId, id)),
    ).toEqual([]);
  });
});

describe("members", () => {
  test("adding one puts it at the end", async () => {
    const id = await createGroup();
    await addMember(ownerCookie, id, "claude-opus-5");
    await addMember(ownerCookie, id, "cc/claude-opus-5-xhigh");

    const { members } = (await body(await get(ownerCookie))).groups[0];
    expect(members.map((m: { modelId: string }) => m.modelId)).toEqual([
      "claude-opus-5",
      "cc/claude-opus-5-xhigh",
    ]);
  });

  test("refuses a model the owner has no provider for", async () => {
    const id = await createGroup();
    const res = await addMember(ownerCookie, id, "gpt-99-nonexistent");
    expect(res.status).toBe(400);
    expect((await body(await get(ownerCookie))).groups[0].members).toEqual([]);
  });

  test("refuses the same model twice", async () => {
    const id = await createGroup();
    await addMember(ownerCookie, id, "claude-opus-5");
    const res = await addMember(ownerCookie, id, "claude-opus-5");
    expect(res.status).toBe(400);
    expect((await body(await get(ownerCookie))).groups[0].members).toHaveLength(1);
  });

  test("removing one closes the gap for anything added after", async () => {
    const id = await createGroup();
    await addMember(ownerCookie, id, "claude-opus-5");
    const { id: middleId } = await body(await addMember(ownerCookie, id, "cc/claude-opus-5-xhigh"));
    await addMember(ownerCookie, id, "agy/claude-opus-4-6-thinking-high");

    await removeMember(ownerCookie, id, middleId);

    const { members } = (await body(await get(ownerCookie))).groups[0];
    expect(members.map((m: { modelId: string }) => m.modelId)).toEqual([
      "claude-opus-5",
      "agy/claude-opus-4-6-thinking-high",
    ]);
  });
});

describe("reordering", () => {
  test("puts members in the order sent", async () => {
    const id = await createGroup();
    const first = await body(await addMember(ownerCookie, id, "claude-opus-5"));
    const second = await body(await addMember(ownerCookie, id, "cc/claude-opus-5-xhigh"));
    const third = await body(await addMember(ownerCookie, id, "agy/claude-opus-4-6-thinking-high"));

    const res = await reorder(ownerCookie, id, [third.id, first.id, second.id]);
    expect(res.status).toBe(200);

    const { members } = (await body(await get(ownerCookie))).groups[0];
    expect(members.map((m: { id: string }) => m.id)).toEqual([third.id, first.id, second.id]);
  });

  test("refuses an order that drops or invents a member", async () => {
    const id = await createGroup();
    const first = await body(await addMember(ownerCookie, id, "claude-opus-5"));
    await addMember(ownerCookie, id, "cc/claude-opus-5-xhigh");

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

  test("someone else's groups do not appear", async () => {
    await createGroup();
    expect((await body(await get(strangerCookie))).groups).toEqual([]);
  });

  test("a stranger cannot rename, delete, or add to someone else's group", async () => {
    const id = await createGroup();

    expect((await patch(strangerCookie, id, { name: "hijacked" })).status).toBe(404);
    expect((await destroy(strangerCookie, id)).status).toBe(404);
    expect((await addMember(strangerCookie, id, "claude-opus-5")).status).toBe(404);

    const { groups } = await body(await get(ownerCookie));
    expect(groups[0].name).toBe("claude opus");
  });
});
