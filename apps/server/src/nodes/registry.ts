import { and, eq, ne } from "drizzle-orm";
import { NodeMessage, newId, type ServerMessage, type NodeIdentity } from "@maestro/protocol";
import { db, schema } from "../db";
import { config } from "../config";
import { newToken, hashToken } from "../lib/crypto";

/* The live node registry.
 *
 * Sockets are process state, not database state: a node is "online" because a
 * socket is open right now, and that fact does not survive a restart. The
 * database holds identity and the last-seen time; this map holds the
 * connection. Conflating the two is how a fleet view ends up confidently
 * listing nodes that went away hours ago. */

export interface LiveNode {
  nodeId: string;
  name: string;
  ownerUserId: string | null;
  ownerOrgId: string | null;
  socket: { send(data: string): void; close(): void };
  /* Two views of the same thing, deliberately kept apart.
   *
   * `assigned` is what the server has dispatched and not yet released. It is
   * updated the instant a task is sent, so it is the only correct basis for a
   * capacity decision — dispatching two tasks a second apart must see the
   * first one.
   *
   * `reported` is what the node said at its last heartbeat, up to 20 seconds
   * stale. Using it to choose a node makes every node look idle in the gap,
   * and every task piles onto whichever sorts first. It is kept for display
   * and for spotting drift between the two. */
  assigned: Set<string>;
  reported: Set<string>;
  lastSeenAt: number;
  maxConcurrentTasks: number;
}

/* What a capacity check should use. */
export function loadOf(node: LiveNode): number {
  return node.assigned.size;
}

export function noteAssigned(nodeId: string, taskId: string): void {
  live.get(nodeId)?.assigned.add(taskId);
}

export function noteReleased(nodeId: string, taskId: string): void {
  live.get(nodeId)?.assigned.delete(taskId);
}

const live = new Map<string, LiveNode>();

/* Routed by callId so a reply reaches the loop waiting for it. */
type ResultHandler = (message: NodeMessage) => void;
const waiting = new Map<string, ResultHandler>();
const taskSubscribers = new Map<string, Set<ResultHandler>>();

/* Node ownership mirrors project ownership. An org's node hosts only that
   org's projects, and a personal node only its owner's — so an organization's
   source is never checked out onto a machine the organization does not
   control, and a member's laptop never silently becomes org infrastructure. */
export function onlineNodes(owner: { ownerUserId?: string | null; ownerOrgId?: string | null }): LiveNode[] {
  return [...live.values()].filter((n) =>
    owner.ownerOrgId ? n.ownerOrgId === owner.ownerOrgId : n.ownerUserId === owner.ownerUserId,
  );
}

export function getLiveNode(nodeId: string): LiveNode | undefined {
  return live.get(nodeId);
}

/* The name in the database is renamed by a person; the name here is what the
   daemon announced at connect, and everything mid-flight — a routing decision,
   a task's "assigned to" — reads the live one, not the row. Without this, a
   rename would not show up in either place until the node happened to
   reconnect on its own. */
export function renameLiveNode(nodeId: string, name: string): void {
  const node = live.get(nodeId);
  if (node) node.name = name;
}

export function sendToNode(nodeId: string, message: ServerMessage): boolean {
  const node = live.get(nodeId);
  if (!node) return false;
  node.socket.send(JSON.stringify(message));
  return true;
}

/* The loop awaits a specific tool result; task-level subscribers see every
   frame for a task, which is what drives the live log stream. */
export function awaitResult(callId: string, handler: ResultHandler): () => void {
  waiting.set(callId, handler);
  return () => waiting.delete(callId);
}

export function subscribeToTask(taskId: string, handler: ResultHandler): () => void {
  const set = taskSubscribers.get(taskId) ?? new Set();
  set.add(handler);
  taskSubscribers.set(taskId, set);
  return () => {
    set.delete(handler);
    if (set.size === 0) taskSubscribers.delete(taskId);
  };
}

/* Only these two conclude a pending tool call. task.log also carries a callId,
   and routing it here would hand the waiting handler a frame it ignores — while
   consuming the registration, so the real tool.result that follows finds no
   handler and the task hangs forever with no error anywhere. */
const RESOLVES_A_CALL = new Set(["tool.result", "tool.approval_request"]);

