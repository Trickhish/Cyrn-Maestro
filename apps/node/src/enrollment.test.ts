import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { newId, type ServerMessage } from "@maestro/protocol";
import { NodeClient } from "./client";

/* Which token a node presents.
 *
 * The case that matters: a machine that was enrolled, then revoked, still has
 * its old token on disk. Re-running an install command there must present the
 * new enrollment token — preferring the stored one silently re-registers the
 * machine as the revoked node, and the new token never reaches the server at
 * all. That failure reads as "Server rejected this node: revoked", which sounds
 * like the fresh token was rejected when it was never sent. */

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  sent: any[] = [];
  closed = 0;
  private listeners = new Map<string, Array<(e: any) => void>>();

  addEventListener(type: string, fn: (e: any) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener() {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed++;
    /* A real socket notifies its listeners, which is what drives the client's
       reconnect. Without this the fake silently ends the test's world. */
    this.emit("close", {});
  }
  emit(type: string, event: any) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  async deliver(message: ServerMessage) {
    this.emit("message", { data: JSON.stringify(message) });
    await new Promise((r) => setTimeout(r, 20));
  }
  ofType(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

let root: string;
let configPath: string;
let sockets: FakeSocket[];

/* A machine that has been enrolled before: a config file with a stored token. */
function withStoredToken(token = "old-durable-token") {
  writeFileSync(
    configPath,
    [
      'server_url = "ws://server/api/node/socket"',
      'name = "v19818"',
      `workspace_root = "${join(root, "workspaces")}"`,
      `node_token = "${token}"`,
      "max_concurrent_tasks = 2",
      "auto_approve_writes = false",
      "always_allow = []",
      "",
    ].join("\n"),
  );
}

function start(options: { enrollmentToken?: string; onIdentified?: () => void } = {}) {
  const client = new NodeClient({
    ...options,
    configPath,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      /* The client attaches its listeners after this returns. */
      queueMicrotask(() => socket.emit("open", {}));
      return socket as unknown as WebSocket;
    },
  });
  client.start();
  return client;
}

const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "maestro-enrol-"));
  configPath = join(root, "node.toml");
  process.env.MAESTRO_WORKSPACE_ROOT = join(root, "workspaces");
  sockets = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.MAESTRO_WORKSPACE_ROOT;
});

describe("a machine with no identity yet", () => {
  test("enrols with the token it was given", async () => {
    const client = start({ enrollmentToken: "nk_fresh" });
    await settle();

    expect(sockets[0]!.ofType("node.enroll")).toHaveLength(1);
    expect(sockets[0]!.ofType("node.enroll")[0].enrollmentToken).toBe("nk_fresh");
    client.stop();
  });
});

describe("a machine that has been enrolled before", () => {
  test("registers with its stored token when no new one is offered", async () => {
    withStoredToken();
    const client = start();
    await settle();

    expect(sockets[0]!.ofType("node.register")).toHaveLength(1);
    expect(sockets[0]!.ofType("node.register")[0].nodeToken).toBe("old-durable-token");
    expect(sockets[0]!.ofType("node.enroll")).toHaveLength(0);
    client.stop();
  });

  /* The bug this file exists for. */
  test("prefers an explicit enrollment token over the one on disk", async () => {
    withStoredToken();
    const client = start({ enrollmentToken: "nk_fresh" });
    await settle();

    const enrols = sockets[0]!.ofType("node.enroll");
    expect(enrols).toHaveLength(1);
    expect(enrols[0].enrollmentToken).toBe("nk_fresh");
    /* If this is non-empty the new token never reached the server, and the
       machine re-identified as whatever it used to be. */
    expect(sockets[0]!.ofType("node.register")).toHaveLength(0);
    client.stop();
  });

  test("re-enrolling after a revocation stores the new identity", async () => {
    withStoredToken();
    const client = start({ enrollmentToken: "nk_fresh" });
    await settle();

    await sockets[0]!.deliver({
      type: "node.enrolled",
      id: newId(),
      nodeId: "n2",
      nodeToken: "new-durable-token",
    });

    expect(await Bun.file(configPath).text()).toContain("new-durable-token");
    client.stop();
  });

  /* A stale install command run on a healthy machine must not take it down. */
  test("falls back to its stored identity when the new token is refused", async () => {
    withStoredToken();
    const client = start({ enrollmentToken: "nk_expired" });
    await settle();

    await sockets[0]!.deliver({ type: "node.rejected", id: newId(), reason: "token_used" });
    /* Reconnects with backoff, so give it room to come back. */
    await new Promise((r) => setTimeout(r, 900));

    const registers = sockets.flatMap((s) => s.ofType("node.register"));
    expect(registers.length).toBeGreaterThan(0);
    expect(registers[0].nodeToken).toBe("old-durable-token");
    expect(process.exitCode ?? 0).toBe(0);
    client.stop();
  });

  test("gives up when it is revoked and has no enrollment token to fall back on", async () => {
    withStoredToken();
    const client = start();
    await settle();

    await sockets[0]!.deliver({ type: "node.rejected", id: newId(), reason: "revoked" });
    await settle();

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    client.stop();
  });
});

describe("--enroll-only", () => {
  test("finishes after enrolling", async () => {
    let done = false;
    const client = start({ enrollmentToken: "nk_fresh", onIdentified: () => (done = true) });
    await settle();

    await sockets[0]!.deliver({ type: "node.enrolled", id: newId(), nodeId: "n1", nodeToken: "d" });
    expect(done).toBe(true);
    client.stop();
  });

  /* Otherwise re-running the installer on a machine that is already set up
     would block until its timeout and report a failure. */
  test("finishes when the machine was already registered", async () => {
    withStoredToken();
    let done = false;
    const client = start({ onIdentified: () => (done = true) });
    await settle();

    await sockets[0]!.deliver({
      type: "node.registered",
      id: newId(),
      nodeId: "n1",
      heartbeatIntervalMs: 60_000,
    });

    expect(done).toBe(true);
    client.stop();
  });
});
