import { expect, test, describe, beforeEach } from "bun:test";
import { db, schema } from "../db";
import { resetDatabase } from "../test/harness";
import { resolveDefaults, matches } from "./rules";

/* The override ladder, from the README:
 *
 *   org defaults → project defaults → rules → task pin → manual dispatch
 *
 * Each level narrows the one above it. Getting the order wrong means a project
 * setting silently loses to an org one, which is the kind of bug that only
 * shows up on someone else's bill. */

const USER = "user-1";
const ORG = "org-1";
const PROJECT = "project-1";

async function seed({
  orgTier,
  orgModel,
  orgCap,
  projectTier,
  projectModel,
  projectCap,
}: {
  orgTier?: "light" | "standard" | "heavy";
  orgModel?: string;
  orgCap?: number;
  projectTier?: "light" | "standard" | "heavy";
  projectModel?: string;
  projectCap?: number;
} = {}) {
  const now = Date.now();

  await db.insert(schema.users).values({
    id: USER, email: "u@x.com", passwordHash: "x",
    instanceRole: "user", status: "active", createdAt: now,
  });
  await db.insert(schema.organizations).values({
    id: ORG, name: "Acme", slug: "acme", require2fa: false,
    defaultModelId: orgModel ?? null,
    defaultTier: orgTier ?? null,
    spendCapUsd: orgCap ?? null,
    createdAt: now,
  });
  await db.insert(schema.projects).values({
    id: PROJECT, ownerUserId: null, ownerOrgId: ORG, name: "API", slug: "api",
    repoUrl: null, branch: null, instructions: null,
    defaultModelId: projectModel ?? null,
    defaultTier: projectTier ?? null,
    spendCapUsd: projectCap ?? null,
    createdAt: now,
  });
}

async function addRule(rule: Partial<typeof schema.routingRules.$inferInsert> & { name: string }) {
  await db.insert(schema.routingRules).values({
    id: crypto.randomUUID(),
    projectId: null,
    ownerOrgId: null,
    ownerUserId: null,
    priority: 100,
    enabled: true,
    matchText: null,
    matchTier: null,
    setTier: null,
    setModelId: null,
    setNodeId: null,
    createdAt: Date.now(),
    ...rule,
  });
}

const context = (prompt = "do a thing", weighedTier: "light" | "standard" | "heavy" = "standard") => ({
  projectId: PROJECT,
  ownerOrgId: ORG,
  ownerUserId: null,
  prompt,
  weighedTier,
});

beforeEach(resetDatabase);

describe("the ladder", () => {
  test("an org default applies when nothing narrower says otherwise", async () => {
    await seed({ orgTier: "heavy", orgModel: "org-model" });

    const defaults = await resolveDefaults(context());
    expect(defaults.tier?.value).toBe("heavy");
    expect(defaults.tier?.because).toContain("Acme");
    expect(defaults.modelId?.value).toBe("org-model");
  });

  test("a project default beats the org one", async () => {
    await seed({ orgTier: "heavy", orgModel: "org-model", projectTier: "light", projectModel: "project-model" });

    const defaults = await resolveDefaults(context());
    expect(defaults.tier?.value).toBe("light");
    expect(defaults.tier?.because).toContain("project");
    expect(defaults.modelId?.value).toBe("project-model");
  });

  test("a rule beats both", async () => {
    await seed({ orgTier: "heavy", projectTier: "light" });
    await addRule({ name: "always standard", projectId: PROJECT, setTier: "standard" });

    const defaults = await resolveDefaults(context());
    expect(defaults.tier?.value).toBe("standard");
    expect(defaults.tier?.because).toContain('rule "always standard"');
  });

  /* Partial overrides have to compose: a rule that sets only a model must
     leave the project's tier alone rather than resetting it. */
  test("a rule setting one field leaves the others to the level below", async () => {
    await seed({ projectTier: "heavy", projectModel: "project-model" });
    await addRule({ name: "pin the model", projectId: PROJECT, setModelId: "rule-model" });

    const defaults = await resolveDefaults(context());
    expect(defaults.modelId?.value).toBe("rule-model");
    expect(defaults.tier?.value).toBe("heavy");
  });
});

