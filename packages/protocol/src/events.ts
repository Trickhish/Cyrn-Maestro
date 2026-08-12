import { z } from "zod";

/* task_events — the source of truth.
 *
 * The thread the user watches live and the thread they open six months later
 * are the same render over the same rows, so anything the UI needs to draw has
 * to be in an event. Nothing is derived from mutable task state. */

export const TaskStatus = z.enum([
  "queued",
  "assigned",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);

const base = { seq: z.number().int(), at: z.number().int() };

export const UserMessageEvent = z.object({
  ...base,
  kind: z.literal("user_message"),
  text: z.string(),
  /* True when the message was typed mid-run and held until the turn boundary. */
  queued: z.boolean().default(false),
});

export const AssistantMessageEvent = z.object({
  ...base,
  kind: z.literal("assistant_message"),
  text: z.string(),
  model: z.string(),
  nodeName: z.string().optional(),
});

/* Streaming text arrives as deltas so the UI can render tokens as they land;
   the run collapses them into one assistant_message when the turn closes. */
export const AssistantDeltaEvent = z.object({
  ...base,
  kind: z.literal("assistant_delta"),
  text: z.string(),
});

export const ToolCallEvent = z.object({
  ...base,
  kind: z.literal("tool_call"),
  callId: z.string(),
  /* A plain string, not the node's tool enum.
   *
   * The event log has to represent every tool the agent actually used —
   * the node's, the server's own (load_skill), and MCP tools whose names come
   * from a third party. Forcing them into the node's enum meant recording a
   * load_skill call as a read_file, so the conversation rebuilt for the next
   * turn told the model its call had never happened and it repeated the call
   * on every turn. Execution is still validated against the enum at the point
   * it reaches the node; this field is a record of what occurred. */
  tool: z.string(),
  args: z.unknown(),
  summary: z.string().describe("The one-line collapsed form, e.g. the path or the command."),
});

export const ToolResultEvent = z.object({
  ...base,
  kind: z.literal("tool_result"),
  callId: z.string(),
  ok: z.boolean(),
  output: z.string(),
  truncated: z.boolean().default(false),
  durationMs: z.number().optional(),
  exitCode: z.number().optional(),
  added: z.number().optional(),
  removed: z.number().optional(),
});

export const LogEvent = z.object({
  ...base,
  kind: z.literal("log"),
  callId: z.string().optional(),
  stream: z.enum(["stdout", "stderr"]),
  chunk: z.string(),
});

export const ApprovalRequestedEvent = z.object({
  ...base,
  kind: z.literal("approval_requested"),
  callId: z.string(),
  tool: z.string(),
  summary: z.string(),
  reason: z.string(),
});

export const ApprovalDecidedEvent = z.object({
  ...base,
  kind: z.literal("approval_decided"),
  callId: z.string(),
  approved: z.boolean(),
  decidedBy: z.string(),
});

export const RoutingDecisionEvent = z.object({
  ...base,
  kind: z.literal("routing_decision"),
  nodeName: z.string(),
  model: z.string(),
  because: z.string(),
});

export const StatusEvent = z.object({
  ...base,
  kind: z.literal("status"),
  status: TaskStatus,
  detail: z.string().optional(),
});

/* Cost is recorded per model call, not per task, because a task can be driven
   by more than one model and the bill has to survive that. */
export const UsageEvent = z.object({
  ...base,
  kind: z.literal("usage"),
  model: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number(),
});

export const TaskEvent = z.discriminatedUnion("kind", [
  UserMessageEvent,
  AssistantMessageEvent,
  AssistantDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  LogEvent,
  ApprovalRequestedEvent,
  ApprovalDecidedEvent,
  RoutingDecisionEvent,
  StatusEvent,
  UsageEvent,
]);

export type TaskEvent = z.infer<typeof TaskEvent>;
export type TaskEventKind = TaskEvent["kind"];

/* The shape a caller writes, before defaults are applied. Appending an event
   should not require spelling out every field that has a default. */
export type TaskEventInput = z.input<typeof TaskEvent>;

/* Deltas are for live rendering only. Replaying a finished task skips them —
   the assistant_message that follows holds the same text in one row. */
export const EPHEMERAL_KINDS: ReadonlySet<TaskEventKind> = new Set<TaskEventKind>([
  "assistant_delta",
]);
