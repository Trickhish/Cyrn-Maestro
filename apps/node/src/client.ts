import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ServerMessage,
  newId,
  type NodeMessage,
  type ToolName,
} from "@maestro/protocol";
import { Workspace } from "./workspace";
import { executeTool } from "./tools";
import { evaluate } from "./policy";
import { discoverSkills, readSkillBody } from "./skills";
import { loadConfig, saveToken, nodeIdentity, type NodeConfig } from "./config";

/* The node daemon's socket client.
 *
 * Dials out, so the machine needs no public IP and no inbound firewall rule.
 * Reconnects with exponential backoff and jitter — without jitter, a fleet
 * that lost a server all come back in the same millisecond and knock it over
 * again. */

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 500;

export interface ClientOptions {
  enrollmentToken?: string;
  configPath?: string;
  /* Injected in tests. */
  socketFactory?: (url: string) => WebSocket;
  onStateChange?: (state: ClientState) => void;
  /* Fired once this machine has a working identity, whether it just enrolled
     or was already registered. The installer uses it to stop here and hand the
     machine to the service manager, rather than leaving a process running that
     systemd knows nothing about. */
  onIdentified?: () => void;
}

export type ClientState = "connecting" | "enrolling" | "online" | "offline";

export class NodeClient {
  private config: NodeConfig;
  private socket?: WebSocket;
  private attempt = 0;
  private stopped = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly running = new Map<string, { workspace: Workspace; abort: AbortController }>();
  /* Someone who ran an install command means "enrol this machine", so an
     explicit enrollment token outranks whatever is already in the config. A
     machine that was revoked and is being re-added still holds its old token,
     and preferring that token silently re-registers it as the revoked node —
     the new token never even reaches the server. */
  private preferEnrollment: boolean;

