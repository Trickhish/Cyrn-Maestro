import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

/* Bun loads .env from the working directory, and the server is started with
   --cwd apps/server, so the repo-root .env would be missed. Walking up to find
   it means every entry point — server, migrations, node daemon, tests — reads
   the same file no matter where it was invoked from.
 *
 * Real environment variables always win: a value already set was set
 * deliberately, by systemd or by the shell, and a file should not override it. */

export function loadRootEnv(startDir = import.meta.dir): void {
  let dir = startDir;

  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      applyEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

function applyEnvFile(path: string): void {
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
