import { MUTATING_TOOLS, type ToolName } from "@maestro/protocol";

/* The node's command policy.
 *
 * Three outcomes, decided on the node because the node owns the machine:
 *
 *   allow     runs immediately
 *   ask       escalates to a human, surfacing in the task thread
 *   refuse    never runs, whatever the server says
 *
 * The refuse list is short and deliberate. It is not a security boundary — a
 * determined model can express a destructive command in a form no pattern
 * catches, and pretending otherwise invites treating the allowlist as safety.
 * It is a guard against the specific catastrophes that are easy to type by
 * accident and impossible to undo. Real containment is the workspace root, the
 * account the daemon runs as, and the approval prompt. */

export type Decision = "allow" | "ask" | "refuse";

export interface PolicyResult {
  decision: Decision;
  reason: string;
}

/* Commands that are never run, in any workspace, under any approval. */
const REFUSE: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/, reason: "recursive force delete" },
  { pattern: /\b(mkfs|fdisk|parted)\b/, reason: "disk formatting" },
  { pattern: /\bdd\b[^|;]*\bof=\/dev\//, reason: "raw write to a device" },
  { pattern: /:\(\)\s*\{.*\}\s*;\s*:/, reason: "fork bomb" },
  { pattern: /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/, reason: "host shutdown" },
  { pattern: /\bchown\s+-R\s+[^\s]+\s+\/(?:\s|$)/, reason: "recursive ownership change of /" },
  { pattern: /\b(useradd|userdel|passwd|visudo)\b/, reason: "account management" },
  { pattern: />\s*\/dev\/(sd|nvme|hd)/, reason: "raw write to a device" },
  { pattern: /\bcurl\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, reason: "piping a download into a shell" },
  { pattern: /\bwget\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, reason: "piping a download into a shell" },
];

/* Read-only commands that are safe to run without interrupting anyone. The
   list is prefix-matched against the first word of each pipeline segment. */
const READ_ONLY = new Set([
  "ls", "cat", "head", "tail", "wc", "file", "stat", "du", "df",
  "pwd", "echo", "which", "type", "env", "date", "whoami", "hostname",
  "grep", "rg", "ag", "find", "fd", "sort", "uniq", "cut", "awk", "sed",
  "tree", "basename", "dirname", "realpath", "readlink",
  "node", "bun", "deno", "python", "python3", "ruby", "go", "cargo", "java",
  "tsc", "eslint", "prettier", "biome", "vitest", "jest", "pytest",
  "true", "false", "sleep", "test",
]);

/* Version-control and package commands that only read. `git push` and
   `npm publish` are conspicuously absent — those leave the machine. */
const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set(["status", "log", "diff", "show", "branch", "remote", "config", "ls-files", "blame", "rev-parse", "describe", "stash"]),
  npm: new Set(["ls", "list", "view", "outdated", "audit", "run", "test"]),
  bun: new Set(["test", "run", "install", "x", "pm"]),
  docker: new Set(["ps", "images", "logs", "inspect", "version"]),
  kubectl: new Set(["get", "describe", "logs", "version"]),
};

export interface PolicyOptions {
  /* Commands the user has approved for this project already, matched as
     prefixes. Populated from earlier "Allow always" decisions. */
  alwaysAllow?: string[];
  /* When false, every mutating tool asks. The safe default for a new node. */
  autoApproveWrites?: boolean;
}

export function evaluate(
  tool: ToolName,
  args: unknown,
  options: PolicyOptions = {},
): PolicyResult {
  if (tool !== "bash") {
    if (!MUTATING_TOOLS.has(tool)) {
      return { decision: "allow", reason: "read-only tool" };
    }
    return options.autoApproveWrites
      ? { decision: "allow", reason: "writes are auto-approved for this workspace" }
      : { decision: "ask", reason: "this tool changes files in the workspace" };
  }

  const command = String((args as { command?: unknown } | null)?.command ?? "").trim();
  if (!command) return { decision: "refuse", reason: "empty command" };

  for (const { pattern, reason } of REFUSE) {
    if (pattern.test(command)) {
      return { decision: "refuse", reason };
    }
  }

  for (const prefix of options.alwaysAllow ?? []) {
    if (command.startsWith(prefix)) {
      return { decision: "allow", reason: `matches an approved prefix: ${prefix}` };
    }
  }

  if (isReadOnly(command)) {
    return { decision: "allow", reason: "read-only command" };
  }

  return { decision: "ask", reason: "command may change the machine" };
}

/* A command counts as read-only only if every segment does. One `rm` after a
   `&&` makes the whole line mutating, and splitting naively on the first word
   would miss it. */
function isReadOnly(command: string): boolean {
  /* Substitutions hide arbitrary commands inside an otherwise innocent line. */
  if (/\$\(|`|<\(/.test(command)) return false;
  /* Any redirection that writes. */
  if (/(^|[^0-9<>&])>{1,2}(?!&)/.test(command)) return false;

  const segments = command.split(/\|\||&&|[|;]/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;

  return segments.every((segment) => {
    const words = segment.split(/\s+/).filter(Boolean);
    /* Leading VAR=value assignments are not the command. */
    let index = 0;
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index++;

    const head = words[index];
    if (!head) return false;
    if (head === "sudo" || head === "doas") return false;

    const sub = READ_ONLY_SUBCOMMANDS[head];
    if (sub) {
      const next = words[index + 1];
      return next ? sub.has(next) : true;
    }

    return READ_ONLY.has(head);
  });
}
