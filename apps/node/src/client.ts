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
}

export type ClientState = "connecting" | "enrolling" | "online" | "offline";

export class NodeClient {
  private config: NodeConfig;
  private socket?: WebSocket;
  private attempt = 0;
  private stopped = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly running = new Map<string, { workspace: Workspace; abort: AbortController }>();

  constructor(private readonly options: ClientOptions = {}) {
    this.config = loadConfig(options.configPath);
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

    this.setState(this.config.nodeToken ? "connecting" : "enrolling");

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

  private identify(): void {
    const workspaces = [...this.running.keys()].length ? [] : [];

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
        break;
      }

      case "node.registered": {
        this.setState("online");
        console.log(`Connected to ${this.config.serverUrl}`);
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

      case "node.rejected": {
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

      case "task.cancel": {
        const task = this.running.get(message.taskId);
        task?.abort.abort();
        this.running.delete(message.taskId);
        break;
      }

      case "ping":
        break;
    }
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