  constructor(private readonly options: ClientOptions = {}) {
    this.config = loadConfig(options.configPath);
    this.preferEnrollment = Boolean(options.enrollmentToken);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.heartbeat);
    for (const task of this.running.values()) task.abort.abort();
    this.running.clear();
    this.socket?.close();
  }

  private setState(state: ClientState) {
    this.options.onStateChange?.(state);
  }

  private connect(): void {
    if (this.stopped) return;

    /* Reported as what it is about to do, not as what the config alone
       suggests: a machine re-enrolling with a fresh token still has an old
       one on disk, and calling that "connecting" hides which token is in
       play at exactly the moment someone is trying to work that out. */
    this.setState(this.willEnroll() ? "enrolling" : "connecting");

    const socket = this.options.socketFactory
      ? this.options.socketFactory(this.config.serverUrl)
      : new WebSocket(this.config.serverUrl);

    this.socket = socket;

    socket.addEventListener("open", () => {
      this.attempt = 0;
      this.identify();
    });

    socket.addEventListener("message", (event) => {
      void this.handle(String((event as MessageEvent).data));
    });

    socket.addEventListener("close", () => {
      clearInterval(this.heartbeat);
      this.setState("offline");
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      /* 'close' always follows, so reconnection is handled in one place. */
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;

    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.attempt);
    /* Full jitter. A fleet reconnecting in lockstep is how a recovering server
       gets knocked over a second time. */
    const delay = Math.random() * backoff;
    this.attempt++;

    setTimeout(() => this.connect(), delay);
  }

  private willEnroll(): boolean {
    return Boolean(this.options.enrollmentToken) && this.preferEnrollment;
  }

  private identify(): void {
    const workspaces = [...this.running.keys()].length ? [] : [];

    /* Bound to a local so the narrowing is visible here, rather than hidden
       behind a predicate the compiler cannot see through. */
    const enrollmentToken = this.options.enrollmentToken;
    if (enrollmentToken && this.preferEnrollment) {
      this.send({
        type: "node.enroll",
        id: newId(),
        enrollmentToken,
        node: nodeIdentity(this.config, workspaces),
      });
      return;
    }

    if (this.config.nodeToken) {
      this.send({
        type: "node.register",
        id: newId(),
        nodeToken: this.config.nodeToken,
        node: nodeIdentity(this.config, workspaces),
        /* Reported so a server that restarted re-attaches instead of
           dispatching the same work twice. */
        runningTaskIds: [...this.running.keys()],
      });
      return;
    }

    if (!this.options.enrollmentToken) {
      console.error(
        "This node has no token and no enrollment token.\n" +
          "Run the install command from Project → Workspaces → Add node, " +
          "or pass --enroll <token>.",
      );
      this.stop();
      process.exitCode = 1;
      return;
    }

    this.send({
      type: "node.enroll",
      id: newId(),
      enrollmentToken: this.options.enrollmentToken,
      node: nodeIdentity(this.config, workspaces),
    });
  }

  private send(message: NodeMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private async handle(raw: string): Promise<void> {
    let message;
    try {
      message = ServerMessage.parse(JSON.parse(raw));
    } catch {
      /* A frame the node cannot validate is a protocol mismatch, not a task
         failure. Dropping it is safer than acting on a guess. */
      console.error("Ignoring an unrecognised frame from the server.");
      return;
    }

    switch (message.type) {
      case "node.enrolled": {
        /* The durable token arrives over the socket and never appears in a
           shell command, so a leaked install one-liner grants nothing. */
        saveToken(message.nodeToken, this.options.configPath);
        this.config = loadConfig(this.options.configPath);
        console.log(`Enrolled as ${this.config.name}. Token stored.`);
        this.setState("online");
        this.options.onIdentified?.();
        break;
      }

      case "node.registered": {
        this.setState("online");
        console.log(`Connected to ${this.config.serverUrl}`);
        /* The fleet's setting outranks this machine's own config, and arrives
           on every reconnect — so a value set in Maestro survives a restart
           here without anyone editing node.toml. */
        if (message.maxConcurrentTasks) this.applyConcurrency(message.maxConcurrentTasks);
        /* Also an identity: a machine that was already enrolled is set up, and
           an installer re-run on it should finish rather than time out. */
        this.options.onIdentified?.();
        clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => {
          this.send({
            type: "node.heartbeat",
            id: newId(),
            runningTaskIds: [...this.running.keys()],
            loadPercent: undefined,
          });
        }, message.heartbeatIntervalMs);
        break;
      }

      /* Changed from the fleet page while this socket is open. */
      case "node.configure": {
        this.applyConcurrency(message.maxConcurrentTasks);
        break;
      }

      case "node.rejected": {
        /* Version skew is the one rejection that gets better on its own: a
           node ahead of its server, or a server rolled back under a fleet,
           both resolve when the other side catches up. Treating it as fatal
           would crash-loop a machine over a frame, so it reconnects with
           backoff like any other blip. */
        if (message.reason === "version_mismatch") {
          console.error(
            `The server could not understand a frame (${message.detail ?? "version mismatch"}). Reconnecting.`,
          );
          this.socket?.close();
          return;
        }

        /* A stale install command run on a machine that is already enrolled and
           working should not take it down. Falling back to the stored identity
           keeps it serving; only a machine with no other way in gives up. */
        if (this.preferEnrollment && this.config.nodeToken) {
          console.error(
            `That enrollment token was refused (${message.reason}). ` +
              "Continuing with the identity this machine already has.",
          );
          this.preferEnrollment = false;
          this.socket?.close();
          return;
        }

        console.error(`Server rejected this node: ${message.reason}. ${message.detail ?? ""}`);
        /* A bad or revoked token will never become good by retrying. */
        this.stop();
        process.exitCode = 1;
        break;
      }

      case "workspace.provision": {
        mkdirSync(message.path, { recursive: true });
        break;
      }

      case "task.assign": {
        await this.acceptTask(message.taskId, message.projectId, message.workspacePath);
        break;
      }

      case "tool.call": {
        await this.runToolCall(message);
        break;
      }

      case "skill.fetch": {
        const task = this.running.get(message.taskId);
        this.send({
          type: "skill.body",
          id: newId(),
          taskId: message.taskId,
          requestId: message.requestId,
          name: message.name,
          body: task ? await readSkillBody(task.workspace, message.name) : null,
        });
        break;
      }

      case "task.cancel": {
        const task = this.running.get(message.taskId);
        task?.abort.abort();
        this.running.delete(message.taskId);
        break;
      }

      /* Frees the slot when a task ends. Without this the node fills up to
         maxConcurrentTasks and rejects every assignment after that. */
      case "task.release": {
        this.running.delete(message.taskId);
        break;
      }

      case "ping":
        break;
    }
  }

  /* Held in memory only. node.toml stays the machine's own answer for when it
     runs against a server that has no opinion; writing the fleet's value into
     it would quietly make a remote setting look like a local one. */
  private applyConcurrency(max: number): void {
    if (this.config.maxConcurrentTasks === max) return;
    console.log(`Concurrency set to ${max} by the server (was ${this.config.maxConcurrentTasks}).`);
    this.config.maxConcurrentTasks = max;
  }

  private async acceptTask(taskId: string, projectId: string, workspacePath: string): Promise<void> {
    if (this.running.size >= this.config.maxConcurrentTasks) {
      this.send({ type: "task.rejected", id: newId(), taskId, reason: "at_capacity" });
      return;
    }

    const path = workspacePath || join(this.config.workspaceRoot, projectId);

    try {
      mkdirSync(path, { recursive: true });
      const workspace = await Workspace.open(path);
      this.running.set(taskId, { workspace, abort: new AbortController() });
      this.send({ type: "task.accepted", id: newId(), taskId });

      /* Reported from the checkout, because skills version with the branch and
         only this machine knows what the branch currently holds. Failing to
         read them must not fail the task — an agent with no skills is still an
         agent. */
      try {
        const { skills, problems } = await discoverSkills(workspace);
        this.send({
          type: "skills.found",
          id: newId(),
          taskId,
          skills: skills.map((s) => ({
            name: s.name,
            description: s.description,
            version: s.version,
            path: s.path,
          })),
          problems,
        });
      } catch (err) {
        this.send({
          type: "skills.found",
          id: newId(),
          taskId,
          skills: [],
          problems: [{ path: ".maestro/skills", message: (err as Error).message }],
        });
      }
    } catch (err) {
      this.send({
        type: "task.rejected",
        id: newId(),
        taskId,
        reason: "unknown_workspace",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async runToolCall(message: {
    taskId: string;
    callId: string;
    tool: ToolName;
    args: unknown;
    approved?: boolean;
  }): Promise<void> {
    const task = this.running.get(message.taskId);
    if (!task) {
      this.send({
        type: "tool.result",
        id: newId(),
        taskId: message.taskId,
        callId: message.callId,
        ok: false,
        output: "This node is not running that task.",
        truncated: false,
      });
      return;
    }

    const verdict = evaluate(message.tool, message.args, {
      alwaysAllow: this.config.alwaysAllow,
      autoApproveWrites: this.config.autoApproveWrites,
    });

    /* A refusal is final. The server cannot override it by setting `approved`,
       which is the point of deciding this on the node. */
    if (verdict.decision === "refuse") {
      this.send({
        type: "tool.result",
        id: newId(),
        taskId: message.taskId,
        callId: message.callId,
        ok: false,
        output: `Refused by this node's command policy: ${verdict.reason}.`,
        truncated: false,
      });
      return;
    }

    if (verdict.decision === "ask" && !message.approved) {
      this.send({
        type: "tool.approval_request",
        id: newId(),
        taskId: message.taskId,
        callId: message.callId,
        tool: message.tool,
        summary: summarise(message.tool, message.args),
        reason: message.tool === "bash" ? "policy_ask" : "mutating_tool",
      });
      return;
    }

    const outcome = await executeTool(message.tool, message.args, {
      workspace: task.workspace,
      maxOutputBytes: 30_000,
      defaultTimeoutMs: 120_000,
      signal: task.abort.signal,
      onLog: (stream, chunk) =>
        this.send({
          type: "task.log",
          id: newId(),
          taskId: message.taskId,
          callId: message.callId,
          stream,
          chunk,
        }),
    });

    this.send({
      type: "tool.result",
      id: newId(),
      taskId: message.taskId,
      callId: message.callId,
      ok: outcome.ok,
      output: outcome.output,
      truncated: outcome.truncated ?? false,
      totalBytes: outcome.totalBytes,
      durationMs: outcome.durationMs,
      exitCode: outcome.exitCode,
    });
  }
}

/* The one-liner a human reads in an approval prompt. */
export function summarise(tool: ToolName, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "bash":
      return String(a.command ?? "");
    case "write_file":
      return `write ${a.path}`;
    case "edit_file":
      return `edit ${a.path}`;
    case "read_file":
      return `read ${a.path}`;
    case "list_dir":
      return `list ${a.path ?? "."}`;
    case "glob":
      return `glob ${a.pattern}`;
    case "grep":
      return `grep ${a.pattern}`;
    default:
      return tool;
  }
}
