import { sqliteTable, text, integer, real, index, unique } from "drizzle-orm/sqlite-core";

/* Schema.
 *
 * Two shapes carry most of the weight:
 *
 *   ownerUserId / ownerOrgId — the (user XOR org) pair from the README. Exactly
 *   one is set on every ownable row. Because "whose credentials pay for this
 *   task" is a lookup on the same column that gates visibility, the two can
 *   never drift apart into a state where you can see something you cannot bill
 *   to, or bill something you cannot see. Building it before organizations
 *   existed is what made v0.3 a migration rather than a rewrite.
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
    /* Encrypted at rest like any other credential: a database leak should not
       hand over the ability to generate valid second factors. */
    totpSecret: text("totp_secret"),
    totpEnabledAt: integer("totp_enabled_at"),
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

/* Instance-wide configuration, set through the interface rather than the
   environment so an administrator can change it without a redeploy.
 *
 * Key-value rather than a typed row: settings accrete, and a column per
 * setting means a migration every time one is added. The `secret` flag marks
 * values encrypted at rest — an SMTP password is a credential like any other,
 * and is never returned by the API. */
export const instanceSettings = sqliteTable("instance_settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  secret: integer("secret", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at").notNull(),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
});

/* Single-use, short-lived, hashed. A reset link is emailed, and email is not a
   secure channel, so the token has to be worth as little as possible for as
   short a time as possible. */
export const passwordResets = sqliteTable(
  "password_resets",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
    requestedIp: text("requested_ip"),
    createdAt: now(),
  },
  (t) => [
    unique("password_reset_token_unique").on(t.tokenHash),
    index("password_reset_user_idx").on(t.userId),
  ],
);

export const organizations = sqliteTable(
  "organizations",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /* An org admin can require it for everyone; enforcement lands with TOTP. */
    require2fa: integer("require_2fa", { mode: "boolean" }).notNull().default(false),
    /* The outermost ring of the override ladder: what every project in this
       org gets unless the project, a rule, or the task itself says otherwise. */
    defaultModelId: text("default_model_id"),
    defaultTier: text("default_tier", { enum: ["heavy", "standard", "light"] }),
    spendCapUsd: real("spend_cap_usd"),
    createdAt: now(),
  },
  (t) => [unique("organizations_slug_unique").on(t.slug)],
);

export const memberships = sqliteTable(
  "memberships",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member", "viewer"] }).notNull(),
    createdAt: now(),
  },
  (t) => [
    /* One role per person per org: two rows would make "what can they do"
       ambiguous, and the answer would depend on row order. */
    unique("memberships_user_org_unique").on(t.userId, t.orgId),
    index("memberships_org_idx").on(t.orgId),
    index("memberships_user_idx").on(t.userId),
  ],
);

/* Single-use, hashed, for the day the phone is lost. */
export const recoveryCodes = sqliteTable(
  "recovery_codes",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: integer("used_at"),
    createdAt: now(),
  },
  (t) => [
    unique("recovery_code_unique").on(t.codeHash),
    index("recovery_user_idx").on(t.userId),
  ],
);

export const invitations = sqliteTable(
  "invitations",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ["owner", "admin", "member", "viewer"] }).notNull(),
    /* Hash only, single use — same reasoning as an enrollment token: the link
       travels through email, which is not a secure channel. */
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: integer("expires_at").notNull(),
    acceptedAt: integer("accepted_at"),
    createdAt: now(),
  },
  (t) => [
    unique("invitations_token_unique").on(t.tokenHash),
    index("invitations_org_idx").on(t.orgId),
  ],
);

/* Append-only. Owners and admins read it; nothing in the interface deletes
   from it, which is the whole point of having it. */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: id(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /* Kept even when the user row goes, so the record survives a deletion. */
    actorEmail: text("actor_email"),
    action: text("action").notNull(),
    target: text("target"),
    metadata: text("metadata", { mode: "json" }),
    at: integer("at").notNull(),
  },
  (t) => [index("audit_org_idx").on(t.orgId), index("audit_at_idx").on(t.at)],
);

export const providerConnections = sqliteTable(
  "provider_connections",
  {
    id: id(),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    ownerOrgId: text("owner_org_id").references(() => organizations.id, { onDelete: "cascade" }),
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
    /* Where the tier came from. Refreshing a provider re-classifies models it
       guessed at, but never overwrites one a human corrected — otherwise every
       refresh would silently undo the correction, which is the kind of bug
       that makes people stop trusting the setting. */
    tierSource: text("tier_source", { enum: ["inferred", "manual"] })
      .notNull()
      .default("inferred"),
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
    ownerOrgId: text("owner_org_id").references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    repoUrl: text("repo_url"),
    branch: text("branch").default("main"),
    /* Prepended to every task's system prompt. */
    instructions: text("instructions"),
    defaultModelId: text("default_model_id"),
    defaultTier: text("default_tier", { enum: ["heavy", "standard", "light"] }),
    spendCapUsd: real("spend_cap_usd"),
    createdAt: now(),
  },
  (t) => [
    unique("projects_owner_slug_unique").on(t.ownerUserId, t.slug),
    unique("projects_org_slug_unique").on(t.ownerOrgId, t.slug),
    index("projects_org_idx").on(t.ownerOrgId),
  ],
);

export const nodes = sqliteTable(
  "nodes",
  {
    id: id(),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    ownerOrgId: text("owner_org_id").references(() => organizations.id, { onDelete: "cascade" }),
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
    ownerOrgId: text("owner_org_id").references(() => organizations.id, { onDelete: "cascade" }),
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

/* Routing rules.
 *
 * Evaluated in priority order, project rules before organization ones, and the
 * first match wins. A rule is a stated intention — "refactors go to the big
 * model on the big machine" — which is why the reason it fired is carried into
 * the routing decision rather than the choice appearing unexplained. */
export const routingRules = sqliteTable(
  "routing_rules",
  {
    id: id(),
    /* Exactly one of these: a rule belongs either to one project or to a whole
       organization. */
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    ownerOrgId: text("owner_org_id").references(() => organizations.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    /* Lower runs first. Ties break on creation order, which is stable. */
    priority: integer("priority").notNull().default(100),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),

    /* What to match. Null fields are ignored, so a rule with only matchTier
       fires on every task the router weighed at that tier. */
    matchText: text("match_text"),
    matchTier: text("match_tier", { enum: ["heavy", "standard", "light"] }),

    /* What to do. Again, null means "leave it to the next level down". */
    setTier: text("set_tier", { enum: ["heavy", "standard", "light"] }),
    setModelId: text("set_model_id"),
    setNodeId: text("set_node_id").references(() => nodes.id, { onDelete: "set null" }),

    createdAt: now(),
  },
  (t) => [
    index("routing_rules_project_idx").on(t.projectId),
    index("routing_rules_org_idx").on(t.ownerOrgId),
  ],
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
export type Organization = typeof organizations.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type OrgRole = Membership["role"];
export type Project = typeof projects.$inferSelect;
export type Node = typeof nodes.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type ProviderConnection = typeof providerConnections.$inferSelect;
export type Model = typeof models.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
