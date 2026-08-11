import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TOOL_SCHEMAS, type ToolName } from "@maestro/protocol";
import { Workspace } from "./workspace";

/* Tool execution.
 *
 * Every tool validates its arguments against the same Zod schema the server
 * used to describe it to the model, then resolves paths through the workspace.
 * Nothing here trusts its input. */

export interface ToolOutcome {
  ok: boolean;
  output: string;
  truncated?: boolean;
  totalBytes?: number;
  exitCode?: number;
  durationMs?: number;
}

export interface ExecuteOptions {
  workspace: Workspace;
  /* What the model is allowed to see. The full size is reported separately so
     the UI can say what was cut rather than silently showing a prefix. */
  maxOutputBytes: number;
  defaultTimeoutMs: number;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => void;
  signal?: AbortSignal;
}

export async function executeTool(
  tool: ToolName,
  rawArgs: unknown,
  options: ExecuteOptions,
): Promise<ToolOutcome> {
  const parsed = TOOL_SCHEMAS[tool].safeParse(rawArgs ?? {});
  if (!parsed.success) {
    /* Returned as a failed result rather than thrown: the model can read this
       and correct itself on the next turn, which is cheaper than failing the
       whole task. */
    return {
      ok: false,
      output: `Invalid arguments for ${tool}: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
        .join("; ")}`,
    };
  }

  const started = Date.now();
  try {
    const outcome = await run(tool, parsed.data as never, options);
    return { ...outcome, durationMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      output: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
}

async function run(tool: ToolName, args: never, o: ExecuteOptions): Promise<ToolOutcome> {
  switch (tool) {
    case "read_file":
      return readFileTool(args, o);
    case "write_file":
      return writeFileTool(args, o);
    case "edit_file":
      return editFileTool(args, o);
    case "list_dir":
      return listDirTool(args, o);
    case "glob":
      return globTool(args, o);
    case "grep":
      return grepTool(args, o);
    case "bash":
      return bashTool(args, o);
  }
}

/* ------------------------------------------------------------------ files */

async function readFileTool(
  args: { path: string; offset?: number; limit?: number },
  o: ExecuteOptions,
): Promise<ToolOutcome> {
  const path = await o.workspace.resolve(args.path, { mustExist: true });
  const info = await stat(path);
  if (info.isDirectory()) {
    return { ok: false, output: `${args.path} is a directory. Use list_dir.` };
  }

  const content = await readFile(path, "utf8");
  const lines = content.split("\n");
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 2000;
  const slice = lines.slice(offset, offset + limit);

  /* Line numbers because the model has to cite exact text back to edit_file,
     and because a result without them is hard for a human to read in a diff. */
  const numbered = slice.map((line, i) => `${offset + i + 1}\t${line}`).join("\n");
  const clipped = clip(numbered, o.maxOutputBytes);

  return {
    ok: true,
    output: clipped.text,
    truncated: clipped.truncated || offset + limit < lines.length,
    totalBytes: Buffer.byteLength(content),
  };
}

async function writeFileTool(
  args: { path: string; content: string },
  o: ExecuteOptions,
): Promise<ToolOutcome> {
  const path = await o.workspace.resolve(args.path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, args.content, "utf8");

  const lines = args.content.split("\n").length;
  return { ok: true, output: `Wrote ${o.workspace.display(path)} (${lines} lines).` };
}

async function editFileTool(
  args: { path: string; old_string: string; new_string: string; replace_all?: boolean },
  o: ExecuteOptions,
): Promise<ToolOutcome> {
  const path = await o.workspace.resolve(args.path, { mustExist: true });
  const content = await readFile(path, "utf8");

  const occurrences = countOccurrences(content, args.old_string);

  if (occurrences === 0) {
    return {
      ok: false,
      output:
        `The text to replace was not found in ${args.path}. ` +
        `Read the file again — it must match exactly, including whitespace and indentation.`,
    };
  }
  if (occurrences > 1 && !args.replace_all) {
    /* Replacing the first of several silently edits the wrong line as often as
       the right one. Better to make the model disambiguate. */
    return {
      ok: false,
      output:
        `Found ${occurrences} occurrences in ${args.path}. ` +
        `Include more surrounding context to make it unique, or set replace_all.`,
    };
  }

  const updated = args.replace_all
    ? content.split(args.old_string).join(args.new_string)
    : content.replace(args.old_string, args.new_string);

  await writeFile(path, updated, "utf8");

  const added = args.new_string.split("\n").length;
  const removed = args.old_string.split("\n").length;
  return {
    ok: true,
    output: `Edited ${o.workspace.display(path)} (${occurrences} replacement${
      occurrences === 1 ? "" : "s"
    }, ~+${added} −${removed}).`,
  };
}

async function listDirTool(args: { path?: string }, o: ExecuteOptions): Promise<ToolOutcome> {
  const path = await o.workspace.resolve(args.path ?? ".", { mustExist: true });
  const entries = await readdir(path, { withFileTypes: true });

  const listed = entries
    .filter((e) => !e.name.startsWith(".git"))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));

  return {
    ok: true,
    output: listed.length ? listed.join("\n") : "(empty directory)",
  };
}