function dispatch(message: NodeMessage): void {
  const callId = "callId" in message ? message.callId : undefined;

  if (callId && RESOLVES_A_CALL.has(message.type)) {
    const handler = waiting.get(callId);
    if (handler) {
      /* An approval request does not end the call: the same callId is
         re-issued once a human decides, so the handler must stay registered
         until a result actually arrives. */
      if (message.type === "tool.result") waiting.delete(callId);
      handler(message);
    }
  }

  const taskId = "taskId" in message ? message.taskId : undefined;
  if (taskId) {
    for (const handler of taskSubscribers.get(taskId) ?? []) handler(message);
  }
}

/* ------------------------------------------------------------------ session */

export interface SocketSession {
  nodeId?: string;
}

export async function handleNodeMessage(
  session: SocketSession,
  socket: { send(data: string): void; close(): void },
  raw: string,
): Promise<void> {
  const parsed = NodeMessage.safeParse(safeJson(raw));
  if (!parsed.success) {
    socket.send(
      JSON.stringify({
        type: "node.rejected",
        id: newId(),
        reason: "version_mismatch",
        detail: "The server could not understand that frame.",
      } satisfies ServerMessage),
    );
    return;
  }

  const message = parsed.data;

  switch (message.type) {
    case "node.enroll":
      await enroll(session, socket, message.enrollmentToken, message.node);
      return;

    case "node.register":
      await register(session, socket, message.nodeToken, message.node, message.runningTaskIds);
      return;

    default: {
      /* Everything else requires an identified node. Without this check a
         socket that never authenticated could inject tool results into a
         running task. */
      if (!session.nodeId) {
        socket.send(
          JSON.stringify({
            type: "node.rejected",
            id: newId(),
            reason: "bad_token",
            detail: "Register before sending anything else.",
          } satisfies ServerMessage),
        );
        socket.close();
        return;
      }

      const node = live.get(session.nodeId);
      if (node) {
        node.lastSeenAt = Date.now();
        if (message.type === "node.heartbeat") {
          node.reported = new Set(message.runningTaskIds);
          /* Drop anything the node no longer reports: a task it finished, or
             one lost to a restart. Never add from here — an assignment made
             since the heartbeat was sent would be wiped. */
          for (const taskId of node.assigned) {
            if (!node.reported.has(taskId)) node.assigned.delete(taskId);
          }
          await db
            .update(schema.nodes)
            .set({ lastSeenAt: Date.now(), loadPercent: message.loadPercent ?? null })
            .where(eq(schema.nodes.id, session.nodeId));
          return;
        }
      }

      dispatch(message);
    }
  }
}

async function enroll(
  session: SocketSession,
  socket: { send(data: string): void; close(): void },
  enrollmentToken: string,
  identity: NodeIdentity,
): Promise<void> {
  const [row] = await db
    .select()
    .from(schema.enrollmentTokens)
    .where(eq(schema.enrollmentTokens.tokenHash, hashToken(enrollmentToken)))
    .limit(1);

  const reject = (reason: "bad_token" | "expired_token" | "token_used") => {
    socket.send(JSON.stringify({ type: "node.rejected", id: newId(), reason } satisfies ServerMessage));
    socket.close();
  };

  if (!row) return reject("bad_token");
  /* Single use and short-lived: this is what makes a curl|sh install command
     safe to leave in shell history. */
  if (row.usedAt) return reject("token_used");
  if (row.expiresAt < Date.now()) return reject("expired_token");

  const nodeToken = newToken();
  const nodeId = crypto.randomUUID();

  await db.insert(schema.nodes).values({
    id: nodeId,
    ownerUserId: row.ownerUserId,
    ownerOrgId: row.ownerOrgId,
    name: identity.name,
    tokenHash: hashToken(nodeToken),
    status: "online",
    os: identity.os,
    arch: identity.arch,
    version: identity.version,
    capabilities: identity.capabilities,
    maxConcurrentTasks: identity.maxConcurrentTasks,
    lastSeenAt: Date.now(),
    createdAt: Date.now(),
  });

  await db
    .update(schema.enrollmentTokens)
    .set({ usedAt: Date.now() })
    .where(eq(schema.enrollmentTokens.id, row.id));

  session.nodeId = nodeId;
  live.set(nodeId, {
    nodeId,
    name: identity.name,
    ownerUserId: row.ownerUserId,
    ownerOrgId: row.ownerOrgId,
    socket,
    assigned: new Set(),
    reported: new Set(),
    lastSeenAt: Date.now(),
    maxConcurrentTasks: identity.maxConcurrentTasks,
  });

  socket.send(JSON.stringify({ type: "node.enrolled", id: newId(), nodeId, nodeToken } satisfies ServerMessage));
  socket.send(
    JSON.stringify({
      type: "node.registered",
      id: newId(),
      nodeId,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
    } satisfies ServerMessage),
  );
}

