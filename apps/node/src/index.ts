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

/* Run by a node that has just downloaded this file, before it trusts it
   enough to replace itself with it. Loads the config and prints the version,
   which is enough to catch a truncated download or a bundle that throws on
   load — the failures that would otherwise leave a machine restarting into
   nothing. It deliberately does not connect: proving the daemon starts is the
   job here, not proving the server is up. */
if (process.argv.includes("--selftest")) {
  const { loadConfig, nodeIdentity } = await import("./config");
  const identity = nodeIdentity(loadConfig(flag("config")), []);
  console.log(identity.version);
  process.exit(0);
}

if (process.argv.includes("--help")) {
  console.log(`maestro-node

  --server <url>       WebSocket URL of the Maestro server
  --enroll <token>     One-time enrollment token (first run only)
  --enroll-only        Enrol (or confirm this machine's identity) and exit
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

/* Enrolling and serving are separated so an installer can do the first as a
   plain foreground step it can check the exit code of, then let a service
   manager own the second. Running both in one process would mean the installer
   either blocks forever or leaves an unsupervised daemon behind. */
const enrollOnly = process.argv.includes("--enroll-only");

const client = new NodeClient({
  enrollmentToken: flag("enroll"),
  configPath: process.env.MAESTRO_NODE_CONFIG,
  onStateChange: (state) => console.log(`[node] ${state}`),
  onIdentified: enrollOnly
    ? () => {
        client.stop();
        process.exit(0);
      }
    : undefined,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log("\nShutting down.");
    client.stop();
    process.exit(0);
  });
}

client.start();