async function globTool(
  args: { pattern: string; limit?: number },
  o: ExecuteOptions,
): Promise<ToolOutcome> {
  const limit = args.limit ?? 200;
  const found: Array<{ path: string; mtime: number }> = [];

  for await (const entry of new Bun.Glob(args.pattern).scan({
    cwd: o.workspace.root,
    onlyFiles: true,
    dot: false,
  })) {
    const absolute = join(o.workspace.root, entry);
    /* A glob can still surface a symlink that leaves the workspace. */
    if (!o.workspace.contains(absolute)) continue;
    try {
      found.push({ path: entry, mtime: (await stat(absolute)).mtimeMs });
    } catch {
      /* Vanished between scan and stat. */
    }
    if (found.length >= limit * 4) break;
  }

  /* Most recently modified first: in a repo, that is almost always what the
     agent is looking for. */
  found.sort((a, b) => b.mtime - a.mtime);
  const top = found.slice(0, limit);

  return {
    ok: true,
    output: top.length ? top.map((f) => f.path).join("\n") : `No files match ${args.pattern}`,
    truncated: found.length > top.length,
  };
}

async function grepTool(
  args: { pattern: string; path?: string; glob?: string; limit?: number },
  o: ExecuteOptions,
): Promise<ToolOutcome> {
  const limit = args.limit ?? 100;
  const searchRoot = await o.workspace.resolve(args.path ?? ".", { mustExist: true });

  let regex: RegExp;
  try {
    regex = new RegExp(args.pattern);
  } catch (err) {
    return { ok: false, output: `Invalid regular expression: ${(err as Error).message}` };
  }

  const matches: string[] = [];
  const glob = new Bun.Glob(args.glob ?? "**/*");

  for await (const entry of glob.scan({ cwd: searchRoot, onlyFiles: true, dot: false })) {
    if (matches.length >= limit) break;

    const absolute = join(searchRoot, entry);
    if (!o.workspace.contains(absolute)) continue;

    let content: string;
    try {
      const info = await stat(absolute);
      /* Skip anything large enough to be a build artefact or a binary. */
      if (info.size > 2_000_000) continue;
      content = await readFile(absolute, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\0")) continue;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length && matches.length < limit; i++) {
      if (regex.test(lines[i])) {
        matches.push(`${o.workspace.display(absolute)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
      }
    }
  }

  return {
    ok: true,
    output: matches.length ? matches.join("\n") : `No matches for ${args.pattern}`,
    truncated: matches.length >= limit,
  };
}

/* ------------------------------------------------------------------- bash */

async function bashTool(
  args: { command: string; timeout_ms?: number },
  o: ExecuteOptions,
): Promise<ToolOutcome> {
  const timeout = args.timeout_ms ?? o.defaultTimeoutMs;

  const proc = Bun.spawn(["bash", "-lc", args.command], {
    cwd: o.workspace.root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MAESTRO_NODE: "1" },
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const killAfter = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeout);

  const abort = () => proc.kill("SIGKILL");
  o.signal?.addEventListener("abort", abort, { once: true });

  const pump = async (stream: ReadableStream<Uint8Array>, which: "stdout" | "stderr") => {
    const reader = stream.getReader();
    /* stream:true so a chunk boundary inside a multi-byte character does not
       become a replacement character in the middle of the output. */
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (which === "stdout") stdout += text;
        else stderr += text;
        /* Streamed to the UI as it arrives, so a long command is watchable
           rather than a spinner that resolves all at once. */
        o.onLog?.(which, text);
      }
    } finally {
      reader.releaseLock();
    }
  };

  try {
    await Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")]);
    const exitCode = await proc.exited;

    const combined = [stdout, stderr].filter(Boolean).join(stderr && stdout ? "\n--- stderr ---\n" : "");
    const clipped = clip(combined, o.maxOutputBytes);

    if (timedOut) {
      return {
        ok: false,
        output: `${clipped.text}\n\nCommand timed out after ${timeout}ms and was killed.`,
        exitCode: 124,
        truncated: clipped.truncated,
        totalBytes: Buffer.byteLength(combined),
      };
    }

    return {
      ok: exitCode === 0,
      output: clipped.text || (exitCode === 0 ? "(no output)" : `Exited with code ${exitCode}.`),
      exitCode,
      truncated: clipped.truncated,
      totalBytes: Buffer.byteLength(combined),
    };
  } finally {
    clearTimeout(killAfter);
    o.signal?.removeEventListener("abort", abort);
  }
}

/* ------------------------------------------------------------------ shared */

/* Keeps the tail as well as the head: for a failing command the error is
   almost always at the end, and a naive head-only clip hides it. */
function clip(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };

  const headBytes = Math.floor(maxBytes * 0.6);
  const tailBytes = maxBytes - headBytes;
  const head = Buffer.from(text).subarray(0, headBytes).toString("utf8");
  const tail = Buffer.from(text).subarray(-tailBytes).toString("utf8");

  return {
    text: `${head}\n\n… output clipped …\n\n${tail}`,
    truncated: true,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
