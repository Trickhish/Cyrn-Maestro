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
    /* Which upstream actually serves this model, as the gateway reports it.
       A proxy in front of a dozen vendors is one connection but many
       providers, and that is the grouping worth seeing and turning off. */
    ownedBy: text("owned_by"),
    /* The underlying model, as the gateway reports it. Several ids routinely
       point at one root — "cc/claude-opus-5" and "claude/claude-opus-5" are
       the same model behind two prefixes — and that is the duplication worth
       collapsing. `parent`, by contrast, links an effort variant to its base
       ("-low", "-high"), which are genuinely different and kept apart. */
    root: text("root"),
    parent: text("parent"),
    /* USD per million tokens. Null when neither the provider nor the price
       table knows one — the UI says "unpriced" rather than quietly showing
       $0.00, because an unpriced model accrues no spend and so slips past
       every cap. */
    priceInPerMTok: real("price_in_per_mtok"),
    priceOutPerMTok: real("price_out_per_mtok"),
    /* Same reasoning as tierSource: a price corrected by hand must survive a
       refresh, or published-price drift silently overwrites the real number. */
    priceSource: text("price_source", { enum: ["provider", "inferred", "manual"] }),
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

/* A named, ordered fallback chain of models for one kind of work — "difficult
 * programming", "tester", "decision maker" — with a short description of when
 * it applies. Not the tier system: a tier is a coarse, automatic guess from a
 * model's name, used for routing rules and defaults; a list is curated by
 * hand, named for a purpose rather than a size, and meant to be read by
 * whatever ends up choosing a model per task — the description is written for
 * that reader, not for a human skimming a settings page.
 *
 * Entries store the model's string id rather than a foreign key to one
 * provider's `models` row, matching how a routing rule's `setModelId` already
 * works: the same model id can be served by more than one provider
 * connection, and "tried one by one until one is available" means available
 * from any of them, not tied to where it was when the list was built. */
export const modelLists = sqliteTable(
  "model_lists",
  {
    id: id(),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    ownerOrgId: text("owner_org_id").references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: now(),
  },
  (t) => [
    unique("model_lists_user_name_unique").on(t.ownerUserId, t.name),
    unique("model_lists_org_name_unique").on(t.ownerOrgId, t.name),
    index("model_lists_org_idx").on(t.ownerOrgId),
  ],
);

/* Many providers and proxies re-publish the same underlying model under a
 * different id — a dated snapshot, a routing alias, a per-vendor rename.
 * "Claude Opus" can easily be a dozen ids across a real fleet. A group is a
 * name for that: one alias standing in for whichever of its members actually
 * resolves, tried in the group's own order (cost, usually, is why they are
 * not interchangeable) — so a list is built from "Claude Opus" once rather
 * than every variant of it individually. */
export const modelGroups = sqliteTable(
  "model_groups",
  {
    id: id(),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    ownerOrgId: text("owner_org_id").references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: now(),
  },
  (t) => [
    unique("model_groups_user_name_unique").on(t.ownerUserId, t.name),
    unique("model_groups_org_name_unique").on(t.ownerOrgId, t.name),
    index("model_groups_org_idx").on(t.ownerOrgId),
  ],
);

