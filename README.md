# Maestro

Maestro is an AI orchestration webapp. It coordinates a fleet of remote coding agents and delegates each task to the right node and the right model.

Everything is organised around **projects**. A project gathers its machines, its models, its skills, its tools and its task history in one place — you open a project, describe what you want, and Maestro decides where to run it and which model should drive it, while you watch the agent read files, edit them and run commands in real time. Every one of those decisions is overridable.

Projects belong to a person or to an **organization**, and that ownership determines whose provider accounts pay for the inference.

---

## 1. Concepts

| Term | Meaning |
| --- | --- |
| **User** | An account in Maestro's own user database. Owns personal projects, may belong to any number of organizations. |
| **Organization** | A shared tenant. Owns its own provider connections, nodes, projects, skills and secrets, with members and roles. |
| **Project** | The unit everything hangs off: a codebase, the nodes that can build it, its model preferences, skills, MCP servers, tasks and history. Owned by a user or an organization. |
| **Central server** | The single always-on process. Hosts the webapp, owns all state, holds all provider credentials, and drives the agent loop. |
| **Reverse node** | A machine that executes work. Dials *out* to the server over a WebSocket, so it needs no public IP and no inbound firewall rule. |
| **Workspace** | A project checked out on a node — the binding between the logical project and a physical machine. One project can have many; one node can host many. |
| **Task** | One unit of work inside a project: a prompt plus a target workspace. In the UI it is a conversation. Produces a stream of events and, usually, a diff. |
| **Conductor** | The one central, long-lived chat that sits above every project. Talks to Maestro itself: reports on the whole fleet, and dispatches and steers tasks on your behalf. |
| **Skill** | A packaged procedure — instructions plus optional scripts — that the agent can load when a task calls for it. |
| **MCP server** | An external tool source connected over the Model Context Protocol, exposing its tools to the agent alongside the built-in ones. |
| **Provider connection** | A configured source of model inference, owned by a user or an organization — an API key provider (OpenAI, Anthropic, DeepSeek…) or an OAuth-backed subscription account. |
| **Router** | The component that picks `(workspace, model)` for a task. |

---

## 2. Architecture

```
                    browser (React)
                          │  HTTP + WS (UI stream)
                          ▼
              ┌───────────────────────┐
              │    CENTRAL SERVER     │
              │                       │
              │  webapp + REST API    │
              │  auth, orgs, RBAC     │
              │  agent loop           │──── HTTPS ───▶ OpenAI / Anthropic / DeepSeek
              │  router               │──── HTTPS ───▶ CLIProxyAPI (OAuth providers)
              │  provider gateway     │──── MCP ─────▶ remote MCP servers (GitHub, Linear…)
              │  skill + MCP registry │
              │  store (SQLite/PG)    │
              └───────────────────────┘
                    ▲     ▲     ▲
        outbound WS │     │     │   (nodes dial in, server never dials out to them)
              ┌─────┘     │     └─────┐
         ┌────────┐  ┌────────┐  ┌────────┐
         │ node A │  │ node B │  │ node C │
         │ laptop │  │  VPS   │  │  CI box│
         └────────┘  └────────┘  └────────┘
          read/write/bash inside project workspaces
          + local stdio MCP servers
```

### 2.1 The central server

Responsibilities:

- **Webapp + API** — projects, task creation, live streams, node fleet view, provider settings, skills, MCP servers, routing rules.
- **Auth and tenancy** — the user database, sessions, organizations, roles, and the permission check in front of every route (§3).
- **Agent loop** — the server, not the node, owns the conversation. It calls the model, receives tool calls, ships them to the node for execution, feeds results back, and repeats until the model stops.
- **Conductor** — a second, differently-shaped agent loop whose tools are Maestro's own API rather than a workspace: it answers questions about the fleet and dispatches tasks (§5.2).
- **Router** — chooses the workspace and the model per task (§8).
- **Provider gateway** — a single internal interface over every provider, so the loop is model-agnostic and a task can be re-driven by a different model mid-flight. It also enforces *whose* credentials a task may use (§9.3).
- **Skill and MCP registry** — resolves which skills and which tools are in scope for a given project, and assembles the tool list handed to the model.
- **Store** — users, orgs, projects, tasks, event logs, nodes, credentials, rules.

Keeping the loop server-side is deliberate: credentials never leave the server, nodes stay thin and cheap to deploy, and switching model mid-task is a routing decision rather than a redeploy. The cost is one round trip per tool call, which is negligible next to model latency.

### 2.2 The reverse nodes

A node is a small daemon — one binary, one config file, installed with one command (§6). On start it dials the server, authenticates, and announces itself:

