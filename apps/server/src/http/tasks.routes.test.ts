import { expect, test, describe, beforeEach } from "bun:test";
import { app } from "../app";
import { db, schema } from "../db";
import { resetDatabase, jsonPost as json, cookieFrom, body } from "../test/harness";

/* Listing tasks.
 *
 * An organization's project has no ownerUserId at all, so filtering the list
 * on the actor's own id returned an empty history for every org project: the
 * tasks existed and the thread was reachable by direct link, but the project
 * page showed nothing to click. These cover the scope the list actually runs
 * in, including that the org header grants nothing to a non-member. */

const PASSWORD = "a-long-enough-password";
const ORG = "org-acme";

let cookie: string;
let userId: string;

async function seedTask(projectId: string, title: string) {
  await db.insert(schema.tasks).values({
    id: crypto.randomUUID(),
    projectId,
    workspaceId: null,
    nodeId: null,
    actorUserId: userId,
    title,
    prompt: "do the thing",
    status: "running",
    model: "m",
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    error: null,
    startedAt: Date.now(),
    endedAt: null,
    createdAt: Date.now(),
  });
}

const list = (c: string, query = "", orgId?: string) =>
  app.request(`/api/tasks${query}`, {
    headers: { cookie: c, ...(orgId ? { "x-maestro-org": orgId } : {}) },
  });

const titles = async (res: Response) =>
  (await body(res)).tasks.map((t: { title: string }) => t.title);

beforeEach(async () => {
  resetDatabase();
  cookie = cookieFrom(
    await app.request("/api/auth/register", json({ email: "owner@x.com", password: PASSWORD })),
  );
  const [user] = await db.select().from(schema.users).limit(1);
  userId = user.id;

  await db.insert(schema.organizations).values({
    id: ORG, name: "Acme", slug: "acme", require2fa: false, createdAt: Date.now(),
  });
  await db.insert(schema.memberships).values({
    id: crypto.randomUUID(), userId, orgId: ORG, role: "admin", createdAt: Date.now(),
  });

  await db.insert(schema.projects).values([
    { id: "p-mine", ownerUserId: userId, ownerOrgId: null, name: "Mine", slug: "mine", repoUrl: null, branch: null, instructions: null, defaultModelId: null, spendCapUsd: null, createdAt: Date.now() },
    { id: "p-org", ownerUserId: null, ownerOrgId: ORG, name: "Org Project", slug: "org-project", repoUrl: null, branch: null, instructions: null, defaultModelId: null, spendCapUsd: null, createdAt: Date.now() },
  ]);

  await seedTask("p-mine", "personal task");
  await seedTask("p-org", "org task");
});

describe("listing tasks", () => {
  test("a personal project's tasks are listed", async () => {
    expect(await titles(await list(cookie))).toContain("personal task");
  });

  /* The regression: this returned nothing at all before, so an org project's
     page had no history and nothing to open. */
  test("an org project's tasks are listed when acting in that org", async () => {
    expect(await titles(await list(cookie, "", ORG))).toContain("org task");
  });

  test("filtering by an org project returns its tasks", async () => {
    const out = await titles(await list(cookie, "?projectId=p-org", ORG));
    expect(out).toEqual(["org task"]);
  });

  /* Acting in an org scope means the org's work, not a merge of both — the
     switcher is what decides which set of tasks the interface is showing. */
  test("the org scope does not mix in the actor's personal tasks", async () => {
    expect(await titles(await list(cookie, "", ORG))).not.toContain("personal task");
  });

  test("the personal scope does not leak the org's tasks", async () => {
    expect(await titles(await list(cookie))).not.toContain("org task");
  });

  /* The header is verified against membership upstream, so claiming an org
     the actor does not belong to falls back to their own scope rather than
     granting anything. */
  test("a non-member naming the org gets nothing of the org's", async () => {
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
    const out = await titles(await list(strangerCookie, "", ORG));
    expect(out).not.toContain("org task");
    expect(out).not.toContain("personal task");
  });
});