export const modelGroupMembers = sqliteTable(
  "model_group_members",
  {
    id: id(),
    groupId: text("group_id")
      .notNull()
      .references(() => modelGroups.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    position: integer("position").notNull(),
    createdAt: now(),
  },
  (t) => [
    unique("model_group_members_unique").on(t.groupId, t.modelId),
    index("model_group_members_group_idx").on(t.groupId),
  ],
);

export const modelListEntries = sqliteTable(
  "model_list_entries",
  {
    id: id(),
    listId: text("list_id")
      .notNull()
      .references(() => modelLists.id, { onDelete: "cascade" }),
    /* Exactly one of these two is set, enforced in the route rather than a
       DB constraint — the same XOR-by-convention the owner columns already
       use throughout this schema. A plain entry names one model; a group
       entry stands in for whichever of the group's own members is available. */
    modelId: text("model_id"),
    groupId: text("group_id").references(() => modelGroups.id, { onDelete: "cascade" }),
    /* Preference order, lowest first. An explicit column rather than row
       order because SQL never promises to hand rows back in insertion order —
       relying on that is how a list quietly reshuffles itself one day. */
    position: integer("position").notNull(),
    createdAt: now(),
  },
  (t) => [
    unique("model_list_entries_model_unique").on(t.listId, t.modelId),
    unique("model_list_entries_group_unique").on(t.listId, t.groupId),
    index("model_list_entries_list_idx").on(t.listId),
  ],
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
    /* Lets the Conductor answer a worker's approval prompt instead of stopping
       to ask a human. Off by default and per project, because it hands one
       model's judgement the decision a person was being asked to make. The
       node's own refuse list is unaffected — see apps/node/src/policy.ts, which
       still blocks what it blocks no matter who approved it. */
    conductorApproves: integer("conductor_approves", { mode: "boolean" })
      .notNull()
      .default(false),
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
    /* What the node itself reports, refreshed on every register. */
    maxConcurrentTasks: integer("max_concurrent_tasks").notNull().default(2),
    /* What the fleet was told to use instead, if anything. Kept apart from the
       reported value rather than overwriting it, so a node reconnecting does
       not silently undo the setting — and so clearing the override restores
       the machine's own number rather than a guess at what it used to be. */
    concurrencyOverride: integer("concurrency_override"),
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

/* What a project knows about itself, beyond code: where things live, what a
 * URL or a port means, and anything worth remembering between tasks. A fresh
 * project usually already exists somewhere — a checkout on a machine, a
 * staging URL, a port nothing else uses — and re-deriving that from scratch
 * every conversation is exactly the kind of thing an agent should be able to
 * write down once and stop asking about.
 *
 * "directory" beyond the workspace root (that lives on `workspaces.path`
 * itself, since it already has exactly this shape), "url" and "port" are
 * facts with a name — calling set_project_fact again with the same label
 * replaces the value rather than piling up duplicates, enforced by the unique
 * index below. "memory" is different in kind: free text, never overwritten,
 * append-only — so its label is always null, which the unique index leaves
 * alone (SQLite does not treat two NULLs as equal for uniqueness). */
/* What was said to the Conductor, and back.
 *
 * Losing the thread on every reload is what made it feel like a stranger each
 * time — and it costs the model the one thing that makes a follow-up useful:
 * what you just asked it to do.
 *
 * Bounded on purpose. A conversation is worth keeping for continuity, not
 * forever: the oldest are trimmed on write, so a thread stays a working memory
 * rather than an archive nobody reads and everybody pays to store.
 *
 * One thread per person per project — the panel is per-project, and the global
 * screen is its own thread with a null projectId. Not shared between members:
 * a colleague's half-finished conversation is confusing context, not helpful
 * context. */
export const conductorMessages = sqliteTable(
  "conductor_messages",
  {
    id: id(),
    /* Null for the global, cross-project screen. */
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    /* Which model answered, so a thread read back later still says what said
       what — the profile can change between one turn and the next. */
    model: text("model"),
    /* The tool calls behind an answer, so a reloaded thread still shows its
       work. Without them the receipt survives only until the page is
       refreshed, which is exactly when someone goes looking for it. */
    tools: text("tools", { mode: "json" }),
    createdAt: now(),
  },
  (t) => [index("conductor_messages_thread_idx").on(t.actorUserId, t.projectId, t.createdAt)],
);

export const projectNotes = sqliteTable(
  "project_notes",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["directory", "url", "port", "memory"] }).notNull(),
    label: text("label"),
    value: text("value").notNull(),
    /* A path or a port is only ever meaningful on one machine; a URL usually
       is not. Nullable throughout rather than restricted to "directory", so a
       memory or a URL can still say which node it is about when that matters. */
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "set null" }),
    createdAt: now(),
  },
  (t) => [
    index("project_notes_project_idx").on(t.projectId),
    unique("project_notes_label_unique").on(t.projectId, t.kind, t.label),
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

/* MCP servers, owned by a user or an organization.
 *
 * Owner-wide rather than per project: a connection to GitHub or a database is
 * a fact about the team, not about one repository, and configuring it once per
 * project would mean re-entering the same credential everywhere. The same
 * (user XOR org) column that gates every other resource decides who can see
 * and use it.
 *
 * Two placements, chosen by where the thing being reached lives:
 *
 *   server — remote HTTP, connected by the Maestro server. Credentials stay on
 *   the server and a node never sees them. The default for anything SaaS.
 *
 *   node — a stdio process spawned on the machine, for things that need to be
 *   on it: a database on a private network, a browser, an internal CLI.
 *
 * Either way the model sees one merged, namespaced tool list. */
export const mcpServers = sqliteTable(
  "mcp_servers",
  {
    id: id(),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    ownerOrgId: text("owner_org_id").references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /* What this server is for, in one line — "IP, websites and domains".
       Models are shown servers rather than every tool on them, so this is
       what they choose by: with nine servers and a hundred tools, a name
       alone is not enough to pick from. */
    description: text("description"),
    placement: text("placement", { enum: ["server", "node"] }).notNull(),
    transport: text("transport", { enum: ["http", "stdio"] }).notNull(),

    /* http */
    url: text("url"),
    /* Encrypted, write-only through the API, like every other credential. */
    encryptedHeaders: text("encrypted_headers"),

    /* stdio */
    command: text("command"),
    args: text("args", { mode: "json" }).$type<string[]>(),
    encryptedEnv: text("encrypted_env"),

    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /* An MCP server can advertise forty tools and a project rarely wants all
       forty in context. Empty means "all of them". */
    toolAllowlist: text("tool_allowlist", { mode: "json" }).$type<string[]>().notNull().default([]),
    /* Per-server default: auto runs freely, ask escalates, never refuses. */
    approval: text("approval", { enum: ["auto", "ask", "never"] })
      .notNull()
      .default("ask"),

    lastError: text("last_error"),
    lastConnectedAt: integer("last_connected_at"),
    createdAt: now(),
  },
  (t) => [
    /* The name is the tool namespace, so it has to be unique within whoever
       owns it — two servers called "github" would produce colliding tool
       names the model could not tell apart. */
    unique("mcp_user_name_unique").on(t.ownerUserId, t.name),
    unique("mcp_org_name_unique").on(t.ownerOrgId, t.name),
    index("mcp_owner_user_idx").on(t.ownerUserId),
    index("mcp_owner_org_idx").on(t.ownerOrgId),
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
    /* True only when the caller named this exact model, not when the router
       picked it by default. A pin means "this model or fail" — failover
       exists for the router's own choices and for model lists, not for a
       direct call the caller made on purpose. */
    modelPinned: integer("model_pinned", { mode: "boolean" }).notNull().default(false),
    costUsd: real("cost_usd").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    error: text("error"),
    /* Set when the Conductor dispatched this task, naming the thread to report
       back into: the user whose conversation it was, and which of their threads
       (a project's own, or null for the global one — which is not the same as
       the task's own projectId, since the global Conductor dispatches into
       projects too). Null means a human dispatched it directly, and nothing
       follows up. */
    conductorActorId: text("conductor_actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    conductorProjectId: text("conductor_project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    /* Set the moment a follow-up is claimed, before the model call — the claim
       is what stops a restart or a second trigger from reporting twice. */
    conductorFollowedUp: integer("conductor_followed_up", { mode: "boolean" })
      .notNull()
      .default(false),
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
    /* Set when the Conductor answered instead of a person. `decidedBy` stays
       null for those — it is a foreign key to a real account, and recording a
       machine decision as if a user made it would be a lie in the audit
       trail. */
    decidedByConductor: integer("decided_by_conductor", { mode: "boolean" })
      .notNull()
      .default(false),
    /* Why it decided that, so the trail explains itself later. */
    decisionReason: text("decision_reason"),
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