```jsonc
{
  "type": "node.register",
  "node": {
    "name": "workhorse",
    "os": "linux",
    "arch": "x86_64",
    "version": "0.1.0",
    "maxConcurrentTasks": 4,
    "workspaces": [
      { "projectId": "maestro", "path": "/srv/maestro", "vcs": "git", "branch": "main" }
    ],
    "capabilities": ["bash", "git", "docker", "node@22", "python@3.12"]
  }
}
```

From then on it does two things: execute tool calls the server sends it, inside a project workspace, and host any local MCP servers that project asks for.

**Tools a node implements**

| Tool | Purpose |
| --- | --- |
| `read_file` | Read a file (with offset/limit for large files). |
| `write_file` | Create or overwrite a file. |
| `edit_file` | Exact-string replacement in an existing file. |
| `list_dir` | List a directory. |
| `glob` | Find files by pattern. |
| `grep` | Search file contents. |
| `bash` | Run a shell command, streaming stdout/stderr, with a timeout. |

Every path is resolved and checked against the workspace root before use; symlinks are resolved before the check. Anything that escapes the workspace is rejected by the node, not by the server — the node is the last line of defence and does not trust the server's paths.

### 2.3 Wire protocol

One WebSocket per node, JSON frames, every message carrying `id` and `type`. Reconnect is exponential backoff with jitter; the node re-registers and reports any tasks it is still running so the server can re-attach rather than duplicate work.

**Server → node**

| Type | Payload |
| --- | --- |
| `task.assign` | task id, workspace id, limits (wall clock, max tool calls) |
| `tool.call` | task id, call id, tool name, arguments |
| `task.cancel` | task id — node kills child processes and unwinds |
| `workspace.provision` | project id, repo URL, branch — clone or update a checkout |
| `skill.sync` | skill bundle to materialise in the workspace |
| `mcp.start` / `mcp.stop` | local stdio MCP server to spawn or kill |
| `mcp.call` | proxied tool call for a node-local MCP server |
| `ping` | liveness probe |

**Node → server**

| Type | Payload |
| --- | --- |
| `node.enroll` | one-time enrollment token, exchanged for a durable node token |
| `node.register` | identity + capabilities + workspaces |
| `node.heartbeat` | load, free disk, running task ids |
| `task.accepted` / `task.rejected` | with a reason (at capacity, unknown workspace) |
| `tool.result` | call id, ok/error, output (chunked for long output) |
| `tool.approval_request` | tool call the node's policy flags as sensitive |
| `mcp.tools` | tool list advertised by a node-local MCP server |
| `task.log` | raw stdout/stderr chunks for live tailing |
| `task.done` | final status, summary, diff stat |

### 2.4 Trust model

Nodes execute arbitrary commands, so the boundaries are explicit:

- Enrollment tokens are **single-use and short-lived**; the durable node token is issued over the socket and never appears in a shell command or in shell history.
- A node token is scoped to one node and is revocable from the UI.
- A node only ever touches paths under a workspace it declared itself.
- Each node carries a **command policy**: an allowlist of auto-approved command prefixes, a denylist that is always refused, and everything else escalated to `tool.approval_request`, which surfaces in the UI as a blocking prompt on the task. MCP tool calls go through the same policy.
- Nodes hold no provider credentials.
- Task events are append-only, so every command a node ran is auditable after the fact.

---

## 3. Users, organizations and permissions

Maestro keeps its own user database. It is a self-hosted product and must work with no external identity provider configured, so email plus password is the baseline and SSO is an addition, not a prerequisite.

### 3.1 Accounts

- Password hashing with **argon2id**; opaque session tokens in `HttpOnly`, `Secure`, `SameSite=Lax` cookies, stored server-side so a session can be revoked immediately.
- Optional **TOTP two-factor**, enforceable org-wide by an org admin.
- **Personal access tokens** for the API and CI, scoped to one organization and to a set of permissions, with an expiry and a last-used timestamp.
- The **first account to register becomes the instance admin**, after which open registration is off by default — a fresh self-hosted instance should not be a land grab. Growth is by invitation, or by an allowed email domain an instance admin turns on.
- Invitations are single-use links carrying the target org and role.

### 3.2 Two levels of authority

**Instance level** — about running the server, not about the work inside it.

| Role | Can |
| --- | --- |
| `instance_admin` | Manage users, suspend accounts, create and delete organizations, set registration policy, see the whole node fleet, read the audit log, configure instance settings. |
| `user` | Everything else, by way of org and project membership. |

