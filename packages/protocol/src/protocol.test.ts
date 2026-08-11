import { expect, test, describe } from "bun:test";
import { NodeMessage, ServerMessage, newId } from "./wire";
import { TaskEvent, TERMINAL_STATUSES } from "./events";
import { TOOL_SCHEMAS, TOOL_NAMES, MUTATING_TOOLS } from "./tools";

/* These guard the one thing three deployables agree on. A change that breaks a
   case here breaks the server, the node, or the UI silently at runtime. */

describe("node → server", () => {
  test("rejects a message missing a required field", () => {
    const r = NodeMessage.safeParse({
      type: "tool.result",
      id: newId(),
      taskId: "t",
      callId: "c",
      ok: true,
      // no output
    });
    expect(r.success).toBe(false);
  });

  test("accepts a valid result and applies defaults", () => {
    const r = NodeMessage.safeParse({
      type: "tool.result",
      id: newId(),
      taskId: "t",
      callId: "c",
      ok: true,
      output: "hi",
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.type === "tool.result") {
      expect(r.data.truncated).toBe(false);
    }
  });

  test("rejects an unknown message type", () => {
    const r = NodeMessage.safeParse({ type: "node.pwn", id: newId() });
    expect(r.success).toBe(false);
  });
});

describe("server → node", () => {
  test("rejects a tool name outside the allowed set", () => {
    const r = ServerMessage.safeParse({
      type: "tool.call",
      id: newId(),
      taskId: "t",
      callId: "c",
      tool: "rm_rf",
      args: {},
    });
    expect(r.success).toBe(false);
  });

  test("accepts every declared tool", () => {
    for (const tool of TOOL_NAMES) {
      const r = ServerMessage.safeParse({
        type: "tool.call",
        id: newId(),
        taskId: "t",
        callId: "c",
        tool,
        args: {},
      });
      expect(r.success).toBe(true);
    }
  });
});

describe("tool arguments", () => {
  test("bash rejects a timeout beyond the ceiling", () => {
    expect(TOOL_SCHEMAS.bash.safeParse({ command: "ls", timeout_ms: 5 }).success).toBe(false);
    expect(TOOL_SCHEMAS.bash.safeParse({ command: "ls", timeout_ms: 999_999_999 }).success).toBe(
      false,
    );
    expect(TOOL_SCHEMAS.bash.safeParse({ command: "ls", timeout_ms: 30_000 }).success).toBe(true);
  });

  test("edit_file requires both strings", () => {
    expect(TOOL_SCHEMAS.edit_file.safeParse({ path: "a.ts", old_string: "x" }).success).toBe(false);
  });

  test("the mutating set is exactly the tools that can change a workspace", () => {
    expect([...MUTATING_TOOLS].sort()).toEqual(["bash", "edit_file", "write_file"]);
  });
});

describe("task events", () => {
  test("accepts each event kind the UI renders", () => {
    const at = Date.now();
    const samples = [
      { kind: "user_message", seq: 1, at, text: "go" },
      { kind: "assistant_message", seq: 2, at, text: "ok", model: "m" },
      { kind: "tool_call", seq: 3, at, callId: "c", tool: "read_file", args: {}, summary: "a.ts" },
      { kind: "tool_result", seq: 4, at, callId: "c", ok: true, output: "" },
      { kind: "status", seq: 5, at, status: "running" },
      { kind: "usage", seq: 6, at, model: "m", inputTokens: 1, outputTokens: 2, costUsd: 0.01 },
    ];
    for (const s of samples) {
      expect(TaskEvent.safeParse(s).success).toBe(true);
    }
  });

  test("rejects an invalid status", () => {
    const r = TaskEvent.safeParse({ kind: "status", seq: 1, at: Date.now(), status: "vibing" });
    expect(r.success).toBe(false);
  });

  test("terminal statuses are the three a task can end in", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["cancelled", "completed", "failed"]);
  });
});
