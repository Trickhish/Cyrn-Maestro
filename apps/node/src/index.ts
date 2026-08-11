#!/usr/bin/env bun
import { NodeClient } from "./client";

/* Entry point for the node daemon.
 *
 *   maestro-node --server ws://host/api/node/socket --enroll <token>
 *
 * After the first run the token is stored and neither flag is needed. */

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv.includes("--help")) {
  console.log(`maestro-node

  --server <url>       WebSocket URL of the Maestro server
  --enroll <token>     One-time enrollment token (first run only)
  --name <name>        This node's name (defaults to the hostname)
  --workspace-root <p> Where project checkouts live
  --config <path>      Config file location
`);
  process.exit(0);
}

/* CLI flags become environment variables so config.ts has one place to read
   from, with the file as the fallback. */
for (const [name, env] of [
  ["server", "MAESTRO_SERVER"],
  ["name", "MAESTRO_NODE_NAME"],
  ["workspace-root", "MAESTRO_WORKSPACE_ROOT"],
  ["config", "MAESTRO_NODE_CONFIG"],
] as const) {
  const value = flag(name);
  if (value) process.env[env] = value;
}

const client = new NodeClient({
  enrollmentToken: flag("enroll"),
  configPath: process.env.MAESTRO_NODE_CONFIG,
  onStateChange: (state) => console.log(`[node] ${state}`),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log("\nShutting down.");
    client.stop();
    process.exit(0);
  });
}

client.start();
