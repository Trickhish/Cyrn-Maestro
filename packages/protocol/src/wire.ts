import { z } from "zod";
import { ToolNameSchema } from "./tools";

/* The server↔node wire protocol.
 *
 * One WebSocket per node, JSON frames, every message carrying an id and a type.
 * The node dials out, so nothing here assumes the server can reach the node. */

export const PROTOCOL_VERSION = 1;

export const WorkspaceInfo = z.object({
  projectId: z.string(),
  path: z.string(),
  vcs: z.enum(["git", "none"]).default("none"),
  branch: z.string().optional(),
});

export const NodeIdentity = z.object({
  name: z.string(),
  os: z.string(),
  arch: z.string(),
  version: z.string(),
  maxConcurrentTasks: z.number().int().min(1).max(64),
  capabilities: z.array(z.string()),
  workspaces: z.array(WorkspaceInfo),
});

/* ---------------------------------------------------------------- node → server */

export const NodeEnroll = z.object({
  type: z.literal("node.enroll"),
  id: z.string(),
  /* Single-use, short-lived. Exchanged over the socket for a durable token so
     the durable one never appears in a shell command or in shell history. */
  enrollmentToken: z.string(),
  node: NodeIdentity,
});

export const NodeRegister = z.object({
  type: z.literal("node.register"),
  id: z.string(),
  nodeToken: z.string(),
  node: NodeIdentity,
  /* Tasks this node believes it is still running, so a server that restarted
     re-attaches instead of dispatching the work twice. */
  runningTaskIds: z.array(z.string()).default([]),
});

export const NodeHeartbeat = z.object({
  type: z.literal("node.heartbeat"),
  id: z.string(),
  loadPercent: z.number().min(0).max(100).optional(),
  freeDiskBytes: z.number().optional(),
  runningTaskIds: z.array(z.string()).default([]),
});

export const TaskAccepted = z.object({
  type: z.literal("task.accepted"),
  id: z.string(),
  taskId: z.string(),
});

export const TaskRejected = z.object({
  type: z.literal("task.rejected"),
  id: z.string(),
  taskId: z.string(),
  reason: z.enum(["at_capacity", "unknown_workspace", "unsupported_tool", "error"]),
  detail: z.string().optional(),
});

export const ToolResult = z.object({
  type: z.literal("tool.result"),
  id: z.string(),
  taskId: z.string(),
  callId: z.string(),
  ok: z.boolean(),
  output: z.string(),
  /* Long output is truncated for the model but the node reports the real size
     so the UI can say what it is not showing. */
  truncated: z.boolean().default(false),
  totalBytes: z.number().optional(),
  durationMs: z.number().optional(),
  exitCode: z.number().optional(),
});

export const ToolApprovalRequest = z.object({
  type: z.literal("tool.approval_request"),
  id: z.string(),
  taskId: z.string(),
  callId: z.string(),
  tool: ToolNameSchema,
  summary: z.string().describe("Human-readable one-liner, e.g. the command itself."),
  reason: z.enum(["policy_ask", "denylist_near_miss", "mutating_tool"]),
});

export const TaskLog = z.object({
  type: z.literal("task.log"),
  id: z.string(),
  taskId: z.string(),
  callId: z.string().optional(),
  stream: z.enum(["stdout", "stderr"]),
  chunk: z.string(),
});

/* What the checkout on this node currently contains. Reported when a task is
   accepted, because skills version with the branch — the server cannot know
   them without asking the machine holding the code. */
export const SkillsFound = z.object({
  type: z.literal("skills.found"),
  id: z.string(),
  taskId: z.string(),
  skills: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      version: z.string().optional(),
      path: z.string(),
    }),
  ),
  /* Surfaced rather than swallowed: a skill its author believes is active but
     that never loads is worse than an error. */
  problems: z.array(z.object({ path: z.string(), message: z.string() })).default([]),
});

export const SkillBody = z.object({
  type: z.literal("skill.body"),
  id: z.string(),
  taskId: z.string(),
  requestId: z.string(),
  name: z.string(),
  body: z.string().nullable(),
});

export const TaskDone = z.object({
  type: z.literal("task.done"),
  id: z.string(),
  taskId: z.string(),
  status: z.enum(["completed", "failed", "cancelled"]),
  detail: z.string().optional(),
});

