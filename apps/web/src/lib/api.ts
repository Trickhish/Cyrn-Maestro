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
  defaultTier: "light" | "standard" | "heavy" | null;
  spendCapUsd: number | null;
}

export interface RoutingRule {
  id: string;
  projectId: string | null;
  name: string;
  priority: number;
  enabled: boolean;
  matchText: string | null;
  matchTier: "light" | "standard" | "heavy" | null;
  setTier: "light" | "standard" | "heavy" | null;
  setModelId: string | null;
  setNodeId: string | null;
}

export interface NodeSummary {
  id: string;
  name: string;
  status: "online" | "offline" | "revoked";
  os: string | null;
  arch: string | null;
  capabilities: string[];
  /* What applies — the fleet's setting when one has been made. */
  maxConcurrentTasks: number;
  /* What the machine itself reports, and the override if any, so the
     interface can explain a number that differs from the box's own config. */
  reportedConcurrency: number;
  concurrencyOverride: number | null;
  /* What daemon this machine is running, and whether the server has a newer
     one to give it. */
  version: string | null;
  updateAvailable: boolean;
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
  tier: "light" | "standard" | "heavy";
  tierSource: "inferred" | "manual";
  contextWindow: number | null;
  enabled: boolean;
  /* USD per million tokens. Null means unpriced — which means it accrues no
     spend, and so slips past every cap. */
  priceInPerMTok: number | null;
  priceOutPerMTok: number | null;
  priceSource: "provider" | "inferred" | "manual" | null;
  probeOk: boolean | null;
  probeError: string | null;
  /* Which upstream serves it, as the gateway reports it. Null for providers
     that do not say, or for rows added before the field was captured. */
  ownedBy: string | null;
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

export interface WorkspaceEntry {
  nodeId: string;
  nodeName: string;
  path: string;
  provisionedAt: number | null;
}

export interface ProjectNote {
  id: string;
  kind: "directory" | "url" | "port" | "memory";
  label: string | null;
  value: string;
  nodeId: string | null;
  nodeName: string | null;
  createdAt: number;
}

export interface ProjectKnowledge {
  /* The same field as Project.instructions — a project's brief and its
     standing instructions are one thing, prepended to every task. */
  brief: string | null;
  workspaces: WorkspaceEntry[];
  notes: ProjectNote[];
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member" | "viewer";
  permissions: string[];
}

/* One organization read on its own, which carries the routing defaults the
   list view has no use for. */
export interface OrganizationDetail extends Organization {
  defaultTier: "heavy" | "standard" | "light" | null;
  defaultModelId: string | null;
  spendCapUsd: number | null;
  createdAt: number;
}

export interface McpServer {
  id: string;
  name: string;
  placement: "server" | "node";
  transport: "http" | "stdio";
  url: string | null;
  command: string | null;
  args: string[] | null;
  hasHeaders: boolean;
  hasEnv: boolean;
  enabled: boolean;
  toolAllowlist: string[];
  approval: "auto" | "ask" | "never";
  lastError: string | null;
  lastConnectedAt: number | null;
}

export interface ModelListEntry {
  id: string;
  /* Exactly one of these two is set. */
  modelId: string | null;
  groupId: string | null;
  groupName: string | null;
}

export interface ModelList {
  id: string;
  name: string;
  description: string | null;
  createdAt: number;
  entries: ModelListEntry[];
}

export interface ModelGroupMember {
  id: string;
  modelId: string;
}

/* One alias standing in for several ids of the same underlying model — a
   dated snapshot, a routing alias, a per-vendor rename. Members are tried in
   the group's own order. */
export interface ModelGroup {
  id: string;
  name: string;
  createdAt: number;
  members: ModelGroupMember[];
}

export interface GatewayService {
  id: string;
  name: string;
  description: string;
  url: string;
  requiresAccount: boolean;
  connected: boolean;
  alreadyAdded: boolean;
}

export const api = {
  mcpServers: () => request<{ servers: McpServer[] }>("/mcp"),
  discoverGateway: (baseUrl: string, token: string) =>
    post<{ base: string; services: GatewayService[] }>("/mcp/gateway/discover", { baseUrl, token }),
  importGateway: (body: {
    baseUrl: string;
    token: string;
    serviceIds: string[];
    approval: string;
  }) =>
    post<{ added: string[]; skipped: Array<{ id: string; reason: string }> }>(
      "/mcp/gateway/import",
      body,
    ),
  addMcpServer: (body: Record<string, unknown>) => post<{ server: McpServer }>("/mcp", body),
  mcpTools: (id: string) =>
    post<{ tools: Array<{ name: string; description: string }>; note?: string }>(`/mcp/${id}/tools`),
  updateMcpServer: (id: string, body: Record<string, unknown>) =>
    request<{ ok: true }>(`/mcp/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteMcpServer: (id: string) => request<{ ok: true }>(`/mcp/${id}`, { method: "DELETE" }),

  modelLists: () => request<{ lists: ModelList[] }>("/model-lists"),
  createModelList: (name: string, description: string | null) =>
    post<{ list: ModelList }>("/model-lists", { name, description }),
  updateModelList: (id: string, body: { name?: string; description?: string | null }) =>
    request<{ ok: true }>(`/model-lists/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteModelList: (id: string) => request<{ ok: true }>(`/model-lists/${id}`, { method: "DELETE" }),
  addModelListEntry: (listId: string, entry: { modelId: string } | { groupId: string }) =>
    post<{ id: string }>(`/model-lists/${listId}/entries`, entry),
  removeModelListEntry: (listId: string, entryId: string) =>
    request<{ ok: true }>(`/model-lists/${listId}/entries/${entryId}`, { method: "DELETE" }),
  reorderModelList: (listId: string, entryIds: string[]) =>
    request<{ ok: true }>(`/model-lists/${listId}/order`, {
      method: "PUT",
      body: JSON.stringify({ entryIds }),
    }),

  modelGroups: () => request<{ groups: ModelGroup[] }>("/model-groups"),
  createModelGroup: (name: string) => post<{ group: ModelGroup }>("/model-groups", { name }),
  renameModelGroup: (id: string, name: string) =>
    request<{ ok: true }>(`/model-groups/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteModelGroup: (id: string) => request<{ ok: true }>(`/model-groups/${id}`, { method: "DELETE" }),
  addModelGroupMember: (groupId: string, modelId: string) =>
    post<{ id: string }>(`/model-groups/${groupId}/members`, { modelId }),
  removeModelGroupMember: (groupId: string, memberId: string) =>
    request<{ ok: true }>(`/model-groups/${groupId}/members/${memberId}`, { method: "DELETE" }),
  reorderModelGroup: (groupId: string, memberIds: string[]) =>
    request<{ ok: true }>(`/model-groups/${groupId}/order`, {
      method: "PUT",
      body: JSON.stringify({ memberIds }),
    }),

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

  instanceSettings: () =>
    request<{
      smtp: {
        host: string; port: string; security: "tls" | "starttls" | "none";
        username: string; passwordSet: boolean; fromAddress: string; fromName: string;
      };
      registration: { open: boolean; allowedDomain: string };
    }>("/instance/settings"),
  saveInstanceSettings: (body: Record<string, unknown>) =>
    request<{
      smtp: {
        host: string; port: string; security: "tls" | "starttls" | "none";
        username: string; passwordSet: boolean; fromAddress: string; fromName: string;
      };
      registration: { open: boolean; allowedDomain: string };
    }>("/instance/settings", { method: "PUT", body: JSON.stringify(body) }),
  testSmtp: (to: string) => post<{ ok: true }>("/instance/settings/smtp/test", { to }),

  orgs: () => request<{ organizations: Organization[] }>("/orgs"),
  createOrg: (name: string) => post<{ organization: Organization }>("/orgs", { name }),
  org: (orgId: string) => request<{ organization: OrganizationDetail }>(`/orgs/${orgId}`),
  updateOrg: (orgId: string, body: Record<string, unknown>) =>
    request<{ ok: true }>(`/orgs/${orgId}`, { method: "PATCH", body: JSON.stringify(body) }),
  setMemberRole: (orgId: string, userId: string, role: string) =>
    request<{ ok: true }>(`/orgs/${orgId}/members/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),
  removeMember: (orgId: string, userId: string) =>
    request<{ ok: true }>(`/orgs/${orgId}/members/${userId}`, { method: "DELETE" }),
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
  updateProject: (id: string, body: Partial<Project>) =>
    request<{ project: Project }>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

  rules: (projectId: string) => request<{ rules: RoutingRule[] }>(`/rules?projectId=${projectId}`),
  createRule: (body: Partial<RoutingRule> & { name: string; projectId: string }) =>
    post<{ rule: RoutingRule }>("/rules", body),
  updateRule: (id: string, body: Partial<RoutingRule>) =>
    request<{ ok: true }>(`/rules/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteRule: (id: string) => request<{ ok: true }>(`/rules/${id}`, { method: "DELETE" }),

  nodes: () => request<{ nodes: NodeSummary[] }>("/nodes"),
  enrollNode: (projectId?: string) =>
    post<{ token: string; command: string; expiresInMs: number }>("/nodes/enroll", { projectId }),
  renameNode: (id: string, name: string) =>
    request<{ ok: true }>(`/nodes/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  /* null hands the machine back its own configured number. */
  setNodeConcurrency: (id: string, maxConcurrentTasks: number | null) =>
    request<{ ok: true }>(`/nodes/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ maxConcurrentTasks }),
    }),
  /* Waits for the node to finish what it is running, so this resolves once the
     update is actually on its way rather than merely requested. */
  updateNode: (id: string) =>
    request<{ ok: boolean; detail: string }>(`/nodes/${id}/update`, { method: "POST" }),
  revokeNode: (id: string) => request<{ ok: true }>(`/nodes/${id}`, { method: "DELETE" }),

  providers: () => request<{ providers: Provider[] }>("/providers"),
  addProvider: (body: { name: string; kind: string; baseUrl: string; apiKey: string }) =>
    post<{ provider: Provider }>("/providers", body),
  refreshProvider: (id: string) =>
    post<{ count: number; usable: number; removed: number }>(`/providers/${id}/refresh`),
  /* Turns a whole upstream on or off — every model that provider serves on
     this connection, in one call. */
  setOwnerEnabled: (providerId: string, ownedBy: string, enabled: boolean) =>
    request<{ ok: true; models: number }>(
      `/providers/${providerId}/owners/${encodeURIComponent(ownedBy)}`,
      { method: "PATCH", body: JSON.stringify({ enabled }) },
    ),
  deleteProvider: (id: string) => request<{ ok: true }>(`/providers/${id}`, { method: "DELETE" }),
  setModelTier: (providerId: string, modelId: string, tier: string) =>
    request<{ ok: true }>(`/providers/${providerId}/models/${encodeURIComponent(modelId)}`, {
      method: "PATCH",
      body: JSON.stringify({ tier }),
    }),
  setModelPrice: (
    providerId: string,
    modelId: string,
    price: { priceInPerMTok: number | null; priceOutPerMTok: number | null },
  ) =>
    request<{ ok: true }>(`/providers/${providerId}/models/${encodeURIComponent(modelId)}`, {
      method: "PATCH",
      body: JSON.stringify(price),
    }),
  setModelEnabled: (providerId: string, modelId: string, enabled: boolean) =>
    request<{ ok: true }>(`/providers/${providerId}/models/${encodeURIComponent(modelId)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),
  reclassifyModels: (providerId: string) =>
    post<{ reclassified: number }>(`/providers/${providerId}/models/reclassify`),

  knowledge: (projectId: string) =>
    request<ProjectKnowledge>(`/knowledge?projectId=${encodeURIComponent(projectId)}`),
  setProjectBrief: (projectId: string, text: string | null) =>
    request<{ ok: true }>("/knowledge/brief", {
      method: "PUT",
      body: JSON.stringify({ projectId, text }),
    }),
  setWorkspacePath: (projectId: string, nodeId: string, path: string) =>
    request<{ ok: true }>("/knowledge/workspace", {
      method: "PUT",
      body: JSON.stringify({ projectId, nodeId, path }),
    }),
  addProjectFact: (
    projectId: string,
    kind: "directory" | "url" | "port",
    label: string,
    value: string,
    nodeId?: string | null,
  ) => post<{ id: string }>("/knowledge/facts", { projectId, kind, label, value, nodeId }),
  addProjectMemory: (projectId: string, text: string) =>
    post<{ id: string }>("/knowledge/memories", { projectId, text }),
  deleteProjectNote: (id: string) =>
    request<{ ok: true }>(`/knowledge/notes/${id}`, { method: "DELETE" }),

  tasks: (projectId?: string) =>
    request<{ tasks: TaskSummary[] }>(`/tasks${projectId ? `?projectId=${projectId}` : ""}`),
  task: (id: string) => request<{ task: TaskDetail; events: TaskEvent[] }>(`/tasks/${id}`),
  createTask: (body: { projectId: string; prompt: string; model?: string; nodeId?: string }) =>
    post<{ task: { id: string; title: string; status: TaskStatus } }>("/tasks", body),
  planTask: (body: { projectId: string; prompt: string; nodeId?: string; model?: string }) =>
    post<{
      node: { picked: { id: string; name: string }; because: string; alternatives: Array<{ id: string; name: string }> } | null;
      model: { picked: { id: string; tier: string }; because: string; alternatives: Array<{ id: string; tier: string }> } | null;
      tier: string;
      approvals: string;
      blocked?: string;
    }>("/tasks/plan", body),
  steer: (id: string, text: string) => post<{ ok: true }>(`/tasks/${id}/steer`, { text }),
  cancelTask: (id: string) => post<{ ok: true }>(`/tasks/${id}/cancel`),
  approve: (id: string, callId: string, approved: boolean) =>
    post<{ ok: true }>(`/tasks/${id}/approve`, { callId, approved }),

  askConductor: (
    question: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    scope?: {
      projectId?: string;
      pinnedModel?: string;
      pinnedModelList?: string;
      pinnedNodeId?: string;
      conductorModel?: string;
    },
  ) =>
    post<{
      text: string;
      usedTools: Array<{ name: string; args: unknown }>;
      /* Task ids this turn dispatched, taken from the tool's own result. */
      dispatched: string[];
      usage: { inputTokens: number; outputTokens: number };
      model: string;
    }>("/conductor/ask", { question, history, ...scope }),

  /* The models the Conductor itself may run on: its profile's usable members,
     best first. The picker offers only these. */
  conductorModels: (projectId?: string) =>
    request<{ profile: string; models: string[] }>(
      `/conductor/models${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    ),
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