An instance admin is a system operator, not an omniscient reader. They do **not** get task content, repository contents or decrypted secrets for organizations they are not a member of. Access to an org's work requires membership, and an instance admin granting themselves membership is itself an audited event that the org's owners see. The separation is worth the small friction: the person who restarts the server should not silently be able to read every company's source code on it.

**Organization level** — about the work.

| Role | Members | Providers & secrets | Nodes | Projects | Tasks | Org settings |
| --- | --- | --- | --- | --- | --- | --- |
| **Owner** | manage, transfer | manage | manage | manage, delete | run, approve | all, incl. delete org |
| **Admin** | invite, remove | manage | manage | manage | run, approve | all but delete/transfer |
| **Member** | view | view names, use | view | create, edit own | run, approve own | — |
| **Viewer** | view | — | view | view | view only | — |

Permissions are capability strings underneath (`project.create`, `task.run`, `task.approve`, `provider.manage`, `node.enroll`, `member.invite`, `org.settings`, `billing.manage`), and the roles above are named bundles of them. A single `can(actor, permission, scope)` check guards every route and every socket action, so a permission is never enforced only in the UI.

Note what nobody has: **`secret.read` does not exist.** Provider keys, OAuth tokens and MCP secrets are write-only through the API. They go in encrypted, they come out only inside the server process at call time, and no role — instance admin included — can read one back through the interface.

### 3.3 Project-level access

Org role sets the default, and a project may narrow or widen it: a project can be **open** to all org members or **restricted** to an explicit list, and a member can be granted a higher role on one project than they hold in the org. Narrowing wins over widening — a Viewer given `contributor` on one project can run tasks there and nowhere else.

Personal projects are the degenerate case: owner is a user, no org, no roles to manage. A personal project can be transferred into an org, at which point its provider resolution changes to the org's (§9.3) — the UI says so before you confirm.

### 3.4 Audit

Every consequential action is appended to an audit log scoped to its org: logins and failures, invitations, role changes, provider connections added or removed, node enrollment and revocation, approval decisions, project transfers, and any instance-admin action that touched the org. Owners and admins read it in the UI; it is append-only and it is not deletable from the interface.

---

## 4. Projects

The project is the organising unit, and almost every other object in Maestro is scoped to one.

A project owns:

- **Its owner** — a user or an organization. This decides who can see it, which nodes can host it, and whose provider accounts pay for its inference.
- **Its repository** — URL, default branch, and how to check it out.
- **Its workspaces** — which nodes carry a checkout, and where. Adding a node to a project sends a `workspace.provision` and the clone happens without you touching the machine.
- **Its models** — the default tier, any pinned model, spend caps, and which of the owner's providers it is allowed to use.
- **Its skills** — the ones committed in the repo under `.maestro/skills/`, plus any shared skills you attach (§7.1).
- **Its MCP servers** — remote ones connected by the server, local ones spawned on its nodes (§7.2).
- **Its routing rules** — evaluated before the org-wide ones.
- **Its instructions** — a project-level `AGENTS.md`/`.maestro/instructions.md` prepended to every task's system prompt: conventions, build commands, what not to touch.
- **Its history** — every task, diff, cost and routing decision, searchable, attributed to the member who ran it.

Repo layout convention:

```
your-project/
└── .maestro/
    ├── instructions.md      # project instructions for every task
    ├── skills/              # skills committed alongside the code
    │   └── deploy/
    │       ├── SKILL.md
    │       └── scripts/
    └── mcp.json             # MCP servers this project wants
```

Anything under `.maestro/` is versioned with the code, so a project's agent configuration travels with the branch and is reviewable in a pull request.

---

## 5. The interface

### 5.1 The organising idea

A Claude Code session is one conversation with one agent. Maestro runs many at once. The reconciliation is **two levels of conversation**:

> **A task *is* a conversation** — one task, one thread, the full Claude Code experience with one agent on one machine.
>
> **The Conductor is the conversation about all of them** — one long-lived central chat where the whole fleet reports in and from which you can dispatch work anywhere.

You never need a "multi-agent view" that tiles six chats and reads like a surveillance wall. When you want detail you open a task thread and you are in the room with that agent; when you want the whole picture you talk to the Conductor, and it is the thing that has read everything.

### 5.2 The Conductor

The Conductor is a chat with **Maestro**, not with a coding agent. It has no filesystem and no node — its tools are the platform's own API:

| Tool | What it does |
| --- | --- |
| `list_projects`, `fleet_status` | What exists, what is online, what is loaded |
| `list_tasks`, `get_task`, `search_history` | What is running, what happened, what changed |
| `create_task` | Dispatch work into any project you have access to |
| `steer_task`, `cancel_task` | Send a mid-run message, or stop a run |
| `decide_approval` | Allow or deny a pending command |
| `spend_report` | Cost by org, project, member, period |

