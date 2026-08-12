import { z } from "zod";

/* Skills.
 *
 * A skill is a directory with a SKILL.md and whatever scripts it needs. The
 * frontmatter carries a name and a description; the body carries the procedure.
 *
 * The economics are the point: only the name and description of every in-scope
 * skill sit in the model's context — a couple of lines each — and the body is
 * loaded only when the model judges the skill relevant. Twenty skills cost
 * about forty lines of context instead of twenty procedures' worth. */

export const SkillFrontmatter = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, digits and hyphens."),
  /* This is what the model routes on, so it has to say when to use the skill,
     not just what it is. A description that only names the skill gives the
     model nothing to decide with. */
  description: z.string().min(10).max(1024),
  version: z.string().max(32).optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatter>;

export interface ParsedSkill {
  name: string;
  description: string;
  version?: string;
  body: string;
}

export class SkillParseError extends Error {}

/* Deliberately a small parser rather than a YAML dependency.
 *
 * Frontmatter here is a handful of `key: value` lines, and accepting the whole
 * of YAML would mean accepting its surprises — the Norway problem, tabs,
 * anchors — in a file people hand-write and rarely test. Anything more
 * elaborate than a scalar is rejected with a message saying so. */
export function parseSkill(source: string, origin = "SKILL.md"): ParsedSkill {
  const text = source.replace(/^﻿/, "").replace(/\r\n/g, "\n");

  if (!text.startsWith("---\n")) {
    throw new SkillParseError(
      `${origin} must start with a frontmatter block: three dashes, then name and description.`,
    );
  }

  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    throw new SkillParseError(`${origin} has an unterminated frontmatter block.`);
  }

  const raw = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n+/, "");

  const fields: Record<string, string> = {};
  let currentKey: string | null = null;

  for (const line of raw.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    /* A continuation line: indented, belonging to the key above it. This is
       the one multi-line form worth supporting, because descriptions are long
       and wrapping them is natural. */
    if (/^\s/.test(line) && currentKey) {
      fields[currentKey] = `${fields[currentKey]} ${line.trim()}`.trim();
      continue;
    }

    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new SkillParseError(`${origin}: "${line.trim()}" is not a key and value.`);
    }

    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();

    if (value.startsWith("[") || value.startsWith("{")) {
      throw new SkillParseError(
        `${origin}: ${key} must be plain text. Lists and objects are not supported here.`,
      );
    }

    /* Quotes are stripped so a description containing a colon can be written
       naturally. */
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    fields[key] = value;
    currentKey = key;
  }

  const parsed = SkillFrontmatter.safeParse(fields);
  if (!parsed.success) {
    throw new SkillParseError(
      `${origin}: ${parsed.error.issues.map((i) => `${i.path.join(".")} — ${i.message}`).join("; ")}`,
    );
  }

  if (!body.trim()) {
    throw new SkillParseError(`${origin} has no body. The procedure goes after the frontmatter.`);
  }

  return { ...parsed.data, body };
}

/* The two lines per skill that sit in every prompt. */
export function skillSummary(skill: Pick<ParsedSkill, "name" | "description">): string {
  return `- ${skill.name}: ${skill.description}`;
}

export const SkillSource = z.enum(["repo", "shared"]);
export type SkillSource = z.infer<typeof SkillSource>;