async function register(
  session: SocketSession,
  socket: { send(data: string): void; close(): void },
  nodeToken: string,
  identity: NodeIdentity,
  runningTaskIds: string[],
): Promise<void> {
  const [row] = await db
    .select()
    .from(schema.nodes)
    .where(eq(schema.nodes.tokenHash, hashToken(nodeToken)))
    .limit(1);

  if (!row || row.status === "revoked") {
    socket.send(
      JSON.stringify({
        type: "node.rejected",
        id: newId(),
        reason: row ? "revoked" : "bad_token",
      } satisfies ServerMessage),
    );
    socket.close();
    return;
  }

  /* A reconnect from the same node replaces the old entry. Leaving both would
     let the router dispatch down a socket that is already gone. */
  live.get(row.id)?.socket.close();

  session.nodeId = row.id;
  live.set(row.id, {
    nodeId: row.id,
    name: identity.name,
    ownerUserId: row.ownerUserId,
    ownerOrgId: row.ownerOrgId,
    socket,
    /* A reconnecting node still believes it is running these; trust it until
       reconciliation says otherwise, so its slots are not double-booked. */
    assigned: new Set(runningTaskIds),
    reported: new Set(runningTaskIds),
    lastSeenAt: Date.now(),
    maxConcurrentTasks: identity.maxConcurrentTasks,
  });

  await db
    .update(schema.nodes)
    .set({
      status: "online",
      lastSeenAt: Date.now(),
      os: identity.os,
      arch: identity.arch,
      version: identity.version,
      capabilities: identity.capabilities,
      maxConcurrentTasks: identity.maxConcurrentTasks,
    })
    .where(eq(schema.nodes.id, row.id));

  socket.send(
    JSON.stringify({
      type: "node.registered",
      id: newId(),
      nodeId: row.id,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
    } satisfies ServerMessage),
  );

  /* The node may still believe it is running tasks whose loops died with a
     previous server process. Reconcile now, or it holds those slots until it
     restarts. Imported lazily to keep this module free of a cycle through the
     runner. */
  if (runningTaskIds.length > 0) {
    const { reconcileNode } = await import("../tasks/recovery");
    await reconcileNode(row.id, runningTaskIds);
  }
}

export async function handleDisconnect(session: SocketSession): Promise<void> {
  if (!session.nodeId) return;
  live.delete(session.nodeId);
  /* Revoking a node closes its socket itself, which fires this same handler —
     and revocation must win that race. Without the guard, "offline" overwrites
     "revoked" here, the durable token is still valid, and the daemon's own
     reconnect re-registers it a moment later: the node comes straight back,
     which reads as revoke not working at all. */
  await db
    .update(schema.nodes)
    .set({ status: "offline", lastSeenAt: Date.now() })
    .where(and(eq(schema.nodes.id, session.nodeId), ne(schema.nodes.status, "revoked")));
}

export async function createEnrollmentToken(
  owner: { ownerUserId?: string | null; ownerOrgId?: string | null },
  projectId: string | null,
): Promise<string> {
  const token = `nk_${newToken(18)}`;
  await db.insert(schema.enrollmentTokens).values({
    id: crypto.randomUUID(),
    ownerUserId: owner.ownerOrgId ? null : (owner.ownerUserId ?? null),
    ownerOrgId: owner.ownerOrgId ?? null,
    projectId,
    tokenHash: hashToken(token),
    expiresAt: Date.now() + config.enrollmentTtlMs,
    usedAt: null,
    createdAt: Date.now(),
  });
  return token;
}

export async function revokeNode(
  nodeId: string,
  owner: { ownerUserId?: string | null; ownerOrgId?: string | null },
): Promise<boolean> {
  const updated = await db
    .update(schema.nodes)
    .set({ status: "revoked" })
    .where(
      and(
        eq(schema.nodes.id, nodeId),
        owner.ownerOrgId
          ? eq(schema.nodes.ownerOrgId, owner.ownerOrgId)
          : eq(schema.nodes.ownerUserId, owner.ownerUserId!),
      ),
    )
    .returning({ id: schema.nodes.id });

  if (updated.length === 0) return false;

  /* Revocation has to drop the live socket too, or the node keeps working
     until it happens to reconnect. */
  live.get(nodeId)?.socket.close();
  live.delete(nodeId);
  return true;
}

/* Test seam: the map is module state, and tests need a clean one. */
export function resetRegistry(): void {
  live.clear();
  waiting.clear();
  taskSubscribers.clear();
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
