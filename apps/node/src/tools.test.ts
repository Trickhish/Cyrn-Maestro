import { expect, test, describe, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "./workspace";
import { executeTool, type ExecuteOptions } from "./tools";

let root: string;
let options: ExecuteOptions;
const made: string[] = [];

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "maestro-tools-")));
  made.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "const a = 1\nconst b = 2\nconst a = 1\n");
  writeFileSync(join(root, "README.md"), "# Title\nhello\n");

  options = {
    workspace: await Workspace.open(root),
    maxOutputBytes: 2000,
    defaultTimeoutMs: 10_000,
  };
});

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("argument validation", () => {
  /* A failed result rather than a thrown error: the model can read this and
     correct itself next turn, which is cheaper than failing the task. */
  test("bad arguments come back as a readable failure, not an exception", async () => {
    const result = await executeTool("read_file", { wrong: "shape" }, options);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Invalid arguments for read_file");
  });

  test("a path escape is refused", async () => {
    const result = await executeTool("read_file", { path: "../../etc/passwd" }, options);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("outside the workspace");
  });
});

describe("read_file", () => {
  test("returns numbered lines so the model can cite them back", async () => {
    const result = await executeTool("read_file", { path: "src/a.ts" }, options);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("1\tconst a = 1");
  });

  test("honours offset and limit", async () => {
    const result = await executeTool("read_file", { path: "src/a.ts", offset: 1, limit: 1 }, options);
    expect(result.output).toBe("2\tconst b = 2");
    expect(result.truncated).toBe(true);
  });

  test("points at list_dir when given a directory", async () => {
    const result = await executeTool("read_file", { path: "src" }, options);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("list_dir");
  });
});

describe("edit_file", () => {
  test("replaces a unique string", async () => {
    const result = await executeTool(
      "edit_file",
      { path: "README.md", old_string: "hello", new_string: "goodbye" },
      options,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain("goodbye");
  });

  /* Replacing the first of several edits the wrong line as often as the right
     one, and the model cannot tell which happened. Refuse and make it
     disambiguate. */
  test("refuses an ambiguous match instead of guessing", async () => {
    const result = await executeTool(
      "edit_file",
      { path: "src/a.ts", old_string: "const a = 1", new_string: "const a = 9" },
      options,
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain("2 occurrences");
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toContain("const a = 1");
  });

  test("replace_all takes every occurrence", async () => {
    const result = await executeTool(
      "edit_file",
      { path: "src/a.ts", old_string: "const a = 1", new_string: "const a = 9", replace_all: true },
      options,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).not.toContain("const a = 1");
  });

  test("a missing match says what to do about it", async () => {
    const result = await executeTool(
      "edit_file",
      { path: "README.md", old_string: "not present", new_string: "x" },
      options,
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Read the file again");
  });
});

describe("write_file", () => {
  test("creates missing parent directories", async () => {
    const result = await executeTool(
      "write_file",
      { path: "deep/nested/new.ts", content: "export {}\n" },
      options,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, "deep", "nested", "new.ts"), "utf8")).toBe("export {}\n");
  });

  test("cannot write outside the workspace", async () => {
    const result = await executeTool(
      "write_file",
      { path: "../escaped.ts", content: "nope" },
      options,
    );
    expect(result.ok).toBe(false);
  });
});

describe("search", () => {
  test("glob finds files", async () => {
    const result = await executeTool("glob", { pattern: "src/**/*.ts" }, options);
    expect(result.output).toContain("src/a.ts");
  });

  test("grep reports file and line", async () => {
    const result = await executeTool("grep", { pattern: "const b" }, options);
    expect(result.output).toMatch(/src\/a\.ts:2:/);
  });

  test("an invalid regex is a readable failure", async () => {
    const result = await executeTool("grep", { pattern: "([" }, options);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Invalid regular expression");
  });
});

describe("bash", () => {
  test("captures stdout and a zero exit", async () => {
    const result = await executeTool("bash", { command: "echo hello" }, options);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("hello");
    expect(result.exitCode).toBe(0);
  });

  test("a non-zero exit is a failure, with the code", async () => {
    const result = await executeTool("bash", { command: "exit 3" }, options);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
  });

  test("runs in the workspace root", async () => {
    const result = await executeTool("bash", { command: "pwd" }, options);
    expect(result.output.trim()).toBe(root);
  });

  test("stderr is captured, not lost", async () => {
    const result = await executeTool("bash", { command: "echo oops >&2; exit 1" }, options);
    expect(result.output).toContain("oops");
  });

  /* A command that hangs must not hang the task forever. */
  test("times out and reports it", async () => {
    const result = await executeTool(
      "bash",
      { command: "sleep 30", timeout_ms: 1000 },
      options,
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(result.output).toContain("timed out");
  }, 15_000);

  test("streams output as it arrives", async () => {
    const seen: string[] = [];
    const result = await executeTool(
      "bash",
      { command: "echo one; echo two" },
      { ...options, onLog: (_s, chunk) => seen.push(chunk) },
    );
    expect(result.ok).toBe(true);
    expect(seen.join("")).toContain("one");
  });
});

describe("output clipping", () => {
  /* For a failing command the error is almost always at the end, so a
     head-only clip hides exactly the part that matters. */
  test("keeps the tail as well as the head", async () => {
    const result = await executeTool(
      "bash",
      { command: "for i in $(seq 1 4000); do echo line-$i; done; echo FINAL-MARKER" },
      { ...options, maxOutputBytes: 500 },
    );
    expect(result.truncated).toBe(true);
    expect(result.output).toContain("line-1");
    expect(result.output).toContain("FINAL-MARKER");
    expect(result.output).toContain("clipped");
  });

  test("reports the true size of what was clipped", async () => {
    const result = await executeTool(
      "bash",
      { command: "for i in $(seq 1 4000); do echo line-$i; done" },
      { ...options, maxOutputBytes: 500 },
    );
    expect(result.totalBytes).toBeGreaterThan(500);
  });
});
