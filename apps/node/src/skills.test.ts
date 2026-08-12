import { expect, test, describe, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "./workspace";
import { discoverSkills, readSkillBody } from "./skills";

/* Skills live in the repository, so discovery runs on the machine holding the
   checkout. Everything a repository can contain — a broken file, a symlink out
   of the tree, a mismatched directory — has to be handled here rather than
   surfacing as a confusing failure mid-task. */

let root: string;
let outside: string;
let ws: Workspace;
const made: string[] = [];

function writeSkill(name: string, contents: string, dir = name) {
  const path = join(root, ".maestro", "skills", dir);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), contents);
}

const good = (name: string) =>
  `---\nname: ${name}\ndescription: Does the ${name} procedure whenever the user asks for it.\n---\n\n1. Step one.\n2. Step two.\n`;

beforeEach(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "maestro-skills-")));
  made.push(base);
  root = join(base, "project");
  outside = join(base, "elsewhere");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  ws = await Workspace.open(root);
});

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("discovery", () => {
  test("finds nothing when the directory does not exist", async () => {
    const found = await discoverSkills(ws);
    expect(found.skills).toHaveLength(0);
    expect(found.problems).toHaveLength(0);
  });

  test("finds well-formed skills, sorted by name", async () => {
    writeSkill("deploy", good("deploy"));
    writeSkill("audit", good("audit"));

    const found = await discoverSkills(ws);
    expect(found.skills.map((s) => s.name)).toEqual(["audit", "deploy"]);
    expect(found.skills[0].path).toBe(join(".maestro", "skills", "audit", "SKILL.md"));
  });

  /* The summary is what goes in the prompt; the body is deliberately not
     carried until the model asks for it. */
  test("carries the description but is read separately from the body", async () => {
    writeSkill("deploy", good("deploy"));

    const found = await discoverSkills(ws);
    expect(found.skills[0].description).toContain("deploy procedure");
    expect(await readSkillBody(ws, "deploy")).toContain("Step one");
  });
});

describe("what is reported rather than silently skipped", () => {
  /* A skill whose author believes it is active but that never loads is worse
     than an error, so every failure is named. */
  test("a malformed skill becomes a problem, not a silence", async () => {
    writeSkill("broken", "no frontmatter here");
    writeSkill("deploy", good("deploy"));

    const found = await discoverSkills(ws);
    expect(found.skills.map((s) => s.name)).toEqual(["deploy"]);
    expect(found.problems).toHaveLength(1);
    expect(found.problems[0].message).toContain("frontmatter");
  });

  /* Being told one name while the file lives under another is a trap: the
     model calls load_skill with a name that resolves nowhere. */
  test("a name that disagrees with its directory is refused", async () => {
    writeSkill("deploy", good("shipit"), "deploy");

    const found = await discoverSkills(ws);
    expect(found.skills).toHaveLength(0);
    expect(found.problems[0].message).toContain("does not match the directory");
  });

  test("an oversized skill is refused with advice", async () => {
    writeSkill(
      "huge",
      `---\nname: huge\ndescription: A skill far too large to belong in a prompt.\n---\n` +
        "x".repeat(70 * 1024),
    );

    const found = await discoverSkills(ws);
    expect(found.problems[0].message).toContain("Move the detail into scripts");
  });
});

describe("containment", () => {
  /* A skill directory is still a path, and paths in a repository can point
     anywhere. */
  test("a symlinked skill directory pointing out of the workspace is ignored", async () => {
    writeFileSync(join(outside, "SKILL.md"), good("sneaky"));
    mkdirSync(join(root, ".maestro", "skills"), { recursive: true });
    symlinkSync(outside, join(root, ".maestro", "skills", "sneaky"));

    const found = await discoverSkills(ws);
    expect(found.skills).toHaveLength(0);
  });

  test("a traversing name cannot be loaded", async () => {
    writeSkill("deploy", good("deploy"));

    expect(await readSkillBody(ws, "../../../etc/passwd")).toBeNull();
    expect(await readSkillBody(ws, "..")).toBeNull();
    expect(await readSkillBody(ws, "deploy/../../secrets")).toBeNull();
  });

  test("an unknown skill reads as null rather than throwing", async () => {
    expect(await readSkillBody(ws, "nonexistent")).toBeNull();
  });
});