describe("rule matching", () => {
  test("text is matched case-insensitively as a substring", async () => {
    await seed();
    await addRule({ name: "refactors", projectId: PROJECT, matchText: "refactor", setTier: "heavy" });

    expect((await resolveDefaults(context("Please REFACTOR the auth module"))).tier?.value).toBe("heavy");
    expect((await resolveDefaults(context("add a health check"))).tier).toBeUndefined();
  });

  test("a rule can match on the weighed tier", async () => {
    await seed();
    await addRule({ name: "heavy to opus", projectId: PROJECT, matchTier: "heavy", setModelId: "big" });

    expect((await resolveDefaults(context("x", "heavy"))).modelId?.value).toBe("big");
    expect((await resolveDefaults(context("x", "light"))).modelId).toBeUndefined();
  });

  test("a rule with no conditions matches everything", () => {
    expect(matches({ matchText: null, matchTier: null }, { prompt: "anything", weighedTier: "light" })).toBe(true);
  });

  test("a disabled rule does not fire", async () => {
    await seed();
    await addRule({ name: "off", projectId: PROJECT, enabled: false, setTier: "heavy" });
    expect((await resolveDefaults(context())).tier).toBeUndefined();
  });
});

describe("which rule wins", () => {
  test("lower priority runs first", async () => {
    await seed();
    await addRule({ name: "late", projectId: PROJECT, priority: 200, setTier: "light" });
    await addRule({ name: "early", projectId: PROJECT, priority: 10, setTier: "heavy" });

    expect((await resolveDefaults(context())).tier?.value).toBe("heavy");
  });

  /* At equal priority the narrower scope wins: a project rule is a more
     specific statement of intent than an org-wide one. */
  test("a project rule beats an org rule at the same priority", async () => {
    await seed();
    await addRule({ name: "org wide", ownerOrgId: ORG, priority: 50, setTier: "light" });
    await addRule({ name: "this project", projectId: PROJECT, priority: 50, setTier: "heavy" });

    expect((await resolveDefaults(context())).tier?.because).toContain("this project");
  });

  test("an org rule still applies when the project has none", async () => {
    await seed();
    await addRule({ name: "org wide", ownerOrgId: ORG, setTier: "light" });

    expect((await resolveDefaults(context())).tier?.value).toBe("light");
  });

  test("only the first match applies", async () => {
    await seed();
    await addRule({ name: "first", projectId: PROJECT, priority: 1, setTier: "heavy" });
    await addRule({ name: "second", projectId: PROJECT, priority: 2, setModelId: "should-not-apply" });

    const defaults = await resolveDefaults(context());
    expect(defaults.tier?.value).toBe("heavy");
    expect(defaults.modelId).toBeUndefined();
  });

  test("a rule from another project does not leak in", async () => {
    await seed();
    await db.insert(schema.projects).values({
      id: "other-project", ownerUserId: null, ownerOrgId: ORG, name: "Other", slug: "other",
      repoUrl: null, branch: null, instructions: null,
      defaultModelId: null, defaultTier: null, spendCapUsd: null, createdAt: Date.now(),
    });
    await addRule({ name: "elsewhere", projectId: "other-project", setTier: "heavy" });

    expect((await resolveDefaults(context())).tier).toBeUndefined();
  });
});

describe("spend caps", () => {
  test("the project's cap narrows the org's", async () => {
    await seed({ orgCap: 100, projectCap: 5 });
    const defaults = await resolveDefaults(context());
    expect(defaults.spendCapUsd?.value).toBe(5);
    expect(defaults.spendCapUsd?.because).toContain("project");
  });

  test("the org's applies when the project sets none", async () => {
    await seed({ orgCap: 100 });
    expect((await resolveDefaults(context())).spendCapUsd?.value).toBe(100);
  });
});

describe("every resolved value explains itself", () => {
  test("because an unexplained choice reads as a bug", async () => {
    await seed({ orgTier: "heavy", orgCap: 10 });
    await addRule({ name: "a rule", projectId: PROJECT, setModelId: "m" });

    const defaults = await resolveDefaults(context());
    for (const resolved of [defaults.tier, defaults.modelId, defaults.spendCapUsd]) {
      expect(resolved?.because.length).toBeGreaterThan(5);
    }
  });
});
