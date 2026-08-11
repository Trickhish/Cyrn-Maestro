import { z } from "zod";

/* The tools a node implements.
 *
 * These schemas are the contract in three places at once: the node validates
 * incoming arguments against them, the server generates the model's tool
 * definitions from them, and the UI reads the same shapes to render a call.
 * One definition, so a tool cannot mean three slightly different things. */

export const ReadFileArgs = z.object({
  path: z.string().describe("Path relative to the workspace root."),
  offset: z.number().int().min(0).optional().describe("First line to read, 0-indexed."),
  limit: z.number().int().min(1).max(5000).optional().describe("How many lines to read."),
});

export const WriteFileArgs = z.object({
  path: z.string(),
  content: z.string(),
});

export const EditFileArgs = z.object({
  path: z.string(),
  old_string: z.string().describe("Exact text to replace. Must appear exactly once."),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

export const ListDirArgs = z.object({
  path: z.string().optional().describe("Defaults to the workspace root."),
});

export const GlobArgs = z.object({
  pattern: z.string().describe("Glob, e.g. src/**/*.ts"),
  limit: z.number().int().min(1).max(1000).optional(),
});

export const GrepArgs = z.object({
  pattern: z.string().describe("Regular expression."),
  path: z.string().optional().describe("Subtree to search. Defaults to the workspace root."),
  glob: z.string().optional().describe("Only search files matching this glob."),
  limit: z.number().int().min(1).max(500).optional(),
});

export const BashArgs = z.object({
  command: z.string(),
  timeout_ms: z.number().int().min(1000).max(600_000).optional(),
});

export const TOOL_SCHEMAS = {
  read_file: ReadFileArgs,
  write_file: WriteFileArgs,
  edit_file: EditFileArgs,
  list_dir: ListDirArgs,
  glob: GlobArgs,
  grep: GrepArgs,
  bash: BashArgs,
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;

export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[];

export const ToolNameSchema = z.enum(TOOL_NAMES as [ToolName, ...ToolName[]]);

/* One-line descriptions handed to the model alongside the JSON schema. */
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  read_file: "Read a file from the workspace. Use before editing so you know the exact text.",
  write_file: "Create a file, or completely replace an existing one.",
  edit_file:
    "Replace an exact string in an existing file. Prefer this over write_file for changes to files that already exist.",
  list_dir: "List the entries of a directory.",
  glob: "Find files by glob pattern, most recently modified first.",
  grep: "Search file contents with a regular expression.",
  bash: "Run a shell command in the workspace and capture its output.",
};

/* Which tools change the workspace. The node's command policy escalates these
   for approval by default; reads run free. */
export const MUTATING_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  "write_file",
  "edit_file",
  "bash",
]);
