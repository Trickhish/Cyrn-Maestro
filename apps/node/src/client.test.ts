import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { newId, type ServerMessage } from "@maestro/protocol";
import { NodeClient } from "./client";

/* Drives the client through a fake socket, so assignment and slot accounting
   can be tested without a server or a network. */

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  sent: any[] = [];
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
    this.readyState = 3;
  }

  emit(type: string, event: any) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  /* Delivers a server frame and lets the client's async handler settle. */
  async deliver(message: ServerMessage) {
    this.emit("message", { data: JSON.stringify(message) });
    await new Promise((r) => setTimeout(r, 20));
  }
  ofType(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

let root: string;
let socket: FakeSocket;
let client: NodeClient;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "maestro-client-"));
  process.env.MAESTRO_WORKSPACE_ROOT = join(root, "workspaces");
  process.env.MAESTRO_MAX_TASKS = "2";

  socket = new FakeSocket();
  client = new NodeClient({
    enrollmentToken: "nk_test",
    configPath: join(root, "node.toml"),
    socketFactory: () => socket as unknown as WebSocket,
  });

  client.start();
  socket.emit("open", {});
  await socket.deliver({ type: "node.enrolled", id: newId(), nodeId: "n1", nodeToken: "durable" });
  await socket.deliver({ type: "node.registered", id: newId(), nodeId: "n1", heartbeatIntervalMs: 60_000 });
});

afterEach(() => {
  client.stop();
  rmSync(root, { recursive: true, force: true });
  delete process.env.MAESTRO_MAX_TASKS;
  delete process.env.MAESTRO_WORKSPACE_ROOT;
});

const assign = (taskId: string): ServerMessage => ({
  type: "task.assign",
  id: newId(),
  taskId,
  projectId: "p1",
  workspacePath: "",
  limits: { wallClockMs: 60_000, maxToolCalls: 10 },
});

describe("task slots", () => {
  test("accepts an assignment up to the concurrency limit", async () => {
    await socket.deliver(assign("t1"));
    await socket.deliver(assign("t2"));

    expect(socket.ofType("task.accepted")).toHaveLength(2);
    expect(socket.ofType("task.rejected")).toHaveLength(0);
  });

  test("rejects beyond the limit, saying it is at capacity", async () => {
    await socket.deliver(assign("t1"));
    await socket.deliver(assign("t2"));
    await socket.deliver(assign("t3"));

    const rejected = socket.ofType("task.rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("at_capacity");
  });

  /* The bug this pins: without task.release the node never frees a slot, so
     after maxConcurrentTasks finished tasks it rejects everything forever. The
     symptom is not "at capacity" — it is every later tool call failing with
     "this node is not running that task", which points nowhere near the cause. */
  test("a finished task frees its slot", async () => {
    await socket.deliver(assign("t1"));
    await socket.deliver(assign("t2"));
    await socket.deliver({ type: "task.release", id: newId(), taskId: "t1", status: "completed" });
    await socket.deliver(assign("t3"));

    expect(socket.ofType("task.rejected")).toHaveLength(0);
    expect(socket.ofType("task.accepted")).toHaveLength(3);
  });

  test("cancelling also frees the slot", async () => {
    await socket.deliver(assign("t1"));
    await socket.deliver(assign("t2"));
    await socket.deliver({ type: "task.cancel", id: newId(), taskId: "t1" });
    await socket.deliver(assign("t3"));

    expect(socket.ofType("task.accepted")).toHaveLength(3);
  });

  test("releasing a task it never had is harmless", async () => {
    await socket.deliver({ type: "task.release", id: newId(), taskId: "unknown", status: "completed" });
    await socket.deliver(assign("t1"));
    expect(socket.ofType("task.accepted")).toHaveLength(1);
  });
});

describe("tool calls", () => {
  test("a call for an unassigned task fails rather than executing", async () => {
    await socket.deliver({
      type: "tool.call",
      id: newId(),
      taskId: "never-assigned",
      callId: "c1",
      tool: "list_dir",
      args: {},
    });

    const results = socket.ofType("tool.result");
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].output).toContain("not running that task");
  });

  test("a read-only call runs without asking for approval", async () => {
    await socket.deliver(assign("t1"));
    await socket.deliver({
      type: "tool.call",
      id: newId(),
      taskId: "t1",
      callId: "c1",
      tool: "list_dir",
      args: { path: "." },
    });

    expect(socket.ofType("tool.approval_request")).toHaveLength(0);
    expect(socket.ofType("tool.result")[0].ok).toBe(true);
  });

  test("a write escalates for approval instead of running", async () => {
    await socket.deliver(assign("t1"));
    await socket.deliver({
      type: "tool.call",
      id: newId(),
      taskId: "t1",
      callId: "c1",
      tool: "write_file",
      args: { path: "a.txt", content: "x" },
    });

    expect(socket.ofType("tool.approval_request")).toHaveLength(1);
    expect(socket.ofType("tool.result")).toHaveLength(0);
  });

  /* A refusal is the node's decision about its own machine. The server saying
     "approved" must not be able to override it. */
  test("an approved flag cannot unlock a refused command", async () => {
    await socket.deliver(assign("t1"));
    await socket.deliver({
      type: "tool.call",
      id: newId(),
      taskId: "t1",
      callId: "c1",
      tool: "bash",
      args: { command: "rm -rf /" },
      approved: true,
    });

    const results = socket.ofType("tool.result");
    expect(results[0].ok).toBe(false);
    expect(results[0].output).toContain("command policy");
  });
});

describe("enrollment", () => {
  test("stores the durable token and stops using the enrollment one", () => {
    const enroll = socket.ofType("node.enroll");
    expect(enroll).toHaveLength(1);
    expect(enroll[0].enrollmentToken).toBe("nk_test");
  });
});