So it answers *"what's running right now?"*, *"did the auth fix land, and what did it change?"*, *"why is the web project's spend up this week?"* — and it acts: *"fix the flaky auth test in maestro, and bump the deps in web"* spawns two tasks in two projects and hands you back two live cards.

**Tasks appear in the Conductor as embedded live cards** — status line, current action, elapsed, cost — which stream in place and open into the full thread on click. This is the load-bearing detail. The Conductor must **never** interleave six agents' raw tool calls into one feed; that is unreadable within a minute of real use. It narrates at the milestone level — dispatched, blocked on approval, finished, failed — and links to the thread for everything below that. You can `follow` a task to pull its milestones inline, and unfollow when you stop caring.

Approvals arrive here too, phrased as a question with the same inline buttons: *"`workhorse` wants to run `terraform apply -auto-approve` in `infra`. Allow?"*

Three properties keep it honest:

- **It acts as you.** Every tool call runs through the same `can(actor, permission, scope)` check with your identity, never elevated. It cannot see a project you cannot see, cannot dispatch into one you lack `task.run` on, and tasks it creates are attributed and billed to you.
- **It is scoped to one organization at a time** — the org switcher switches the Conductor too, so context from one tenant cannot leak into another's answers.
- **It is long-lived.** One thread per user per org, persisting across sessions and compacted as it grows, so *"what did we ship last week?"* has something to draw on.

It is reachable from anywhere with `⌘J` as an overlay, so you can ask "what else is running?" without losing the thread you are reading.

### 5.3 Shell

Three zones, the outer two collapsible:

```
┌───────────┬───────────────────────────────────────┬──────────────┐
│ acme ▾    │  maestro / Fix flaky auth test        │  Changes  ▾  │
│           │                                       │              │
│ ◈ Conduc… │  ┌─────────────────────────────────┐  │  3 files     │
│ ⊙ Inbox ³ │  │ You                             │  │  +48  −12    │
│ ───────── │  │ the auth test is flaky in CI    │  │              │
│ PROJECTS  │  └─────────────────────────────────┘  │ ▸ auth.test  │
│ ● maestro │                                       │ ▸ session.ts │
│   web   ² │  ⏺ Read  src/auth/session.ts         │ ▸ clock.ts   │
│   infra   │  ⏺ Grep  "setTimeout" · 4 matches     │              │
│           │                                       │  ────────────│
│ ───────── │  It's a timing assumption — the test  │  Diff / Term │
│ Fleet     │  sleeps 100ms and CI is slower. I'll  │  / Files     │
│ Providers │  inject a clock instead.              │              │
│ Settings  │                                       │              │
│           │  ⏺ Edit  src/auth/session.ts  +12 −4 │              │
│           │  ⏺ Bash  bun test auth                │              │
│           │    ▸ 24 passed, 0 failed (2.1s)       │              │
│           │                                       │              │
│           │  ⣾ Running tests… 41s · $0.12         │              │
│           │  workhorse · opus-5 · esc to interrupt│              │
│           │ ┌─────────────────────────────────┐   │              │
│           │ │ Reply, or steer…           ⏎    │   │              │
│           │ └─────────────────────────────────┘   │              │
└───────────┴───────────────────────────────────────┴──────────────┘
```

**Left rail** — org switcher, then the two cross-cutting surfaces that outrank any single project (Conductor and Inbox), then the project list with a badge for tasks needing attention, then admin: Fleet, Providers, Settings. Collapses to icons.

**Center** — a conversation, either a task thread or the Conductor. Always the primary surface; everything else is support.

**Right panel** — what the agent *did*, as opposed to what it said: the accumulated diff, a full-height terminal tail, or the workspace file tree. Closed by default on a fresh task, opens itself the first time a file changes.

### 5.4 The task thread

This is the part that should feel like Claude Code, and the details are where that feeling lives:

