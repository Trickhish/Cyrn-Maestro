/* The API client.
 *
 * One place that knows how to talk to the server, so a route change is one
 * edit and every caller gets the same error handling. Errors carry the
 * server's message, which is written for a human to read. */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: Record<string, string[]>,
    /* Set when the password was accepted but a second factor is still needed,
       so the sign-in screen can ask for a code instead of implying the
       password was wrong. */
    readonly needsSecondFactor?: boolean,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/* The organization the user is currently working in, or null for personal.
   Sent on every request; the server verifies membership rather than trusting
   it, so this is a convenience, not a permission. */
let activeOrgId: string | null = localStorage.getItem("maestro.org");

export function setActiveOrg(orgId: string | null): void {
  activeOrgId = orgId;
  if (orgId) localStorage.setItem("maestro.org", orgId);
  else localStorage.removeItem("maestro.org");
}

export function getActiveOrg(): string | null {
  return activeOrgId;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    /* Session lives in an HttpOnly cookie; nothing here handles a token. */
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(activeOrgId ? { "x-maestro-org": activeOrgId } : {}),
      ...init.headers,
    },
  });

  const body = await res.json().catch(() => ({}) as Record<string, unknown>);

  if (!res.ok) {
    throw new ApiError(
      typeof body.error === "string" ? body.error : `Request failed (${res.status}).`,
      res.status,
      body.details as Record<string, string[]> | undefined,
      body.needsSecondFactor === true,
    );
  }

  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

/* ------------------------------------------------------------------ types */

export interface Actor {
  id: string;
  email: string;
  instanceRole: "instance_admin" | "user";
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  repoUrl: string | null;
  branch: string | null;
  instructions: string | null;
  defaultModelId: string | null;
}

export interface NodeSummary {
  id: string;
  name: string;
  status: "online" | "offline" | "revoked";
  os: string | null;
  arch: string | null;
  capabilities: string[];
  maxConcurrentTasks: number;
  runningTasks: number;
  lastSeenAt: number | null;
  loadPercent: number | null;
}

export type TaskStatus =
  | "queued"
  | "assigned"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskSummary {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: TaskStatus;
  model: string | null;
  costUsd: number;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
  nodeName: string | null;
  running: boolean;
}

