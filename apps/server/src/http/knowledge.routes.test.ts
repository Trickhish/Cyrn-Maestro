import { expect, test, describe, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../app";
import { db, schema } from "../db";
import { resetDatabase, jsonPost, cookieFrom, body, signedInOwner } from "../test/harness";
import { hashPassword } from "../lib/crypto";

/* The HTTP surface for project knowledge — the settings-UI side of the same
 * store the agent's tools write to. Mostly about the boundary: someone who
 * cannot reach a project must not read or change what it knows, and a
 * workspace path must not be pointable at a machine belonging to someone
 * else. */

const PASSWORD = "a-long-enough-password";

let ownerCookie: string;
let projectId: string;
let nodeId: string;
let otherOwnerNodeId: string;

const withCookie = (cookie: string, init: RequestInit = {}) => ({
  ...init,
  headers: { ...(init.headers ?? {}), cookie },
});

beforeEach(async () => {
  resetDatabase();

  const owner = await signedInOwner(app as never);
  ownerCookie = owner.cookie;

  const projRes = await app.request(
    "/api/projects",
    withCookie(ownerCookie, jsonPost({ name: "AI Novel" })),
  );
  projectId = (await body(projRes)).project.id;

  /* A real node row, owned by the same user, so a workspace path can be
     legitimately set against it. */
  nodeId = crypto.randomUUID();
  await db.insert(schema.nodes).values({
    id: nodeId,
    ownerUserId: owner.actor.id,
    ownerOrgId: null,
    name: "MAIN.SRV",
    tokenHash: "hash",
    status: "online",
    os: "linux",
    arch: "x64",
    version: "0.1.0",
    capabilities: [],
    maxConcurrentTasks: 2,
    lastSeenAt: Date.now(),
    createdAt: Date.now(),
  });

  /* A node owned by someone else entirely, to prove it cannot be targeted. */
  const strangerId = crypto.randomUUID();
  await db.insert(schema.users).values({
    id: strangerId,
    email: "stranger-owner@example.com",
    passwordHash: await hashPassword(PASSWORD),
    instanceRole: "user",
    status: "active",
    createdAt: Date.now(),
  });
  otherOwnerNodeId = crypto.randomUUID();
  await db.insert(schema.nodes).values({
    id: otherOwnerNodeId,
    ownerUserId: strangerId,
    ownerOrgId: null,
    name: "someone-elses-box",
    tokenHash: "hash2",
    status: "online",
    os: "linux",
    arch: "x64",
    version: "0.1.0",
    capabilities: [],
    maxConcurrentTasks: 2,
    lastSeenAt: Date.now(),
    createdAt: Date.now(),
  });
});

const get = (cookie: string, query: string) =>
  app.request(`/api/knowledge?${query}`, withCookie(cookie));

const putBrief = (cookie: string, payload: unknown) =>
  app.request("/api/knowledge/brief", withCookie(cookie, { ...jsonPost(payload), method: "PUT" }));

const putWorkspace = (cookie: string, payload: unknown) =>
  app.request("/api/knowledge/workspace", withCookie(cookie, { ...jsonPost(payload), method: "PUT" }));

const postFact = (cookie: string, payload: unknown) =>
  app.request("/api/knowledge/facts", withCookie(cookie, jsonPost(payload)));

const postMemory = (cookie: string, payload: unknown) =>
  app.request("/api/knowledge/memories", withCookie(cookie, jsonPost(payload)));

const del = (cookie: string, id: string) =>
  app.request(`/api/knowledge/notes/${id}`, withCookie(cookie, { method: "DELETE" }));

describe("reading knowledge", () => {
  test("an empty project reads back empty", async () => {
    const res = await get(ownerCookie, `projectId=${projectId}`);
    expect(res.status).toBe(200);

    const knowledge = await body(res);
    expect(knowledge.brief).toBeNull();
    expect(knowledge.workspaces).toEqual([]);
    expect(knowledge.notes).toEqual([]);
  });

  test("needs a projectId", async () => {
    expect((await get(ownerCookie, "")).status).toBe(400);
  });

  test("a project that does not exist is a 404", async () => {
    expect((await get(ownerCookie, "projectId=nope")).status).toBe(404);
  });
});

describe("the brief", () => {
  test("can be set and read back", async () => {
    expect((await putBrief(ownerCookie, { projectId, text: "A narrative generator." })).status).toBe(200);
    expect((await body(await get(ownerCookie, `projectId=${projectId}`))).brief).toBe(
      "A narrative generator.",
    );
  });

  test("null clears it", async () => {
    await putBrief(ownerCookie, { projectId, text: "something" });
    await putBrief(ownerCookie, { projectId, text: null });
    expect((await body(await get(ownerCookie, `projectId=${projectId}`))).brief).toBeNull();
  });
});

describe("the workspace path", () => {
  test("registers it against a real, owned node", async () => {
    const res = await putWorkspace(ownerCookie, {
      projectId,
      nodeId,
      path: "/root/prog/ai_novel",
    });
    expect(res.status).toBe(200);

    const knowledge = await body(await get(ownerCookie, `projectId=${projectId}`));
    expect(knowledge.workspaces).toEqual([
      expect.objectContaining({ nodeId, nodeName: "MAIN.SRV", path: "/root/prog/ai_novel" }),
    ]);
  });

  /* The one that matters most: this field points an agent at a filesystem, so
     it must not be settable against a machine outside the project's own
     tenancy. */
  test("refuses a node belonging to a different owner", async () => {
    const res = await putWorkspace(ownerCookie, {
      projectId,
      nodeId: otherOwnerNodeId,
      path: "/etc",
    });
    expect(res.status).toBe(400);
    expect((await body(await get(ownerCookie, `projectId=${projectId}`))).workspaces).toEqual([]);
  });

  test("a node that does not exist at all is refused the same way", async () => {
    expect((await putWorkspace(ownerCookie, { projectId, nodeId: "nope", path: "/x" })).status).toBe(404);
  });
});

describe("facts", () => {
  test("creates one", async () => {
    const res = await postFact(ownerCookie, {
      projectId,
      kind: "directory",
      label: "assets",
      value: "/root/prog/ai_novel/assets",
      nodeId,
    });
    expect(res.status).toBe(201);

    const notes = (await body(await get(ownerCookie, `projectId=${projectId}`))).notes;
    expect(notes[0]).toMatchObject({ kind: "directory", label: "assets" });
  });

  test("also refuses a node from a different owner", async () => {
    const res = await postFact(ownerCookie, {
      projectId,
      kind: "directory",
      label: "assets",
      value: "/etc",
      nodeId: otherOwnerNodeId,
    });
    expect(res.status).toBe(400);
  });

  test("rejects an unknown kind", async () => {
    const res = await postFact(ownerCookie, { projectId, kind: "database", label: "x", value: "y" });
    expect(res.status).toBe(400);
  });
});

describe("memories", () => {
  test("adds one", async () => {
    const res = await postMemory(ownerCookie, { projectId, text: "Uses Postgres." });
    expect(res.status).toBe(201);
    expect((await body(await get(ownerCookie, `projectId=${projectId}`))).notes).toHaveLength(1);
  });
});

describe("deleting a note", () => {
  test("removes it", async () => {
    const { id } = await body(await postMemory(ownerCookie, { projectId, text: "temp" }));
    expect((await del(ownerCookie, id)).status).toBe(200);
    expect((await body(await get(ownerCookie, `projectId=${projectId}`))).notes).toEqual([]);
  });

  test("a note that does not exist is a 404", async () => {
    expect((await del(ownerCookie, "no-such-id")).status).toBe(404);
  });
});

describe("permission boundary", () => {
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

  test("someone outside the project cannot read its knowledge", async () => {
    expect((await get(strangerCookie, `projectId=${projectId}`)).status).toBe(404);
  });

  test("or write its brief", async () => {
    expect((await putBrief(strangerCookie, { projectId, text: "hijacked" })).status).toBe(404);
    expect((await body(await get(ownerCookie, `projectId=${projectId}`))).brief).toBeNull();
  });

  test("or set its workspace path", async () => {
    const res = await putWorkspace(strangerCookie, { projectId, nodeId, path: "/hijacked" });
    expect(res.status).toBe(404);
  });

  test("or delete one of its notes", async () => {
    const { id } = await body(await postMemory(ownerCookie, { projectId, text: "mine" }));
    expect((await del(strangerCookie, id)).status).toBe(404);
  });
});

describe("audit trail", () => {
  test("records a brief change", async () => {
    await putBrief(ownerCookie, { projectId, text: "x" });
    const entries = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "project.brief_changed"));
    expect(entries).toHaveLength(1);
  });

  test("records a workspace path change", async () => {
    await putWorkspace(ownerCookie, { projectId, nodeId, path: "/x" });
    const entries = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "project.workspace_set"));
    expect(entries).toHaveLength(1);
  });
});