- **Tool calls are one-liners, not walls.** `⏺ Read src/auth/session.ts` with the result behind a disclosure triangle. Edits collapse to `+12 −4` and expand into an inline diff. `bash` streams live, then collapses to the last few lines plus an exit status.
- **The input stays alive while the agent works.** You can type mid-run: a message sent while it is thinking is queued and delivered at the next turn boundary. Steering an agent without stopping it is the single biggest quality-of-life difference between a chat toy and a tool.
- **Interrupt is always one key away.** `Esc` stops the run, keeps the transcript, leaves you in place.
- **A live status line above the composer** — spinner, current action, elapsed, accumulated cost, and the node and model in play. It is the honest answer to "what is it doing right now".
- **Approvals are inline cards, not modals.** When a node escalates a command, the card lands in the thread where it happened, with `Allow` / `Allow always for this project` / `Deny`. Modals steal context, and with several agents running they stack up and get dismissed blind.
- **Provenance is visible.** Each assistant turn carries a small model badge, because the router can switch models mid-task; clicking it shows the routing decision and why. Same for the node badge.
- **Everything is replayable.** The thread is rendered from `task_events`, so an old task looks exactly as it did live, and a task you open mid-run backfills then attaches to the stream.

### 5.5 The project home

The screen you land on:

- **Composer, front and centre.** A large "what should the agent do?" field, with the routing controls inline underneath as chips: `Auto → workhorse`, `Auto → standard tier`, `3 skills`, `+2 MCP`. Each shows what the router *would* pick and each is one click to override. Automatic routing is only trustworthy when it shows its work before it acts, not after.
- **Live tasks**, each a row with a streaming status line — the last action, elapsed, cost, node. This is the orchestra view, and it costs nothing extra because it is the same event stream the thread renders.
- **Needs you** floats to the top: anything blocked on an approval or a question.
- **Recent tasks** below, with diff stat and outcome.
- Tabs for **Workspaces, Skills, Tools, Models, Access, Settings, Activity**.

### 5.6 Cross-project screens

- **Inbox** — every approval request and every finished-and-unreviewed task across all projects, in one queue. Same underlying data as the Conductor's attention items, presented as a checklist rather than a conversation: when you want to clear a backlog you want a list, and when you want to understand it you want to ask. Neither replaces the other.
- **Fleet** — nodes as a table: status, load, running tasks, version, last heartbeat, capabilities. Admin surface, and the place to revoke a node.
- **Providers** — org connections and personal connections in two clearly separated lists that never mix (§9.3), each with health, quota and spend.
- **Activity** — the audit log, filterable.

### 5.7 Principles

**Dark by default, dense, quiet.** People will stare at this for hours next to an editor. Monospace for anything the machine produced — paths, commands, output, diffs — proportional for prose, so you can tell at a glance what came from the model and what came from the machine.

**Colour carries status and nothing else.** Running, blocked, failed, done. A UI that decorates with colour has nothing left to signal with when a task actually needs you.

**Keyboard-first.** `⌘K` jumps to any project or task, `⌘J` summons the Conductor over whatever you are looking at, `⌘⏎` sends, `Esc` interrupts, `⌘/` toggles the right panel, `j`/`k` move through the inbox.

**Mobile is for supervision, not authoring.** Watch a run, read a diff, approve or deny, send a short follow-up. Approving a `terraform apply` from a phone is a genuinely valuable thing to be able to do; writing a spec on one is not.

**Never a spinner with no subject.** Every waiting state names what it is waiting for — a model call, a node, a queue slot, an approval — because half of trusting an orchestrator is being able to see where the time went.

---

## 6. Installing a node

One command, copied from **Project → Workspaces → Add node** by anyone holding `node.enroll` in that scope:

```bash
curl -fsSL https://maestro.cyrn.fr/install/nk_7f3a91c4e2b8 | sh
```

The path segment *is* the enrollment token, so the server returns an install script already personalised: correct server URL, correct token, correct project. What it does:

1. Detects OS and architecture, downloads the matching node binary, verifies its checksum.
2. Writes `/etc/maestro/node.toml` (or `~/.config/maestro/node.toml` for a user install).
3. Installs a service — systemd on Linux, launchd on macOS — and starts it.
4. The daemon dials the server, sends `node.enroll`, and **exchanges the enrollment token for a durable node token** which it stores with `0600` permissions. The enrollment token is burned at that moment.
5. The server provisions the project workspace, and the node shows up as online in the UI.

Flags, for when the defaults are wrong:

```bash
curl -fsSL https://maestro.cyrn.fr/install/nk_7f3a91c4e2b8 | sh -s -- \
  --name build-box \        # defaults to the hostname
  --user maestro \          # service account to run as
  --workspace-root /srv \   # where project checkouts land
  --no-service              # just install the binary, don't daemonise
```

If piping a URL into a shell makes you uncomfortable — reasonable — the same token works the boring way:

```bash
curl -fsSL -O https://maestro.cyrn.fr/install/nk_7f3a91c4e2b8   # read it first
sh ./nk_7f3a91c4e2b8
```

The security properties that make the one-liner acceptable: the token is single-use, expires in 15 minutes, is scoped to one project, and is worthless the moment the node has exchanged it. A leaked install command from last week grants nothing.

