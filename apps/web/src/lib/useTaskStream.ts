import { useEffect, useRef, useState } from "react";
import { api, streamTask, type TaskDetail, type TaskEvent } from "./api";

/* Subscribes to a task's event log and folds it into what the thread renders.
 *
 * The fold is the important part: the server sends an append-only log, and the
 * UI needs it grouped into turns, with tool results attached to their calls and
 * streaming deltas collapsed into the message they belong to. Doing that here
 * rather than in the component means a replayed thread and a live one go
 * through exactly the same code. */

export interface ToolEntry {
  callId: string;
  tool: string;
  summary: string;
  args: unknown;
  result?: { ok: boolean; output: string; truncated?: boolean; durationMs?: number; exitCode?: number };
  logs: string;
  approval?: { reason: string; decided?: boolean; approved?: boolean };
}

export type ThreadItem =
  | { kind: "user"; seq: number; text: string; queued?: boolean }
  | { kind: "assistant"; seq: number; text: string; model?: string; streaming?: boolean }
  | { kind: "tools"; seq: number; entries: ToolEntry[] }
  | { kind: "note"; seq: number; text: string; tone: "info" | "bad" };

export interface TaskLive {
  task?: TaskDetail;
  items: ThreadItem[];
  status: TaskDetail["status"];
  cost: number;
  tokens: { input: number; output: number };
  model?: string;
  nodeName?: string;
  pendingApproval?: { callId: string; summary: string; tool: string };
  currentAction?: string;
  error?: string;
  connected: boolean;
}

export function useTaskStream(taskId: string | undefined): TaskLive {
  const [state, setState] = useState<TaskLive>({
    items: [],
    status: "queued",
    cost: 0,
    tokens: { input: 0, output: 0 },
    connected: false,
  });

  /* Events are folded into a mutable working set held in a ref, and the React
     state is replaced from it. Rebuilding from the whole array on every event
     would be O(n²) over a long task. */
  const fold = useRef(newFold());

  useEffect(() => {
    if (!taskId) return;

    let cancelled = false;
    fold.current = newFold();
    let close: (() => void) | undefined;

    (async () => {
      const { task, events } = await api.task(taskId);
      if (cancelled) return;

      for (const event of events) applyEvent(fold.current, event);

      const seen = events.length ? events[events.length - 1].seq : 0;
      setState(snapshot(fold.current, task, true));

      /* A task that has already ended emits nothing more, so opening a stream
         for it would hold a connection open forever for no events. The replay
         above is the whole thread. */
      if (["completed", "failed", "cancelled"].includes(task.status)) return;

      close = streamTask(taskId, seen, (event) => {
        applyEvent(fold.current, event);
        setState(snapshot(fold.current, task, true));

        /* Once the task reaches a terminal state, stop listening rather than
           holding the connection open until the user navigates away. */
        if (event.kind === "status" && ["completed", "failed", "cancelled"].includes(event.status)) {
          close?.();
          close = undefined;
        }
      });
    })().catch(() => {
      if (!cancelled) setState((s) => ({ ...s, connected: false }));
    });

    return () => {
      cancelled = true;
      close?.();
    };
  }, [taskId]);

  return state;
}

interface Fold {
  items: ThreadItem[];
  toolsBySeq: Map<number, ToolEntry[]>;
  entryByCall: Map<string, ToolEntry>;
  streamingSeq?: number;
  status: TaskDetail["status"];
  cost: number;
  input: number;
  output: number;
  model?: string;
  nodeName?: string;
  pending?: { callId: string; summary: string; tool: string };
  currentAction?: string;
  error?: string;
}

function newFold(): Fold {
  return {
    items: [],
    toolsBySeq: new Map(),
    entryByCall: new Map(),
    status: "queued",
    cost: 0,
    input: 0,
    output: 0,
  };
}

function applyEvent(f: Fold, event: TaskEvent): void {
  switch (event.kind) {
    case "user_message":
      f.items.push({ kind: "user", seq: event.seq, text: event.text, queued: event.queued });
      break;

    /* Deltas append to a live assistant bubble. The assistant_message that
       follows replaces it with the final text, so a reconnect mid-turn does
       not leave a duplicate half-sentence. */
    case "assistant_delta": {
      const last = f.items[f.items.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        last.text += event.text;
      } else {
        f.items.push({ kind: "assistant", seq: event.seq, text: event.text, streaming: true });
      }
      break;
    }

    case "assistant_message": {
      const last = f.items[f.items.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        last.text = event.text;
        last.streaming = false;
        last.model = event.model;
      } else if (event.text) {
        f.items.push({ kind: "assistant", seq: event.seq, text: event.text, model: event.model });
      }
      f.model = event.model;
      if (event.nodeName) f.nodeName = event.nodeName;
      break;
    }

    case "tool_call": {
      const entry: ToolEntry = {
        callId: event.callId,
        tool: event.tool,
        summary: event.summary,
        args: event.args,
        logs: "",
      };
      f.entryByCall.set(event.callId, entry);

      /* Consecutive calls group into one block, the way a run of tool lines
         reads in a terminal. */
      const last = f.items[f.items.length - 1];
      if (last?.kind === "tools") {
        last.entries.push(entry);
      } else {
        f.items.push({ kind: "tools", seq: event.seq, entries: [entry] });
      }
      f.currentAction = `${event.tool} ${event.summary}`.trim();
      break;
    }

    case "tool_result": {
      const entry = f.entryByCall.get(event.callId);
      if (entry) {
        entry.result = {
          ok: event.ok,
          output: event.output,
          truncated: event.truncated,
          durationMs: event.durationMs,
          exitCode: event.exitCode,
        };
      }
      break;
    }

    case "log": {
      const entry = event.callId ? f.entryByCall.get(event.callId) : undefined;
      if (entry) entry.logs += event.chunk;
      break;
    }

    case "approval_requested": {
      const entry = f.entryByCall.get(event.callId);
      if (entry) entry.approval = { reason: event.reason };
      f.pending = { callId: event.callId, summary: event.summary, tool: event.tool };
      break;
    }

    case "approval_decided": {
      const entry = f.entryByCall.get(event.callId);
      if (entry?.approval) {
        entry.approval.decided = true;
        entry.approval.approved = event.approved;
      }
      if (f.pending?.callId === event.callId) f.pending = undefined;
      break;
    }

    case "routing_decision":
      f.nodeName = event.nodeName;
      f.model = event.model;
      break;

    case "status":
      f.status = event.status;
      if (event.status === "failed" && event.detail) {
        f.error = event.detail;
        f.items.push({ kind: "note", seq: event.seq, text: event.detail, tone: "bad" });
      }
      if (event.status === "cancelled") {
        f.items.push({ kind: "note", seq: event.seq, text: event.detail ?? "Stopped.", tone: "info" });
      }
      if (["completed", "failed", "cancelled"].includes(event.status)) f.currentAction = undefined;
      break;

    case "usage":
      f.input += event.inputTokens;
      f.output += event.outputTokens;
      f.cost += event.costUsd;
      break;
  }
}

function snapshot(f: Fold, task: TaskDetail, connected: boolean): TaskLive {
  return {
    task,
    /* A new array each time so React sees a change; the entries themselves are
       stable objects, which keeps re-renders cheap. */
    items: [...f.items],
    status: f.status,
    cost: f.cost,
    tokens: { input: f.input, output: f.output },
    model: f.model ?? task.model ?? undefined,
    nodeName: f.nodeName ?? task.nodeName ?? undefined,
    pendingApproval: f.pending,
    currentAction: f.currentAction,
    error: f.error ?? task.error ?? undefined,
    connected,
  };
}
