import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseSkill, SkillParseError, type ParsedSkill } from "@maestro/protocol";
import type { Workspace } from "./workspace";

/* Discovering skills committed in the repository.
 *
 * They live under .maestro/skills/<name>/SKILL.md, which means they version
 * with the code: a branch that changes a procedure changes the skill the agent
 * follows on that branch, and the change is reviewable in a pull request.
 *
 * Discovery is done on the node rather than the server because the server has
 * no copy of the repository — only the machine with the checkout knows what
 * the current branch actually contains. */

const SKILLS_DIR = join(".maestro", "skills");
const MAX_BODY_BYTES = 64 * 1024;

export interface DiscoveredSkill extends ParsedSkill {
  /* Relative to the workspace, for showing where a skill came from. */
  path: string;
}

export interface SkillDiscovery {
  skills: DiscoveredSkill[];
  /* A malformed skill is reported rather than silently skipped: a skill the
     author believes is active but that never loads is worse than an error. */
  problems: Array<{ path: string; message: string }>;
}

export async function discoverSkills(workspace: Workspace): Promise<SkillDiscovery> {
  const root = join(workspace.root, SKILLS_DIR);
  const found: DiscoveredSkill[] = [];
  const problems: SkillDiscovery["problems"] = [];

  if (!existsSync(root)) return { skills: found, problems };

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    return {
      skills: found,
      problems: [{ path: SKILLS_DIR, message: (err as Error).message }],
    };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const relative = join(SKILLS_DIR, entry.name, "SKILL.md");

    /* Resolved through the workspace so a symlinked skill directory cannot
       read a file outside the checkout. */
    let absolute: string;
    try {
      absolute = await workspace.resolve(relative, { mustExist: true });
    } catch {
      continue;
    }

    try {
      const source = await readFile(absolute, "utf8");
      if (Buffer.byteLength(source) > MAX_BODY_BYTES) {
        problems.push({
          path: relative,
          message: `Skill is larger than ${MAX_BODY_BYTES / 1024}KB. Move the detail into scripts the skill runs.`,
        });
        continue;
      }

      const skill = parseSkill(source, relative);

      /* The directory name and the declared name disagreeing is a trap: the
         model is told one thing and the file lives somewhere else. */
      if (skill.name !== entry.name) {
        problems.push({
          path: relative,
          message: `Declared name "${skill.name}" does not match the directory "${entry.name}".`,
        });
        continue;
      }

      found.push({ ...skill, path: relative });
    } catch (err) {
      problems.push({
        path: relative,
        message: err instanceof SkillParseError ? err.message : (err as Error).message,
      });
    }
  }

  return { skills: found.sort((a, b) => a.name.localeCompare(b.name)), problems };
}

/* Reads one skill's body on demand. Called when the model decides a skill is
   relevant, which is the whole reason only summaries sit in the prompt. */
export async function readSkillBody(
  workspace: Workspace,
  name: string,
): Promise<string | null> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;

  const relative = join(SKILLS_DIR, name, "SKILL.md");
  try {
    const absolute = await workspace.resolve(relative, { mustExist: true });
    return parseSkill(await readFile(absolute, "utf8"), relative).body;
  } catch {
    return null;
  }
}