**Node ownership mirrors project ownership.** A node enrolled by an organization can host any of that org's projects and is managed by its admins; a node enrolled personally can only host its owner's personal projects. A node never crosses that line, so an org's code is never checked out onto a machine the org does not control.

`maestro-node uninstall` reverses all of it and revokes the node server-side.

---

## 7. Extending the agent

Two mechanisms, deliberately different. **Skills teach the agent a procedure. MCP gives the agent a capability.** A skill is prose and scripts about *how you do things here*; an MCP server is a connection to a system the agent otherwise could not reach.

### 7.1 Skills

A skill is a directory with a `SKILL.md` and whatever scripts it needs:

```markdown
---
name: deploy
description: Deploy this service to staging or production. Use when the user
             asks to deploy, ship, or roll back a release.
---

## Deploying

1. Confirm the branch is green: `./scripts/ci-status.sh`
2. Build the image: `./scripts/build.sh --env {{env}}`
...
```

Only the `name` and `description` of every in-scope skill are in the model's context by default — cheap, a couple of lines each. When the model judges a skill relevant it loads the body, and only then does the full procedure enter the conversation. Bundled scripts execute on the node through the normal `bash` tool, so they are subject to the same command policy and the same approval prompts as anything else.

Skills come from two places:

- **Project skills** — committed under `.maestro/skills/`. They version with the code and are synced to a workspace on provision and on every task start (`skill.sync`), so the agent always runs the branch's version.
- **Shared skills** — authored in the UI and owned by a user or an organization, attachable to any project of that owner. For procedures that span repos: how you write a changelog, how you open a PR, house style for commit messages.

On conflict the project skill wins — the repo is closer to the truth than the dashboard.

### 7.2 MCP

MCP servers extend the tool list. Maestro supports both placements, and the model sees a single merged list either way:

**Server-side MCP** — remote servers over HTTP/SSE: GitHub, Linear, Sentry, your internal API. The central server holds the connection and the credentials, and a node never sees either. This is the default for anything SaaS-shaped.

**Node-side MCP** — stdio servers that need to be *on the machine*: a database on a private network, a browser driver, an internal CLI. The node spawns the process on `mcp.start`, reports its tools, and proxies calls over the socket the node already has open. Nothing new needs to listen on a port.

Configuration is per project, in `.maestro/mcp.json` or through the UI:

```jsonc
{
  "mcpServers": {
    "github":   { "transport": "http",  "url": "https://api.githubcopilot.com/mcp/",
                  "credential": "gh-app" },
    "postgres": { "transport": "stdio", "placement": "node",
                  "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres"],
                  "env": { "DATABASE_URL": "{{secret.staging_db}}" } }
  }
}
```

Secrets are referenced, never inlined: `{{secret.*}}` resolves from the owning scope's encrypted store — an org project resolves org secrets, a personal project resolves personal ones — and for a node-side server the resolved value is injected into the child process environment and never written to disk.

**Gateways** — some hosts front several MCP services behind one key and one domain, so connecting them one at a time means pasting the same credential nine times. Give Maestro the gateway's base URL and a key and it asks what that key can reach, then connects the services you pick. Each becomes an ordinary server connection afterwards — separately named, scoped, enabled and approved — because a gateway is a convenience at setup time, not a category of thing the agent should have to know about. Enumerating services is not part of MCP, so this follows the convention the gateway publishes (`GET /api/services`); a host that does not answer that way is still connected one service at a time.

Tools are namespaced by server (`github__create_pull_request`) so two servers cannot collide. Every project has a tool picker — an MCP server can advertise forty tools and you rarely want all forty in context — and each tool carries an approval setting: auto, ask, or never.

---

## 8. Routing

**Automatic by default, manually overridable everywhere.** Routing happens inside a project: the candidate set is that project's workspaces and the models available to that project's *owner* (§9.3).

**Workspace eligibility** — node is online, belongs to the project's owner, has a free slot, has a current checkout, and satisfies any capability the task declares (`docker`, `python@3.12`).

**Workspace score** — free capacity, recent success rate, heartbeat latency, and a locality bonus for a node that recently ran a task in the same project (its caches and its build tree are warm).

**Model choice** — the router estimates task weight from prompt length, file count in scope, and whether the task is exploratory or a known-shape edit, then maps it onto a tier:

| Tier | Typical use |
| --- | --- |
| `heavy` | architecture, multi-file refactors, debugging with unclear cause |
| `standard` | ordinary feature work and edits |
| `light` | renames, formatting, mechanical fixes, summarisation |

