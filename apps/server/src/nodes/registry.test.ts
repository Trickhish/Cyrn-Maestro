import { expect, test, describe, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { newId } from "@maestro/protocol";
import { db, schema } from "../db";
import { resetDatabase } from "../test/harness";
import {
  handleNodeMessage,
  handleDisconnect,
  createEnrollmentToken,
  revokeNode,
  onlineNodes,
  resetRegistry,
  awaitResult,
  subscribeToTask,
  loadOf,
  noteAssigned,
  noteReleased,
  type SocketSession,
} from "./registry";

/* A socket that records what the server sent it. */
function fakeSocket() {
  const sent: any[] = [];
  let closed = false;
  return {
    sent,
    get closed() {
      return closed;
    },
    send: (data: string) => sent.push(JSON.parse(data)),
    close: () => {
      closed = true;
    },
    last: () => sent[sent.length - 1],
    ofType: (type: string) => sent.find((m) => m.type === type),
  };
}

const identity = {
  name: "test-node",
  os: "linux",
  arch: "x64",
  version: "0.1.0",
  maxConcurrentTasks: 2,
  capabilities: ["bash"],
  workspaces: [],
};

const OWNER = "owner-id";

beforeEach(async () => {
  resetDatabase();
  resetRegistry();
  await db.insert(schema.users).values({
    id: OWNER,
    email: "owner@x.com",
    passwordHash: "x",
    instanceRole: "instance_admin",
    status: "active",
    createdAt: Date.now(),
  });
});

async function enrolled() {
  const token = await createEnrollmentToken({ ownerUserId: OWNER }, null);
  const socket = fakeSocket();
  const session: SocketSession = {};
  await handleNodeMessage(
    session,
    socket,
    JSON.stringify({ type: "node.enroll", id: newId(), enrollmentToken: token, node: identity }),
  );
  return { token, socket, session };
}

describe("enrollment", () => {
  test("exchanges the enrollment token for a durable one", async () => {
    const { socket, session } = await enrolled();

    const enrolledMsg = socket.ofType("node.enrolled");
    expect(enrolledMsg).toBeDefined();
    expect(enrolledMsg.nodeToken).toBeTruthy();
    expect(session.nodeId).toBeTruthy();
    expect(socket.ofType("node.registered")).toBeDefined();
  });

  /* The property that makes a curl|sh install command safe to leave in shell
     history: the token is worthless the moment it has been used. */
  test("an enrollment token cannot be used twice", async () => {
    const token = await createEnrollmentToken({ ownerUserId: OWNER }, null);

    const first = fakeSocket();
    await handleNodeMessage({}, first, JSON.stringify({ type: "node.enroll", id: newId(), enrollmentToken: token, node: identity }));
    expect(first.ofType("node.enrolled")).toBeDefined();

    const second = fakeSocket();
    await handleNodeMessage({}, second, JSON.stringify({ type: "node.enroll", id: newId(), enrollmentToken: token, node: identity }));
    expect(second.last().type).toBe("node.rejected");
    expect(second.last().reason).toBe("token_used");
    expect(second.closed).toBe(true);
  });

  test("an expired token is refused", async () => {
    const token = await createEnrollmentToken({ ownerUserId: OWNER }, null);
    await db
      .update(schema.enrollmentTokens)
      .set({ expiresAt: Date.now() - 1000 })
      .where(eq(schema.enrollmentTokens.ownerUserId, OWNER));

    const socket = fakeSocket();
    await handleNodeMessage({}, socket, JSON.stringify({ type: "node.enroll", id: newId(), enrollmentToken: token, node: identity }));
    expect(socket.last().reason).toBe("expired_token");
  });

  test("an unknown token is refused", async () => {
    const socket = fakeSocket();
    await handleNodeMessage({}, socket, JSON.stringify({ type: "node.enroll", id: newId(), enrollmentToken: "nk_nope", node: identity }));
    expect(socket.last().reason).toBe("bad_token");
  });

  test("the durable token is stored hashed, not in the clear", async () => {
    const { socket } = await enrolled();
    const issued = socket.ofType("node.enrolled").nodeToken;

    const [row] = await db.select().from(schema.nodes).limit(1);
    expect(row.tokenHash).not.toBe(issued);
    expect(row.tokenHash).not.toContain(issued);
  });
});

describe("registration", () => {
  test("a stored token reconnects the node", async () => {
    const { socket } = await enrolled();
    const nodeToken = socket.ofType("node.enrolled").nodeToken;

    const reconnect = fakeSocket();
    const session: SocketSession = {};
    await handleNodeMessage(session, reconnect, JSON.stringify({ type: "node.register", id: newId(), nodeToken, node: identity, runningTaskIds: [] }));

    expect(reconnect.ofType("node.registered")).toBeDefined();
    expect(onlineNodes({ ownerUserId: OWNER })).toHaveLength(1);
  });

  test("a forged node token is refused", async () => {
    const socket = fakeSocket();
    await handleNodeMessage({}, socket, JSON.stringify({ type: "node.register", id: newId(), nodeToken: "made-up", node: identity, runningTaskIds: [] }));
    expect(socket.last().reason).toBe("bad_token");
    expect(socket.closed).toBe(true);
  });

  /* Leaving both sockets registered would let the router dispatch work down a
     connection that is already gone. */
  test("reconnecting replaces the previous socket rather than duplicating", async () => {
    const { socket } = await enrolled();
    const nodeToken = socket.ofType("node.enrolled").nodeToken;

    const second = fakeSocket();
    await handleNodeMessage({}, second, JSON.stringify({ type: "node.register", id: newId(), nodeToken, node: identity, runningTaskIds: [] }));

    expect(onlineNodes({ ownerUserId: OWNER })).toHaveLength(1);
    expect(socket.closed).toBe(true);
  });

  test("running tasks are reported so the server can re-attach", async () => {
    const { socket } = await enrolled();
    const nodeToken = socket.ofType("node.enrolled").nodeToken;

    const second = fakeSocket();
    await handleNodeMessage({}, second, JSON.stringify({ type: "node.register", id: newId(), nodeToken, node: identity, runningTaskIds: ["task-1"] }));

    expect([...onlineNodes({ ownerUserId: OWNER })[0].reported]).toEqual(["task-1"]);
  });
});

describe("unauthenticated sockets", () => {
  /* Without this check, a socket that never authenticated could inject tool
     results into somebody else's running task. */
  test("cannot send anything before registering", async () => {
    const socket = fakeSocket();
    const session: SocketSession = {};

    await handleNodeMessage(
      session,
      socket,
      JSON.stringify({ type: "tool.result", id: newId(), taskId: "t", callId: "c", ok: true, output: "injected" }),
    );

    expect(socket.last().type).toBe("node.rejected");
    expect(socket.closed).toBe(true);
  });

  test("a malformed frame is rejected without crashing", async () => {
    const socket = fakeSocket();
    await handleNodeMessage({}, socket, "not json at all");
    expect(socket.last().type).toBe("node.rejected");
  });
});

describe("routing replies back to the waiting loop", () => {
  async function connected() {
    const { socket, session } = await enrolled();
    return { socket, session };
  }

  test("a tool result reaches the handler waiting on that call", async () => {
    const { session, socket } = await connected();
    void socket;

    let got: any;
    awaitResult("call-1", (m) => (got = m));

    await handleNodeMessage(
      session,
      fakeSocket(),
      JSON.stringify({ type: "tool.result", id: newId(), taskId: "t1", callId: "call-1", ok: true, output: "done" }),
    );

    expect(got?.type).toBe("tool.result");
  });

  /* The bug this pins: task.log also carries a callId. Routing it to the
     waiting handler consumed the registration, so the tool.result that
     followed found nothing and the task hung in "running" forever, with no
     error in any log. */
  test("a log frame does not consume the handler waiting for the result", async () => {
    const { session } = await connected();

    const seen: string[] = [];
    awaitResult("call-2", (m) => seen.push(m.type));

    await handleNodeMessage(
      session,
      fakeSocket(),
      JSON.stringify({ type: "task.log", id: newId(), taskId: "t1", callId: "call-2", stream: "stdout", chunk: "output\n" }),
    );
    await handleNodeMessage(
      session,
      fakeSocket(),
      JSON.stringify({ type: "tool.result", id: newId(), taskId: "t1", callId: "call-2", ok: true, output: "done" }),
    );

    expect(seen).toEqual(["tool.result"]);
  });

  test("log frames still reach task subscribers", async () => {
    const { session } = await connected();

    const seen: string[] = [];
    subscribeToTask("t1", (m) => seen.push(m.type));

    await handleNodeMessage(
      session,
      fakeSocket(),
      JSON.stringify({ type: "task.log", id: newId(), taskId: "t1", callId: "c", stream: "stdout", chunk: "x" }),
    );

    expect(seen).toEqual(["task.log"]);
  });

  /* An approval request pauses the call rather than ending it — the same
     callId is re-issued once a human decides, so the registration has to
     survive until a real result arrives. */
  test("an approval request does not end the call", async () => {
    const { session } = await connected();

    const seen: string[] = [];
    awaitResult("call-3", (m) => seen.push(m.type));

    await handleNodeMessage(
      session,
      fakeSocket(),
      JSON.stringify({
        type: "tool.approval_request", id: newId(), taskId: "t1", callId: "call-3",
        tool: "bash", summary: "rm x", reason: "policy_ask",
      }),
    );
    await handleNodeMessage(
      session,
      fakeSocket(),
      JSON.stringify({ type: "tool.result", id: newId(), taskId: "t1", callId: "call-3", ok: true, output: "ok" }),
    );

    expect(seen).toEqual(["tool.approval_request", "tool.result"]);
  });
});

/* Dispatch has to see an assignment made a second ago. Choosing a node from
   heartbeat data — up to 20 seconds stale — makes every node look idle in the
   gap, so tasks dispatched back to back all pile onto whichever sorts first
   while the rest of the fleet sits doing nothing. */
describe("capacity accounting", () => {
  test("an assignment counts immediately, before any heartbeat", async () => {
    const { session } = await enrolled();
    const node = onlineNodes({ ownerUserId: OWNER })[0];

    expect(loadOf(node)).toBe(0);
    noteAssigned(session.nodeId!, "t1");
    expect(loadOf(node)).toBe(1);
    noteAssigned(session.nodeId!, "t2");
    expect(loadOf(node)).toBe(2);
  });

  test("releasing frees the slot immediately", async () => {
    const { session } = await enrolled();
    const node = onlineNodes({ ownerUserId: OWNER })[0];

    noteAssigned(session.nodeId!, "t1");
    noteReleased(session.nodeId!, "t1");
    expect(loadOf(node)).toBe(0);
  });

  /* A heartbeat is a snapshot from the past. It may drop a task the node has
     finished, but it must never wipe an assignment made since it was sent. */
  test("a heartbeat does not erase an assignment made after it", async () => {
    const { session } = await enrolled();
    const node = onlineNodes({ ownerUserId: OWNER })[0];

    noteAssigned(session.nodeId!, "t-old");
    noteAssigned(session.nodeId!, "t-new");

    /* The node reports only t-old and t-new — both still running. */
    await handleNodeMessage(
      session,
      fakeSocket(),
      JSON.stringify({ type: "node.heartbeat", id: newId(), runningTaskIds: ["t-old", "t-new"] }),
    );

    expect(loadOf(node)).toBe(2);
  });

  test("a heartbeat drops a task the node has finished", async () => {
    const { session } = await enrolled();
    const node = onlineNodes({ ownerUserId: OWNER })[0];

    noteAssigned(session.nodeId!, "t-done");
    noteAssigned(session.nodeId!, "t-live");

    await handleNodeMessage(
      session,
      fakeSocket(),
      JSON.stringify({ type: "node.heartbeat", id: newId(), runningTaskIds: ["t-live"] }),
    );

    expect(loadOf(node)).toBe(1);
    expect([...node.assigned]).toEqual(["t-live"]);
  });
});

describe("revocation and disconnect", () => {
  test("revoking drops the live socket immediately", async () => {
    const { socket, session } = await enrolled();
    expect(onlineNodes({ ownerUserId: OWNER })).toHaveLength(1);

    const ok = await revokeNode(session.nodeId!, { ownerUserId: OWNER });
    expect(ok).toBe(true);
    expect(socket.closed).toBe(true);
    expect(onlineNodes({ ownerUserId: OWNER })).toHaveLength(0);
  });

  test("a revoked node cannot register again", async () => {
    const { socket, session } = await enrolled();
    const nodeToken = socket.ofType("node.enrolled").nodeToken;
    await revokeNode(session.nodeId!, { ownerUserId: OWNER });

    const retry = fakeSocket();
    await handleNodeMessage({}, retry, JSON.stringify({ type: "node.register", id: newId(), nodeToken, node: identity, runningTaskIds: [] }));
    expect(retry.last().reason).toBe("revoked");
  });

  test("another user cannot revoke your node", async () => {
    const { session } = await enrolled();
    expect(await revokeNode(session.nodeId!, { ownerUserId: "someone-else" })).toBe(false);
  });

  test("disconnecting marks the node offline", async () => {
    const { session } = await enrolled();
    await handleDisconnect(session);

    expect(onlineNodes({ ownerUserId: OWNER })).toHaveLength(0);
    const [row] = await db.select().from(schema.nodes).limit(1);
    expect(row.status).toBe("offline");
  });

  /* revokeNode() closes the node's own socket, and that close is exactly what
     fires the server's disconnect handler in production — the two run in the
     same sequence the real server produces, unlike the tests above which
     exercise each in isolation. handleDisconnect() must not be allowed to
     downgrade "revoked" back to "offline", or the durable token stays live and
     the daemon's own reconnect re-registers the node a moment later: revoking
     it visibly does nothing. */
  test("a disconnect fired by the revocation itself does not undo it", async () => {
    const { socket, session } = await enrolled();
    const nodeToken = socket.ofType("node.enrolled").nodeToken;

    await revokeNode(session.nodeId!, { ownerUserId: OWNER });
    await handleDisconnect(session);

    const [row] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, session.nodeId!));
    expect(row.status).toBe("revoked");

    const retry = fakeSocket();
    await handleNodeMessage(
      {},
      retry,
      JSON.stringify({ type: "node.register", id: newId(), nodeToken, node: identity, runningTaskIds: [] }),
    );
    expect(retry.last().reason).toBe("revoked");
  });

  test("an ordinary disconnect still marks the node offline, not revoked", async () => {
    const { session } = await enrolled();
    await handleDisconnect(session);

    const [row] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, session.nodeId!));
    expect(row.status).toBe("offline");
  });
});
