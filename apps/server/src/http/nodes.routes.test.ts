import { expect, test, describe, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { newId } from "@maestro/protocol";
import { app } from "../app";
import { db, schema } from "../db";
import { resetDatabase, jsonPost, cookieFrom, body, signedInOwner } from "../test/harness";
import { hashPassword } from "../lib/crypto";
import { handleNodeMessage, resetRegistry, type SocketSession } from "../nodes/registry";

/* Renaming a node, and the HTTP surface of the revoke path this rename route
 * sits next to. Renaming is a label on the record — it must not touch the
 * daemon, its token, or what a node currently believes about itself. */

const PASSWORD = "a-long-enough-password";
let ownerCookie: string;
let ownerId: string;
let nodeId: string;

const withCookie = (cookie: string, init: RequestInit = {}) => ({
  ...init,
  headers: { ...(init.headers ?? {}), cookie },
});

function fakeSocket() {
  const sent: any[] = [];
  return {
    sent,
    send: (data: string) => sent.push(JSON.parse(data)),
    close: () => {},
    ofType: (type: string) => sent.find((m) => m.type === type),
  };
}

beforeEach(async () => {
  resetDatabase();
  resetRegistry();

  const owner = await signedInOwner(app as never);
  ownerCookie = owner.cookie;
  ownerId = owner.actor.id;

  /* A real enrolled node, not a row inserted by hand, so the live registry
     entry exists too — that is what a rename has to reach as well as the row. */
  const enrollRes = await app.request("/api/nodes/enroll", withCookie(ownerCookie, jsonPost({})));
  const { token } = await body<{ token: string }>(enrollRes);

  const socket = fakeSocket();
  const session: SocketSession = {};
  await handleNodeMessage(
    session,
    socket,
    JSON.stringify({
      type: "node.enroll",
      id: newId(),
      enrollmentToken: token,
      node: {
        name: "install-time-name",
        os: "linux",
        arch: "x64",
        version: "0.1.0",
        maxConcurrentTasks: 2,
        capabilities: ["bash"],
        workspaces: [],
      },
    }),
  );
  nodeId = session.nodeId!;
});

const rename = (cookie: string, id: string, name: string) =>
  app.request(`/api/nodes/${id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });

describe("renaming a node", () => {
  test("changes the name shown in the list", async () => {
    const res = await rename(ownerCookie, nodeId, "build-box");
    expect(res.status).toBe(200);

    const list = await body(await app.request("/api/nodes", withCookie(ownerCookie)));
    expect(list.nodes.find((n: { id: string }) => n.id === nodeId).name).toBe("build-box");
  });

  test("does not touch the node's token", async () => {
    const [before] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId));
    await rename(ownerCookie, nodeId, "build-box");
    const [after] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId));

    expect(after.tokenHash).toBe(before.tokenHash);
    expect(after.status).toBe(before.status);
  });

  test("trims the name and rejects an empty one", async () => {
    expect((await rename(ownerCookie, nodeId, "   spaced   ")).status).toBe(200);
    const list = await body(await app.request("/api/nodes", withCookie(ownerCookie)));
    expect(list.nodes.find((n: { id: string }) => n.id === nodeId).name).toBe("spaced");

    expect((await rename(ownerCookie, nodeId, "   ")).status).toBe(400);
  });

  test("records it in the audit log", async () => {
    await rename(ownerCookie, nodeId, "build-box");
    const entries = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "node.renamed"));
    expect(entries).toHaveLength(1);
  });

  test("a signed-out request is refused", async () => {
    expect((await app.request(`/api/nodes/${nodeId}`, { method: "PATCH" })).status).toBe(401);
  });

  test("someone who does not own the node cannot rename it", async () => {
    await db.insert(schema.users).values({
      id: crypto.randomUUID(),
      email: "outsider@example.com",
      passwordHash: await hashPassword(PASSWORD),
      instanceRole: "user",
      status: "active",
      createdAt: Date.now(),
    });
    const outsiderCookie = cookieFrom(
      await app.request("/api/auth/login", jsonPost({ email: "outsider@example.com", password: PASSWORD })),
    );

    const res = await rename(outsiderCookie, nodeId, "hijacked");
    expect(res.status).toBe(404);

    const list = await body(await app.request("/api/nodes", withCookie(ownerCookie)));
    expect(list.nodes.find((n: { id: string }) => n.id === nodeId).name).toBe("install-time-name");
  });

  test("a node that does not exist is a 404", async () => {
    expect((await rename(ownerCookie, "no-such-node", "x")).status).toBe(404);
  });

  void ownerId;
});