Within a tier it prefers the cheapest provider with rate-limit headroom and a healthy recent error rate, and it fails over to the next candidate on a 429 or 5xx without losing the task.

**Overrides**, in increasing priority:

1. **Org defaults** — allowed providers, default tier, spend caps.
2. **Project defaults** — narrowing the org's set further.
3. **Routing rules** — user-defined, evaluated in order, project rules before org ones: *"label `refactor` → tier `heavy`, node `workhorse`"*.
4. **Task pin** — set at creation, or changed mid-task; the next model call uses the new pin.
5. **Manual dispatch** — pick workspace and model explicitly and skip the router.

Every decision is recorded with its reasoning, shown as a chip on the composer *before* the task runs and inspectable from the model badge afterwards. A router you cannot interrogate is a router nobody trusts.

---

## 9. Providers

Two paths behind one gateway, so the agent loop never knows which it is talking to — and one ownership rule that decides whose account is billed.

### 9.1 API key providers

Direct integration for OpenAI, Anthropic, DeepSeek, and any OpenAI-compatible endpoint (OpenRouter, Groq, vLLM, Ollama, LM Studio). You add a key; Maestro probes the model list, records context windows and pricing, and the models become routable immediately. Keys are encrypted at rest with a key from the server's `MAESTRO_SECRET_KEY`, and are never sent to a node or to the browser.

### 9.2 OAuth providers

Subscription accounts — Claude, Gemini, Codex, Qwen — authenticate via OAuth rather than an API key. Maestro handles these using the flows from [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI): browser-based consent, token storage, automatic refresh, and account rotation when one account hits its limit.

The pragmatic v1: run CLIProxyAPI as an optional sidecar and register it as an OpenAI-compatible provider, so its accounts appear in the router alongside everything else. The OAuth flows themselves are then reimplemented natively in the gateway, provider by provider, and the sidecar becomes optional rather than required.

Either way the UI is the same: *Add account → consent in browser → the account shows up as routable capacity with a visible quota bar.*

### 9.3 Whose credentials get used

A provider connection is owned by exactly one scope — a user or an organization — and the rule is short:

> **A task uses the provider connections of the project's owner. Nothing else.**

So:

- Project owned by an **organization** → only that org's connections are candidates. The member running the task may have their own Anthropic key attached to their personal account; it is not consulted, not offered, and not usable there. Org work is billed to the org.
- Project owned by a **user** → only that user's own connections.
- **No fallback in either direction.** If an org has no usable provider — none configured, all disabled, spend cap reached — the task fails immediately with an explicit error naming the reason and telling the member to contact an org admin. Quietly falling back to someone's personal key would misattribute cost and leak an org's source code through an account the org does not control, so it is a hard failure by design.

A member with `provider.manage` connects org providers in **Organization → Providers**; personal ones live in **Settings → Providers** and are visible only to their owner. The two lists never mix in the UI, and the task view always shows which connection served each model call.

Cost is recorded on every call and attributed three ways — to the org, to the project, and to the member who started the task — which is what makes per-project and per-member spend caps enforceable rather than decorative.

---

## 10. Stack

TypeScript end to end. The alternatives were fine; consistency across three deployables was worth more than any of them.

| Piece | Choice |
| --- | --- |
| Runtime | Bun |
| Server HTTP | Hono |
| Sockets | Native WebSocket (`ws` on the node side) |
| Store | SQLite via Drizzle for v1, Postgres-ready schema |
| Auth | Own implementation: argon2id, server-side sessions, TOTP via `otpauth` |
| Frontend | React + Vite + Tailwind, TanStack Query + Router, shadcn/ui primitives |
| Node daemon | Same TS, shipped as a single compiled binary (`bun build --compile`) |
| MCP | `@modelcontextprotocol/sdk`, client-side on both server and node |
| Shared | `packages/protocol` — message schemas as Zod, imported by all three, so the wire format cannot drift |

```
maestro/
├── apps/
│   ├── server/          # API, auth/RBAC, agent loop, router, gateway, registries
│   ├── web/             # React frontend
│   └── node/            # reverse node daemon + installer script template
└── packages/
    ├── protocol/        # wire types + Zod schemas (shared)
    ├── tools/           # tool definitions, shared by loop and node
    └── skills/          # skill parsing and bundling
```

---

## 11. Data model