export const NodeMessage = z.discriminatedUnion("type", [
  NodeEnroll,
  NodeRegister,
  NodeHeartbeat,
  TaskAccepted,
  TaskRejected,
  ToolResult,
  ToolApprovalRequest,
  TaskLog,
  TaskDone,
  SkillsFound,
  SkillBody,
]);

/* ---------------------------------------------------------------- server → node */

export const NodeEnrolled = z.object({
  type: z.literal("node.enrolled"),
  id: z.string(),
  nodeId: z.string(),
  /* The durable token. The node writes this to disk with 0600 and uses it for
     every subsequent connection; the enrollment token is burned at this point. */
  nodeToken: z.string(),
});

export const NodeRegistered = z.object({
  type: z.literal("node.registered"),
  id: z.string(),
  nodeId: z.string(),
  heartbeatIntervalMs: z.number().int(),
  /* Set when the fleet has been given a concurrency for this machine that
     differs from the one it reported. Absent means "your own config stands". */
  maxConcurrentTasks: z.number().int().min(1).optional(),
});

/* Settings pushed to a node while it is connected.
 *
 * Concurrency is the machine's own business until someone says otherwise from
 * the fleet page, and having to SSH to every box to change one number is what
 * this avoids. Sent on change rather than polled, so it takes effect without
 * waiting for a reconnect. */
export const NodeConfigure = z.object({
  type: z.literal("node.configure"),
  id: z.string(),
  maxConcurrentTasks: z.number().int().min(1),
});

export const NodeRejected = z.object({
  type: z.literal("node.rejected"),
  id: z.string(),
  reason: z.enum(["bad_token", "expired_token", "token_used", "revoked", "version_mismatch"]),
  detail: z.string().optional(),
});

export const WorkspaceProvision = z.object({
  type: z.literal("workspace.provision"),
  id: z.string(),
  projectId: z.string(),
  repoUrl: z.string().optional(),
  branch: z.string().optional(),
  path: z.string(),
});

export const TaskAssign = z.object({
  type: z.literal("task.assign"),
  id: z.string(),
  taskId: z.string(),
  projectId: z.string(),
  workspacePath: z.string(),
  limits: z.object({
    wallClockMs: z.number().int(),
    maxToolCalls: z.number().int(),
  }),
});

export const ToolCall = z.object({
  type: z.literal("tool.call"),
  id: z.string(),
  taskId: z.string(),
  callId: z.string(),
  tool: ToolNameSchema,
  args: z.unknown(),
  /* Set once a human has approved a call the node's policy escalated. The node
     refuses to re-run an escalation it never asked for. */
  approved: z.boolean().optional(),
});

/* Asks the node for one skill's body, once the model has decided it is
   relevant. */
export const SkillFetch = z.object({
  type: z.literal("skill.fetch"),
  id: z.string(),
  taskId: z.string(),
  requestId: z.string(),
  name: z.string(),
});

export const TaskCancel = z.object({
  type: z.literal("task.cancel"),
  id: z.string(),
  taskId: z.string(),
});

/* Sent when a task reaches a terminal state, so the node can free its slot.
   Without it a node silently fills to maxConcurrentTasks and rejects
   everything afterwards — and because the rejection is per assignment rather
   than per tool call, the symptom is every subsequent call failing with
   "not running that task" rather than anything mentioning capacity. */
export const TaskRelease = z.object({
  type: z.literal("task.release"),
  id: z.string(),
  taskId: z.string(),
  status: z.enum(["completed", "failed", "cancelled"]),
});

export const Ping = z.object({
  type: z.literal("ping"),
  id: z.string(),
});

export const ServerMessage = z.discriminatedUnion("type", [
  NodeEnrolled,
  NodeRegistered,
  NodeRejected,
  NodeConfigure,
  WorkspaceProvision,
  TaskAssign,
  ToolCall,
  TaskCancel,
  TaskRelease,
  SkillFetch,
  Ping,
]);

export type NodeMessage = z.infer<typeof NodeMessage>;
export type ServerMessage = z.infer<typeof ServerMessage>;
export type NodeIdentity = z.infer<typeof NodeIdentity>;
export type WorkspaceInfo = z.infer<typeof WorkspaceInfo>;

export function newId(): string {
  return crypto.randomUUID();
}
