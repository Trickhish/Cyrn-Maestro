import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace, PathEscape } from "./workspace";

/* The node executes whatever the server sends, and the server builds paths from
   text a model produced. Everything here is an escape a model can and will
   produce, either by accident or because someone asked it to. */

let root: string;
let outside: string;
let ws: Workspace;

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "maestro-ws-")));
  root = join(base, "project");
  outside = join(base, "secrets");

  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeFileSync(join(root, "src", "index.ts"), "export const x = 1\n");
  writeFileSync(join(outside, "id_rsa"), "PRIVATE KEY\n");

  /* A symlink that is textually inside the workspace but resolves out of it. */
  symlinkSync(outside, join(root, "escape-link"));
  symlinkSync(join(outside, "id_rsa"), join(root, "src", "linked-key"));

  /* A sibling directory sharing the root's name as a prefix. */
  mkdirSync(`${root}-evil`, { recursive: true });
  writeFileSync(join(`${root}-evil`, "loot.txt"), "loot\n");

  ws = await Workspace.open(root);
});

afterAll(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
});

describe("paths that are allowed", () => {
  test("a relative path inside the workspace", async () => {
    const resolved = await ws.resolve("src/index.ts", { mustExist: true });
    expect(resolved).toBe(join(root, "src", "index.ts"));
  });

  test("an absolute path that is already inside", async () => {
    const resolved = await ws.resolve(join(root, "src/index.ts"), { mustExist: true });
    expect(resolved).toBe(join(root, "src", "index.ts"));
  });

  test("a file that does not exist yet, for writing", async () => {
    const resolved = await ws.resolve("src/new/deep/file.ts");
    expect(resolved).toBe(join(root, "src", "new", "deep", "file.ts"));
  });

  test("interior '..' that stays inside", async () => {
    const resolved = await ws.resolve("src/../src/index.ts", { mustExist: true });
    expect(resolved).toBe(join(root, "src", "index.ts"));
  });

  test("the root itself", async () => {
    expect(await ws.resolve(".")).toBe(root);
  });
});

describe("paths that must be refused", () => {
  test("climbing out with ..", async () => {
    await expect(ws.resolve("../secrets/id_rsa")).rejects.toBeInstanceOf(PathEscape);
    await expect(ws.resolve("src/../../secrets/id_rsa")).rejects.toBeInstanceOf(PathEscape);
  });

  test("an absolute path outside the workspace", async () => {
    await expect(ws.resolve("/etc/passwd")).rejects.toBeInstanceOf(PathEscape);
    await expect(ws.resolve(join(outside, "id_rsa"))).rejects.toBeInstanceOf(PathEscape);
  });

  /* Textually inside, resolves outside. Checking containment before resolution
     would let this through, which is the whole reason resolution comes first. */
  test("a symlinked directory pointing out of the workspace", async () => {
    await expect(ws.resolve("escape-link/id_rsa")).rejects.toBeInstanceOf(PathEscape);
  });

  test("a symlinked file pointing out of the workspace", async () => {
    await expect(ws.resolve("src/linked-key", { mustExist: true })).rejects.toBeInstanceOf(PathEscape);
  });

  test("writing through a symlink that escapes", async () => {
    await expect(ws.resolve("escape-link/planted.txt")).rejects.toBeInstanceOf(PathEscape);
  });

  /* "/tmp/x/project-evil" starts with "/tmp/x/project" as a string. Comparing
     without the separator would treat a sibling directory as contained. */
  test("a sibling directory whose name extends the root", async () => {
    await expect(ws.resolve(`${root}-evil/loot.txt`)).rejects.toBeInstanceOf(PathEscape);
  });

  test("a null byte, which can truncate a path at the syscall boundary", async () => {
    await expect(ws.resolve("src/index.ts\0../../etc/passwd")).rejects.toBeInstanceOf(PathEscape);
  });

  test("deep traversal", async () => {
    await expect(ws.resolve("../".repeat(40) + "etc/passwd")).rejects.toBeInstanceOf(PathEscape);
  });
});

describe("reporting", () => {
  test("display paths are relative, so transcripts do not leak the layout", () => {
    expect(ws.display(join(root, "src", "index.ts"))).toBe(join("src", "index.ts"));
    expect(ws.display(root)).toBe(".");
  });

  test("a missing file is a plain error, not an escape", async () => {
    await expect(ws.resolve("src/nope.ts", { mustExist: true })).rejects.toThrow(/No such file/);
  });
});
