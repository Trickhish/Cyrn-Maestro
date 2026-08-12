import { expect, test, describe, beforeEach } from "bun:test";
import { db, schema } from "../db";
import { resetDatabase } from "../test/harness";
import { checkSpend } from "./spend";

/* Spend caps. The failure mode to avoid is a cap the user believes is
   protecting them while it silently is not. */

const USER = "u1";
const ORG = "org1";
const PROJECT = "p1";

async function seed({ orgCap, projectCap }: { orgCap?: number; projectCap?: number } = {}) {
  const now = Date.now();
  await db.insert(schema.users).values({
    id: USER, email: "u@x.com", passwordHash: "x",
    instanceRole: "user", status: "active", createdAt: now,
  });
  await db.insert(schema.organizations).values({
    id: ORG, name: "Acme", slug: "acme", require2fa: false,
    defaultModelId: null, defaultTier: null, spendCapUsd: orgCap ?? null, createdAt: now,
  });
  await db.insert(schema.projects).values({
    id: PROJECT, ownerUserId: null, ownerOrgId: ORG, name: "API", slug: "api",
    repoUrl: null, branch: null, instructions: null,
    defaultModelId: null, defaultTier: null, spendCapUsd: projectCap ?? null, createdAt: now,
  });
}

async function spend(costUsd: number, { ageMs = 0, projectId = PROJECT } = {}) {
  await db.insert(schema.tasks).values({
    id: crypto.randomUUID(),
    projectId,
    workspaceId: null, nodeId: null, actorUserId: null,
    title: "t", prompt: "p", status: "completed", model: "m",
    costUsd, inputTokens: 0, outputTokens: 0, error: null,
    startedAt: null, endedAt: null,
    createdAt: Date.now() - ageMs,
  });
}

const scope = { projectId: PROJECT, ownerOrgId: ORG, ownerUserId: null };

beforeEach(resetDatabase);

describe("no cap", () => {
  test("spending is unrestricted", async () => {
    await seed();
    await spend(1000);
    expect((await checkSpend(scope)).exceeded).toBeUndefined();
  });
});

describe("a project cap", () => {
  test("allows spending below it", async () => {
    await seed({ projectCap: 10 });
    await spend(4);

    const result = await checkSpend(scope);
    expect(result.exceeded).toBeUndefined();
    expect(result.spentUsd).toBeCloseTo(4, 5);
    expect(result.capUsd).toBe(10);
  });

  test("stops at it", async () => {
    await seed({ projectCap: 10 });
    await spend(10);
    expect((await checkSpend(scope)).exceeded).toContain("cap");
  });

  /* The message has to name the numbers and say who can change them, or the
     user is left guessing which of several caps stopped them. */
  test("says what was spent, what the cap is, and where to change it", async () => {
    await seed({ projectCap: 10 });
    await spend(12.5);

    const message = (await checkSpend(scope)).exceeded!;
    expect(message).toContain("$12.50");
    expect(message).toContain("$10.00");
    expect(message).toContain("project's settings");
  });

  test("counts every task in the project, not just one", async () => {
    await seed({ projectCap: 10 });
    await spend(4);
    await spend(4);
    await spend(4);
    expect((await checkSpend(scope)).exceeded).toBeDefined();
  });

  /* A rolling window, because a cap that resets on the 1st can be exhausted on
     the 2nd and useless for four weeks — which is not how anyone reads it. */
  test("ignores spending older than thirty days", async () => {
    await seed({ projectCap: 10 });
    await spend(50, { ageMs: 31 * 24 * 3600_000 });
    expect((await checkSpend(scope)).exceeded).toBeUndefined();
  });

  test("counts spending inside the window", async () => {
    await seed({ projectCap: 10 });
    await spend(50, { ageMs: 29 * 24 * 3600_000 });
    expect((await checkSpend(scope)).exceeded).toBeDefined();
  });
});

describe("an organization cap", () => {
  test("applies when the project sets none", async () => {
    await seed({ orgCap: 10 });
    await spend(11);

    const message = (await checkSpend(scope)).exceeded!;
    expect(message).toContain("Acme");
    expect(message).toContain("organization admin");
  });

  test("sums across the organization's projects", async () => {
    await seed({ orgCap: 10 });
    await db.insert(schema.projects).values({
      id: "p2", ownerUserId: null, ownerOrgId: ORG, name: "Other", slug: "other",
      repoUrl: null, branch: null, instructions: null,
      defaultModelId: null, defaultTier: null, spendCapUsd: null, createdAt: Date.now(),
    });

    await spend(6);
    await spend(6, { projectId: "p2" });

    expect((await checkSpend(scope)).exceeded).toBeDefined();
  });

  /* The tighter cap is the one that matters, and a project cap is the more
     specific statement. */
  test("a project cap takes precedence over the org's", async () => {
    await seed({ orgCap: 1000, projectCap: 5 });
    await spend(6);

    const result = await checkSpend(scope);
    expect(result.capUsd).toBe(5);
    expect(result.exceeded).toContain("project");
  });

  test("a project under its own cap is not stopped by the org's headroom", async () => {
    await seed({ orgCap: 5, projectCap: 100 });
    await spend(50);
    /* The project sets a cap, so that is the one enforced. */
    expect((await checkSpend(scope)).exceeded).toBeUndefined();
  });
});
