import { sqliteTable, text, integer, real, index, unique } from "drizzle-orm/sqlite-core";

/* v0.1 schema.
 *
 * Two shapes here are deliberately built for a future the spine does not yet
 * have, because retrofitting them means touching every query:
 *
 *   ownerUserId / ownerOrgId — the (user XOR org) pair from the README. v0.1
 *   only ever writes ownerUserId, but "whose credentials pay for this task" is
 *   already a lookup on the same column that gates visibility, so tenancy
 *   later is a migration rather than a rewrite.
 *
 *   task_events — append-only, sequence-numbered per task. The live thread and
 *   a thread opened months later are the same render over these rows.
 *
 * Types are SQLite's but the shapes are Postgres-safe: no SQLite-only column
 * types, timestamps as integer epoch millis, JSON as text. */

const id = () => text("id").primaryKey();
const now = () => integer("created_at").notNull();

export const users = sqliteTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    /* "instance_admin" runs the server; it does not grant access to other
       people's work. See the README's two-levels-of-authority section. */
    instanceRole: text("instance_role", { enum: ["instance_admin", "user"] })
      .notNull()
      .default("user"),
    status: text("status", { enum: ["active", "suspended"] })
      .notNull()
      .default("active"),
    createdAt: now(),
  },
  (t) => [unique("users_email_unique").on(t.email)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /* Only the hash is stored, so a database leak does not hand over live
       sessions. Server-side rows mean revocation is immediate. */
    tokenHash: text("token_hash").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    expiresAt: integer("expires_at").notNull(),
    createdAt: now(),
  },
  (t) => [
    unique("sessions_token_unique").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
  ],
);

export const providerConnections = sqliteTable(
  "provider_connections",
  {
    id: id(),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    ownerOrgId: text("owner_org_id"),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["openai_compatible", "anthropic"] }).notNull(),
    baseUrl: text("base_url").notNull(),
    /* AES-256-GCM under MAESTRO_SECRET_KEY. There is no read path back out
       through the API — the gateway decrypts in-process at call time only. */
    encryptedKey: text("encrypted_key").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastHealthAt: integer("last_health_at"),
    lastHealthOk: integer("last_health_ok", { mode: "boolean" }),
    createdAt: now(),
  },
  (t) => [index("providers_owner_idx").on(t.ownerUserId)],
);

export const models = sqliteTable(
  "models",
  {
    id: id(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providerConnections.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    tier: text("tier", { enum: ["heavy", "standard", "light"] })
      .notNull()
      .default("standard"),
    contextWindow: integer("context_window"),
    /* USD per million tokens. Null when the provider does not publish a price
       — the UI says "unpriced" rather than quietly showing $0.00. */
    priceInPerMTok: real("price_in_per_mtok"),
    priceOutPerMTok: real("price_out_per_mtok"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /* A provider's model list over-advertises: it names models it cannot route,
       and models that need parameters it does not send by default. Probing
       records the reason so the UI can say why a model is unavailable rather
       than hiding it and leaving the user to guess. */
    probedAt: integer("probed_at"),
    probeOk: integer("probe_ok", { mode: "boolean" }),
    probeError: text("probe_error"),
    /* Claude models on CLIProxyAPI refuse a plain request with "clear_thinking
       strategy requires thinking to be enabled" and succeed once reasoning is
       requested. Recorded per model because it is a property of the model, not
       of the provider — sending it unconditionally changes behaviour and cost
       for models that never needed it. */
    needsReasoningEffort: integer("needs_reasoning_effort", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (t) => [unique("models_provider_model_unique").on(t.providerId, t.modelId)],
);

export const projects = sqliteTable(
  "projects",
  {
    id: id(),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    ownerOrgId: text("owner_org_id"),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    repoUrl: text("repo_url"),
    branch: text("branch").default("main"),
    /* Prepended to every task's system prompt. */
    instructions: text("instructions"),
    defaultModelId: text("default_model_id"),
    spendCapUsd: real("spend_cap_usd"),
    createdAt: now(),
  },
  (t) => [unique("projects_owner_slug_unique").on(t.ownerUserId, t.slug)],
);

export const nodes = sqliteTable(
  "nodes",
  {
    id: id(),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    ownerOrgId: text("owner_org_id"),
    name: text("name").notNull(),
    /* Hash only, and revocable: deleting the row drops the node at its next
       frame. The plaintext is shown to the daemon once, over the socket. */
    tokenHash: text("token_hash").notNull(),
    status: text("status", { enum: ["online", "offline", "revoked"] })
      .notNull()
      .default("offline"),
    os: text("os"),
    arch: text("arch"),
    version: text("version"),
    capabilities: text("capabilities", { mode: "json" }).$type<string[]>().notNull().default([]),
    maxConcurrentTasks: integer("max_concurrent_tasks").notNull().default(2),
    lastSeenAt: integer("last_seen_at"),
    loadPercent: real("load_percent"),
    createdAt: now(),
  },
  (t) => [
    unique("nodes_token_unique").on(t.tokenHash),
    index("nodes_owner_idx").on(t.ownerUserId),
  ],
);

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    branch: text("branch"),
    provisionedAt: integer("provisioned_at"),
    createdAt: now(),
  },
  (t) => [
    unique("workspaces_project_node_unique").on(t.projectId, t.nodeId),
    index("workspaces_node_idx").on(t.nodeId),
  ],
);

export const enrollmentTokens = sqliteTable(
  "enrollment_tokens",
  {
    id: id(),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    ownerOrgId: text("owner_org_id"),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /* Single use, 15 minutes. Burned the moment a daemon exchanges it, which
       is what makes the curl|sh one-liner safe to leave in shell history. */
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
    createdAt: now(),
  },
  (t) => [unique("enrollment_token_unique").on(t.tokenHash)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "set null" }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    status: text("status", {
      enum: [
        "queued",
        "assigned",
        "running",
        "awaiting_approval",
        "completed",
        "failed",
        "cancelled",
      ],
    })
      .notNull()
      .default("queued"),
    /* The model in play right now. The router may change it mid-task, so the
       authoritative per-call record is the usage events, not this column. */
    model: text("model"),
    costUsd: real("cost_usd").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    error: text("error"),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
    createdAt: now(),
  },
  (t) => [
    index("tasks_project_idx").on(t.projectId),
    index("tasks_status_idx").on(t.status),
  ],
);

export const taskEvents = sqliteTable(
  "task_events",
  {
    id: id(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /* Per-task, gap-free, assigned under the same transaction as the insert.
       The UI resumes a live stream by asking for everything after its last seq. */
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    at: integer("at").notNull(),
  },
  (t) => [
    unique("task_events_seq_unique").on(t.taskId, t.seq),
    index("task_events_task_idx").on(t.taskId),
  ],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: id(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    callId: text("call_id").notNull(),
    tool: text("tool").notNull(),
    summary: text("summary").notNull(),
    reason: text("reason").notNull(),
    approved: integer("approved", { mode: "boolean" }),
    decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: integer("decided_at"),
    requestedAt: integer("requested_at").notNull(),
  },
  (t) => [
    unique("approvals_call_unique").on(t.taskId, t.callId),
    index("approvals_task_idx").on(t.taskId),
  ],
);

export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Node = typeof nodes.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type ProviderConnection = typeof providerConnections.$inferSelect;
export type Model = typeof models.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
