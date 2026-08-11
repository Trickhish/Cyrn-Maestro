import { eq, and, gt, asc } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { TaskEvent, TaskEventInput } from "@maestro/protocol";
import { db, schema, sqlite } from "../db";

/* The append-only event log.
 *
 * This is the source of truth for a task. The thread rendered live and the
 * thread opened six months later are the same render over these rows, which is
 * only true if everything the UI needs is in an event and nothing is derived
 * from mutable task state.
 *
 * Sequence numbers are per task and gap-free. The UI resumes a dropped stream
 * by asking for everything after the last seq it saw, so a gap would silently
 * lose a tool call rather than obviously break. */

type Listener = (event: TaskEvent) => void;
const listeners = new Map<string, Set<Listener>>();

/* Assigning the sequence number and inserting the row have to be one atomic
   step. Two concurrent appends that both read "last seq is 7" would both write
   8, and the unique constraint would turn a race into a lost event. */
const nextSeqAndInsert = sqlite.transaction(
  (taskId: string, id: string, kind: string, payload: string, at: number) => {
    const row = sqlite
      .query<{ next: number }, [string]>(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM task_events WHERE task_id = ?",
      )
      .get(taskId);

    const seq = row?.next ?? 1;
    sqlite.run(
      "INSERT INTO task_events (id, task_id, seq, kind, payload, at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, taskId, seq, kind, payload, at],
    );
    return seq;
  },
);

/* Omit over a discriminated union collapses it into one object type with only
   the shared keys, which would reject every event-specific field. Distributing
   over the members first keeps each variant intact. */
type NewEvent<T = TaskEventInput> = T extends unknown ? Omit<T, "seq" | "at"> : never;

export function append(taskId: string, event: NewEvent): TaskEvent {
  const at = Date.now();
  const seq = nextSeqAndInsert(
    taskId,
    crypto.randomUUID(),
    event.kind,
    JSON.stringify(event),
    at,
  );

  const full = { ...event, seq, at } as TaskEvent;

  /* Listeners run after the row is durable, so a subscriber can never see an
     event the database would not replay. */
  for (const listener of listeners.get(taskId) ?? []) {
    try {
      listener(full);
    } catch (err) {
      console.error("[events] listener threw", err);
    }
  }

  return full;
}

export function subscribe(taskId: string, listener: Listener): () => void {
  const set = listeners.get(taskId) ?? new Set();
  set.add(listener);
  listeners.set(taskId, set);

  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(taskId);
  };
}

export async function replay(taskId: string, afterSeq = 0): Promise<TaskEvent[]> {
  const rows = await db
    .select()
    .from(schema.taskEvents)
    .where(and(eq(schema.taskEvents.taskId, taskId), gt(schema.taskEvents.seq, afterSeq)))
    .orderBy(asc(schema.taskEvents.seq));

  return rows.map((row) => ({
    ...(row.payload as object),
    seq: row.seq,
    at: row.at,
  })) as TaskEvent[];
}

/* Deltas exist only for live rendering — the assistant_message that follows
   carries the same text in one row. Replaying them would double every
   sentence in a finished thread. */
export async function replayForDisplay(taskId: string, afterSeq = 0): Promise<TaskEvent[]> {
  return (await replay(taskId, afterSeq)).filter((e) => e.kind !== "assistant_delta");
}

export async function lastSeq(taskId: string): Promise<number> {
  const row = sqlite
    .query<{ seq: number }, [string]>(
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM task_events WHERE task_id = ?",
    )
    .get(taskId);
  return row?.seq ?? 0;
}

/* Rebuilds the model's view of the conversation from the log, so a task that
   was interrupted, or whose server restarted, resumes with the same context it
   had. Nothing is kept in memory between turns. */
export async function conversationFrom(taskId: string) {
  const events = await replay(taskId);
  const messages: Array<
    | { role: "user"; content: string }
    | { role: "assistant"; content: string; toolCalls?: Array<{ id: string; name: string; argumentsJson: string }> }
    | { role: "tool"; toolCallId: string; content: string }
  > = [];

  let pendingCalls: Array<{ id: string; name: string; argumentsJson: string }> = [];
  let pendingText = "";

  const flushAssistant = () => {
    if (pendingText || pendingCalls.length) {
      messages.push({
        role: "assistant",
        content: pendingText,
        ...(pendingCalls.length ? { toolCalls: pendingCalls } : {}),
      });
      pendingText = "";
      pendingCalls = [];
    }
  };

  for (const event of events) {
    switch (event.kind) {
      case "user_message":
        flushAssistant();
        messages.push({ role: "user", content: event.text });
        break;

      case "assistant_message":
        pendingText = event.text;
        break;

      case "tool_call":
        pendingCalls.push({
          id: event.callId,
          name: event.tool,
          argumentsJson: JSON.stringify(event.args ?? {}),
        });
        break;

      case "tool_result":
        flushAssistant();
        messages.push({
          role: "tool",
          toolCallId: event.callId,
          /* A failed tool still gets its output fed back: the model needs to
             see the error to correct itself, and dropping it strands the call
             with no matching result, which most providers reject outright. */
          content: event.output || (event.ok ? "(no output)" : "(failed with no output)"),
        });
        break;

      default:
        break;
    }
  }

  flushAssistant();
  return messages;
}

export function resetListeners(): void {
  listeners.clear();
}

export const _internal = { sql };
