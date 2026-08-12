import { expect, test, describe } from "bun:test";
import { parseSkill, skillSummary, SkillParseError } from "./skills";

/* SKILL.md is hand-written and rarely tested by whoever wrote it, so the parser
   has to fail with a sentence that says what to fix rather than a stack trace
   from a YAML library. */

const valid = `---
name: deploy
description: Deploy this service to staging or production. Use when the user asks to deploy, ship, or roll back.
---

## Deploying

1. Check CI is green.
2. Build the image.
`;

describe("a well-formed skill", () => {
  test("yields the frontmatter and the body", () => {
    const skill = parseSkill(valid);
    expect(skill.name).toBe("deploy");
    expect(skill.description).toStartWith("Deploy this service");
    expect(skill.body).toContain("## Deploying");
    expect(skill.body).toContain("Check CI is green");
  });

  test("the body excludes the frontmatter", () => {
    expect(parseSkill(valid).body).not.toContain("name: deploy");
  });

  test("an optional version is kept", () => {
    const skill = parseSkill(`---
name: deploy
description: Deploy the service when asked to ship a release.
version: 2.1
---
body here
`);
    expect(skill.version).toBe("2.1");
  });

  /* Descriptions are long and wrapping them is natural, so an indented
     continuation line belongs to the key above it. */
  test("a wrapped description is joined", () => {
    const skill = parseSkill(`---
name: deploy
description: Deploy this service to staging or production.
  Use when the user asks to ship or roll back a release.
---
body
`);
    expect(skill.description).toContain("staging or production. Use when");
  });

  test("quotes around a value are stripped, so colons can be written naturally", () => {
    const skill = parseSkill(`---
name: deploy
description: "Deploy: staging or production, whenever a release is asked for."
---
body
`);
    expect(skill.description).toStartWith("Deploy: staging");
  });

  test("a leading byte-order mark does not break it", () => {
    expect(parseSkill("﻿" + valid).name).toBe("deploy");
  });

  test("Windows line endings do not break it", () => {
    expect(parseSkill(valid.replace(/\n/g, "\r\n")).name).toBe("deploy");
  });
});

describe("what is refused, and why", () => {
  test("no frontmatter at all", () => {
    expect(() => parseSkill("just a document")).toThrow(/must start with a frontmatter block/);
  });

  test("frontmatter that is never closed", () => {
    expect(() => parseSkill("---\nname: x\n")).toThrow(/unterminated/);
  });

  test("a missing name", () => {
    expect(() => parseSkill(`---\ndescription: Something long enough to pass.\n---\nbody\n`)).toThrow(
      SkillParseError,
    );
  });

  /* The description is what the model routes on. One that only names the skill
     gives it nothing to decide with. */
  test("a description too short to route on", () => {
    expect(() => parseSkill(`---\nname: x\ndescription: deploy\n---\nbody\n`)).toThrow(/description/);
  });

  test("a name that is not a slug", () => {
    expect(() =>
      parseSkill(`---\nname: My Deploy Skill\ndescription: Deploy when asked to ship.\n---\nbody\n`),
    ).toThrow(/lowercase/);
  });

  test("an empty body, since the procedure is the point", () => {
    expect(() =>
      parseSkill(`---\nname: deploy\ndescription: Deploy when asked to ship a release.\n---\n\n`),
    ).toThrow(/no body/);
  });

  test("a line that is not a key and value", () => {
    expect(() =>
      parseSkill(`---\nname: deploy\nthis is not a field\ndescription: Deploy on request.\n---\nbody\n`),
    ).toThrow(/not a key and value/);
  });

  /* Accepting the whole of YAML would mean accepting its surprises in a file
     nobody tests. Anything structural is rejected by name. */
  test("a list or an object, with a message saying so", () => {
    expect(() =>
      parseSkill(`---\nname: deploy\ndescription: Deploy on request please.\ntags: [a, b]\n---\nbody\n`),
    ).toThrow(/plain text/);
  });

  test("the error names the file it came from", () => {
    expect(() => parseSkill("nope", ".maestro/skills/deploy/SKILL.md")).toThrow(
      /\.maestro\/skills\/deploy\/SKILL\.md/,
    );
  });
});

describe("the summary that sits in every prompt", () => {
  test("is one line of name and description", () => {
    const line = skillSummary({ name: "deploy", description: "Deploy when asked to ship." });
    expect(line).toBe("- deploy: Deploy when asked to ship.");
    expect(line.split("\n")).toHaveLength(1);
  });
});