```
users               (email, password_hash, totp_secret, instance_role, status)
 ├─ sessions        (token hash, ip, ua, expires_at)
 └─ access_tokens   (org_id, scopes, expires_at, last_used_at)

organizations       (name, slug, settings, require_2fa)
 ├─ memberships     (user_id, org_id, role)            -- Owner|Admin|Member|Viewer
 ├─ invitations     (email, role, token hash, expires_at, accepted_at)
 └─ conductor_threads (user_id, org_id, compacted_at)  -- one per member per org
      ├─ conductor_events  (append-only, same shape as task_events)
      └─ conductor_follows (task_id)                   -- tasks piped in at milestone level

owner = (user_id XOR org_id) on each of:
 ├─ provider_connections (kind, encrypted creds, enabled, health)
 │    └─ models          (tier, ctx, price_in, price_out)
 ├─ secrets              (name, encrypted value)        -- write-only through the API
 ├─ nodes                (token hash, last_seen, status, capabilities)
 ├─ shared_skills        (name, description, body, scripts)
 └─ projects             (repo, branch, instructions, default_tier, spend_cap, visibility)
      ├─ project_members (user_id, role)                -- overrides org role
      ├─ workspaces      (node_id, path, branch, provisioned_at)
      ├─ project_skills  (source: repo | shared, ref)
      ├─ mcp_servers     (placement: server | node, transport, config, tool_allowlist)
      ├─ routing_rules   (priority, match, action)
      └─ tasks           (workspace_id, actor_user_id, prompt, status, pin, cost)
           ├─ task_events (append-only: message, tool_call, tool_result,
           │               skill_load, log, routing_decision, provider_used)
           └─ approvals   (tool_call_id, requested, decided_by, decided_at)

enrollment_tokens   (owner scope, project_id, hash, expires_at, used_at)  -- single use
audit_log           (org_id, actor_user_id, action, target, metadata, at)  -- append-only
```

Task status: `queued → assigned → running → (awaiting_approval) → completed | failed | cancelled`.

The `owner = (user_id XOR org_id)` pattern is what makes §9.3 enforceable in one place: resolving a project's provider set is a lookup on the same owner column that already gates visibility, not a separate policy that could drift out of sync with it.

`task_events` is the source of truth. The UI replays it to reconstruct any task, live or months later, so a finished thread renders exactly as it did while running, and it doubles as the execution audit trail alongside `audit_log`.

---

## 12. Running locally

```bash
bun install
bun run db:migrate
bun run dev            # server on :3000, web on :5173
```

Open `http://localhost:5173` and register — the first account becomes the instance admin. Create an organization if you want to exercise the shared path, add a provider key under **Organization → Providers** (or **Settings → Providers** for a personal project), then create a project.

Add a node from **Workspaces → Add node**; locally the command it hands you points at `localhost`:

```bash
curl -fsSL http://localhost:3000/install/nk_... | sh -s -- --no-service
```

Or skip the installer entirely while developing the daemon itself:

```bash
bun run node:dev -- --server ws://localhost:3000/ws --enroll nk_...
```

Without at least one provider connection on the project's owner, tasks will fail fast by design (§9.3) rather than silently borrowing credentials.

---

## 13. Hosting

The webapp is destined for `https://maestro.cyrn.fr`. Nothing in the system depends on that: nodes take the server URL as configuration and the installer bakes in whatever origin served it, so a node works identically against `localhost` and against production. Wiring the real domain is a deployment detail, not a development prerequisite — **build and verify locally.**

---

## 14. Roadmap

**v0.1 — the spine.** Accounts, sessions, one personal project, one node, one provider. The task thread with streaming tool calls, mid-run steering and interrupt. Manual dispatch. Proves the loop end to end.

**v0.2 — the fleet.** One-command install and enrollment, multiple nodes per project, reconnect and re-attach, capacity limits, inline approval cards, the project home with live task rows. The Conductor arrives read-only here — it can report on the fleet before it is trusted to act on it.

**v0.3 — the tenants.** Organizations, memberships, roles and the permission layer, org-owned providers and nodes, owner-scoped credential resolution, audit log.

**v0.4 — the router.** Automatic workspace and model selection, routing chips on the composer, org and project defaults, rules, pins, failover, cost attribution and spend caps. The Conductor gains its acting tools — dispatch, steer, cancel, approve — now that there is a router to dispatch *into*.

**v0.5 — the extensions.** Project and shared skills, server-side and node-side MCP, per-project tool picker and approval settings.

**v0.6 — the providers.** OAuth accounts via CLIProxyAPI, account rotation, quota display.

**Later.** Cross-project inbox and mobile approvals; SSO (OIDC/SAML) mapped onto the same roles; parallel subtasks across a project's nodes with dependencies; scheduled and event-triggered tasks; PR-level integration (open a task from an issue, land it as a pull request); detached mode where a node runs the loop itself for high-latency links.