export interface TaskDetail extends TaskSummary {
  prompt: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderModel {
  id: string;
  modelId: string;
  tier: string;
  contextWindow: number | null;
  enabled: boolean;
  probeOk: boolean | null;
  probeError: string | null;
}

export interface Provider {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  enabled: boolean;
  lastHealthOk: boolean | null;
  models: ProviderModel[];
}

/* ------------------------------------------------------------------- calls */

export interface Organization {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member" | "viewer";
  permissions: string[];
}

export const api = {
  account: () =>
    request<{
      email: string;
      instanceRole: string;
      createdAt: number;
      twoFactor: { enabled: boolean; enabledAt: number | null; hasRecoveryCodes: boolean };
    }>("/account"),
  changePassword: (currentPassword: string, newPassword: string) =>
    post<{ ok: true }>("/account/password", { currentPassword, newPassword }),
  sessions: () =>
    request<{
      sessions: Array<{
        id: string; ip: string | null; userAgent: string | null;
        createdAt: number; expiresAt: number; current: boolean;
      }>;
    }>("/account/sessions"),
  revokeSession: (id: string) => request<{ ok: true }>(`/account/sessions/${id}`, { method: "DELETE" }),
  revokeOtherSessions: () => post<{ revoked: number }>("/account/sessions/revoke-others"),
  begin2fa: () => post<{ secret: string; uri: string }>("/account/2fa/begin"),
  confirm2fa: (code: string) => post<{ recoveryCodes: string[] }>("/account/2fa/confirm", { code }),
  disable2fa: (password: string) => post<{ ok: true }>("/account/2fa/disable", { password }),

  orgs: () => request<{ organizations: Organization[] }>("/orgs"),
  createOrg: (name: string) => post<{ organization: Organization }>("/orgs", { name }),
  members: (orgId: string) =>
    request<{
      members: Array<{ userId: string; email: string; role: string; since: number }>;
      invitations: Array<{ id: string; email: string; role: string; expiresAt: number }>;
    }>(`/orgs/${orgId}/members`),
  invite: (orgId: string, email: string, role: string) =>
    post<{ link: string }>(`/orgs/${orgId}/invitations`, { email, role }),
  acceptInvite: (token: string) =>
    post<{ organization: Organization }>("/orgs/invitations/accept", { token }),
  audit: (orgId: string) =>
    request<{ entries: Array<{ id: string; action: string; actorEmail: string | null; target: string | null; at: number }> }>(
      `/orgs/${orgId}/audit`,
    ),

  session: () => request<{ actor: Actor | null; registrationOpen: boolean }>("/auth/session"),
  register: (email: string, password: string) => post<{ actor: Actor }>("/auth/register", { email, password }),
  login: (email: string, password: string, code?: string) =>
    post<{ actor: Actor }>("/auth/login", { email, password, ...(code ? { code } : {}) }),
  logout: () => post<{ ok: true }>("/auth/logout"),

  projects: () => request<{ projects: Project[] }>("/projects"),
  createProject: (body: { name: string; instructions?: string }) =>
    post<{ project: Project }>("/projects", body),

  nodes: () => request<{ nodes: NodeSummary[] }>("/nodes"),
  enrollNode: (projectId?: string) =>
    post<{ token: string; command: string; expiresInMs: number }>("/nodes/enroll", { projectId }),
  revokeNode: (id: string) => request<{ ok: true }>(`/nodes/${id}`, { method: "DELETE" }),

  providers: () => request<{ providers: Provider[] }>("/providers"),
  addProvider: (body: { name: string; kind: string; baseUrl: string; apiKey: string }) =>
    post<{ provider: Provider }>("/providers", body),
  refreshProvider: (id: string) =>
    post<{ count: number; usable: number }>(`/providers/${id}/refresh`),

  tasks: (projectId?: string) =>
    request<{ tasks: TaskSummary[] }>(`/tasks${projectId ? `?projectId=${projectId}` : ""}`),
  task: (id: string) => request<{ task: TaskDetail; events: TaskEvent[] }>(`/tasks/${id}`),
  createTask: (body: { projectId: string; prompt: string; model?: string; nodeId?: string }) =>
    post<{ task: { id: string; title: string; status: TaskStatus } }>("/tasks", body),
  steer: (id: string, text: string) => post<{ ok: true }>(`/tasks/${id}/steer`, { text }),
  cancelTask: (id: string) => post<{ ok: true }>(`/tasks/${id}/cancel`),
  approve: (id: string, callId: string, approved: boolean) =>
    post<{ ok: true }>(`/tasks/${id}/approve`, { callId, approved }),

  askConductor: (question: string, history: Array<{ role: "user" | "assistant"; content: string }>) =>
    post<{
      text: string;
      usedTools: Array<{ name: string; args: unknown }>;
      usage: { inputTokens: number; outputTokens: number };
      model: string;
    }>("/conductor/ask", { question, history }),
};

/* ------------------------------------------------------------------ events */

export type TaskEvent =
  | { seq: number; at: number; kind: "user_message"; text: string; queued?: boolean }
  | { seq: number; at: number; kind: "assistant_message"; text: string; model: string; nodeName?: string }
  | { seq: number; at: number; kind: "assistant_delta"; text: string }
  | { seq: number; at: number; kind: "tool_call"; callId: string; tool: string; args: unknown; summary: string }
  | {
      seq: number;
      at: number;
      kind: "tool_result";
      callId: string;
      ok: boolean;
      output: string;
      truncated?: boolean;
      durationMs?: number;
      exitCode?: number;
    }
  | { seq: number; at: number; kind: "log"; callId?: string; stream: "stdout" | "stderr"; chunk: string }
  | { seq: number; at: number; kind: "approval_requested"; callId: string; tool: string; summary: string; reason: string }
  | { seq: number; at: number; kind: "approval_decided"; callId: string; approved: boolean; decidedBy: string }
  | { seq: number; at: number; kind: "routing_decision"; nodeName: string; model: string; because: string }
  | { seq: number; at: number; kind: "status"; status: TaskStatus; detail?: string }
  | { seq: number; at: number; kind: "usage"; model: string; inputTokens: number; outputTokens: number; costUsd: number };

/* Opens the live stream for a task, resuming after the last event seen so a
   dropped connection does not silently lose what happened while it was gone. */
export function streamTask(
  taskId: string,
  afterSeq: number,
  onEvent: (event: TaskEvent) => void,
): () => void {
  const source = new EventSource(`/api/tasks/${taskId}/stream?after=${afterSeq}`);

  const handle = (raw: MessageEvent) => {
    try {
      onEvent(JSON.parse(raw.data) as TaskEvent);
    } catch {
      /* A frame we cannot parse is not worth tearing the stream down for. */
    }
  };

  /* Named events, so each kind arrives on its own listener rather than a
     single onmessage that has to re-dispatch. */
  const kinds = [
    "user_message", "assistant_message", "assistant_delta", "tool_call", "tool_result",
    "log", "approval_requested", "approval_decided", "routing_decision", "status", "usage",
  ];
  for (const kind of kinds) source.addEventListener(kind, handle);

  return () => source.close();
}
