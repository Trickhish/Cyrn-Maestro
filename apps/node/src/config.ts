import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hostname, platform, arch } from "node:os";

/* Node configuration.
 *
 * The durable token is written here with 0600 after enrollment. It is the
 * node's identity, so the file is treated like a private key: never logged,
 * never sent anywhere but the server it came from. */

export interface NodeConfig {
  serverUrl: string;
  name: string;
  workspaceRoot: string;
  nodeToken?: string;
  maxConcurrentTasks: number;
  autoApproveWrites: boolean;
  alwaysAllow: string[];
}

const DEFAULT_PATH =
  process.env.MAESTRO_NODE_CONFIG ??
  (process.getuid?.() === 0 ? "/etc/maestro/node.toml" : `${process.env.HOME}/.config/maestro/node.toml`);

export function loadConfig(path = DEFAULT_PATH): NodeConfig {
  const base: NodeConfig = {
    serverUrl: process.env.MAESTRO_SERVER ?? "ws://localhost:3000/api/node/socket",
    name: process.env.MAESTRO_NODE_NAME ?? hostname(),
    workspaceRoot: resolve(process.env.MAESTRO_WORKSPACE_ROOT ?? `${process.env.HOME}/maestro-workspaces`),
    maxConcurrentTasks: Number(process.env.MAESTRO_MAX_TASKS ?? 2),
    autoApproveWrites: process.env.MAESTRO_AUTO_APPROVE_WRITES === "1",
    alwaysAllow: [],
  };

  if (!existsSync(path)) return base;

  /* A deliberately small subset of TOML: flat key = value, strings, numbers,
     booleans and string arrays. Enough for this file, and one less dependency
     shipped inside the compiled binary. */
  const parsed: Record<string, unknown> = {};
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    const raw = line.slice(eq + 1).trim();

    if (raw.startsWith("[") && raw.endsWith("]")) {
      parsed[key] = raw
        .slice(1, -1)
        .split(",")
        .map((v) => v.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else if (raw === "true" || raw === "false") {
      parsed[key] = raw === "true";
    } else if (/^-?\d+$/.test(raw)) {
      parsed[key] = Number(raw);
    } else {
      parsed[key] = raw.replace(/^["']|["']$/g, "");
    }
  }

  return {
    serverUrl: (parsed.server_url as string) ?? base.serverUrl,
    name: (parsed.name as string) ?? base.name,
    workspaceRoot: resolve((parsed.workspace_root as string) ?? base.workspaceRoot),
    nodeToken: (parsed.node_token as string) ?? undefined,
    maxConcurrentTasks: (parsed.max_concurrent_tasks as number) ?? base.maxConcurrentTasks,
    autoApproveWrites: (parsed.auto_approve_writes as boolean) ?? base.autoApproveWrites,
    alwaysAllow: (parsed.always_allow as string[]) ?? base.alwaysAllow,
  };
}

export function saveToken(token: string, path = DEFAULT_PATH): void {
  const config = loadConfig(path);
  mkdirSync(dirname(path), { recursive: true });

  const lines = [
    "# Maestro node configuration.",
    "# node_token is this machine's identity — treat it like a private key.",
    `server_url = "${config.serverUrl}"`,
    `name = "${config.name}"`,
    `workspace_root = "${config.workspaceRoot}"`,
    `node_token = "${token}"`,
    `max_concurrent_tasks = ${config.maxConcurrentTasks}`,
    `auto_approve_writes = ${config.autoApproveWrites}`,
    `always_allow = [${config.alwaysAllow.map((a) => `"${a}"`).join(", ")}]`,
    "",
  ];

  writeFileSync(path, lines.join("\n"), { mode: 0o600 });
  /* writeFileSync only applies the mode when creating the file, so an existing
     one keeps whatever permissions it had. Set it explicitly. */
  chmodSync(path, 0o600);
}

export function nodeIdentity(config: NodeConfig, workspaces: Array<{ projectId: string; path: string }>) {
  return {
    name: config.name,
    os: platform(),
    arch: arch(),
    version: "0.1.0",
    maxConcurrentTasks: config.maxConcurrentTasks,
    capabilities: detectCapabilities(),
    workspaces: workspaces.map((w) => ({ projectId: w.projectId, path: w.path, vcs: "none" as const })),
  };
}

/* Advertised so the router can require a capability a task needs. Cheap
   synchronous checks only — this runs on every connect. */
function detectCapabilities(): string[] {
  const found = ["bash"];
  for (const [name, path] of [
    ["git", "/usr/bin/git"],
    ["docker", "/usr/bin/docker"],
  ] as const) {
    if (existsSync(path)) found.push(name);
  }
  if (process.versions.bun) found.push(`bun@${process.versions.bun}`);
  if (process.versions.node) found.push(`node@${process.versions.node.split(".")[0]}`);
  return found;
}
