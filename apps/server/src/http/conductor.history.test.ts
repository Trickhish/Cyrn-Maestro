import { expect, test, describe, beforeEach } from "bun:test";
import { app } from "../app";
import { db, schema } from "../db";
import { resetDatabase, jsonPost as json, cookieFrom, body } from "../test/harness";

/* The Conductor's thread.
 *
 * Losing it on reload made it a stranger every time, and cost the model the
 * one thing that makes a follow-up useful — what you just asked it to do. It
 * is kept, but bounded: a working memory rather than an archive. */

const PASSWORD = "a-long-enough-password";
let cookie: string;
let userId: string;

const withCookie = (c: string, init: RequestInit = {}) => ({
  ...init,
  headers: { ...(init.headers ?? {}), cookie: c },
});

async function seed(count: number, projectId: string | null) {
  for (let i = 0; i < count; i++) {
    await db.insert(schema.conductorMessages).values({
      id: crypto.randomUUID(),
      projectId,
      actorUserId: userId,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
      model: null,
      createdAt: Date.now() + i,
    });
  }
}

async function history(query = "") {
  const res = await app.request(`/api/conductor/history${query}`, withCookie(cookie));
  return body<{ messages: Array<{ role: string; content: string }> }>(res);
}

beforeEach(async () => {
  resetDatabase();
  cookie = cookieFrom(
    await app.request("/api/auth/register", json({ email: "owner@x.com", password: PASSWORD })),
  );
  const [user] = await db.select().from(schema.users).limit(1);
  userId = user.id;

  await db.insert(schema.projects).values([
    { id: "p-1", ownerUserId: userId, ownerOrgId: null, name: "One", slug: "one", repoUrl: null, branch: null, instructions: null, defaultModelId: null, spendCapUsd: null, createdAt: Date.now() },
    { id: "p-2", ownerUserId: userId, ownerOrgId: null, name: "Two", slug: "two", repoUrl: null, branch: null, instructions: null, defaultModelId: null, spendCapUsd: null, createdAt: Date.now() },
  ]);
});

describe("the conductor's thread", () => {
  test("comes back in the order it was said", async () => {
    await seed(4, "p-1");
    const { messages } = await history("?projectId=p-1");
    expect(messages.map((m) => m.content)).toEqual([
      "message 0",
      "message 1",
      "message 2",
      "message 3",
    ]);
  });

  /* One thread per project. A conversation about one project is not context
     for another, and mixing them would be worse than having none. */
  test("is separate per project", async () => {
    await seed(2, "p-1");
    await seed(3, "p-2");

    expect((await history("?projectId=p-1")).messages).toHaveLength(2);
    expect((await history("?projectId=p-2")).messages).toHaveLength(3);
  });

  /* The global screen is its own thread, keyed by a null project — which is
     why the lookup uses IS NULL rather than an equality that matches nothing. */
  test("the global screen has its own, not everything at once", async () => {
    await seed(2, null);
    await seed(5, "p-1");

    expect((await history()).messages).toHaveLength(2);
  });

  test("another person's thread is not visible", async () => {
    await db.insert(schema.users).values({
      id: "other", email: "other@x.com",
      passwordHash: await Bun.password.hash(PASSWORD, { algorithm: "argon2id" }),
      instanceRole: "user", status: "active", createdAt: Date.now(),
    });
    await db.insert(schema.conductorMessages).values({
      id: crypto.randomUUID(), projectId: "p-1", actorUserId: "other",
      role: "user", content: "theirs", model: null, createdAt: Date.now(),
    });

    const { messages } = await history("?projectId=p-1");
    expect(messages).toHaveLength(0);
  });

  test("can be cleared, and only for that thread", async () => {
    await seed(3, "p-1");
    await seed(2, "p-2");

    const res = await app.request("/api/conductor/history?projectId=p-1", withCookie(cookie, { method: "DELETE" }));
    expect(res.status).toBe(200);

    expect((await history("?projectId=p-1")).messages).toHaveLength(0);
    expect((await history("?projectId=p-2")).messages).toHaveLength(2);
  });

  /* Bounded on purpose: old turns cost tokens on every call and answer
     questions nobody is asking any more. */
  test("never returns more than the bound", async () => {
    await seed(60, "p-1");
    const { messages } = await history("?projectId=p-1");
    expect(messages).toHaveLength(40);
    /* The newest, not the oldest — continuing a conversation needs the end
       of it. */
    expect(messages.at(-1)!.content).toBe("message 59");
  });

  test("a signed-out request is refused", async () => {
    expect((await app.request("/api/conductor/history")).status).toBe(401);
  });
});
