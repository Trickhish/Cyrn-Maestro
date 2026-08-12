import { expect, test, describe } from "bun:test";
import { weighTask, acceptableTiers, inferTier } from "./weigh";

/* The weighting is a heuristic, and these tests treat it as one: they pin the
   direction it leans, not a precise score. What must hold is the asymmetry —
   guessing too big costs money, guessing too small costs a wrong answer. */

describe("what counts as heavy", () => {
  for (const prompt of [
    "Refactor the auth module to use dependency injection",
    "Debug why the payment webhook sometimes drops events",
    "The auth test is flaky in CI, find out why",
    "Redesign the task scheduling architecture",
    "Investigate the race condition in the session cache",
    "Write a migration to split the users table",
  ]) {
    test(prompt.slice(0, 46), () => {
      expect(weighTask(prompt).tier).toBe("heavy");
    });
  }

  test("a long prompt is heavy whatever words it uses", () => {
    const long = "Please rename the variable. ".repeat(30);
    expect(weighTask(long).tier).toBe("heavy");
  });
});

describe("what counts as light", () => {
  for (const prompt of [
    "Rename getUser to fetchUser",
    "Fix the typo in the README",
    "Run the formatter over src",
    "Bump the version to 1.2.0",
  ]) {
    test(prompt, () => {
      expect(weighTask(prompt).tier).toBe("light");
    });
  }

  /* "Rename" in a long request is not a rename job. */
  test("a light word inside a large request is not light", () => {
    const prompt =
      "Rename the config module, then update every import across the codebase, " +
      "add tests for the new names, and make sure the build still passes on CI " +
      "with the older Node version we still support in production environments";
    expect(weighTask(prompt).tier).not.toBe("light");
  });
});

describe("everything else is standard", () => {
  for (const prompt of [
    "Add a health check endpoint",
    "Write tests for the session helper",
    "Add pagination to the tasks list",
  ]) {
    test(prompt, () => {
      expect(weighTask(prompt).tier).toBe("standard");
    });
  }
});

describe("substitution is asymmetric", () => {
  /* Up is fine — it costs more and does the job. Down is not: a heavy task on
     a light model produces a confident, wrong answer. */
  test("a light task may run on anything", () => {
    expect(acceptableTiers("light")).toEqual(["light", "standard", "heavy"]);
  });

  test("a standard task may not drop to light", () => {
    expect(acceptableTiers("standard")).not.toContain("light");
  });

  test("a heavy task may only run heavy", () => {
    expect(acceptableTiers("heavy")).toEqual(["heavy"]);
  });
});

describe("inferring a tier from a model name", () => {
  for (const [model, tier] of [
    ["claude-haiku-4-5-20251001", "light"],
    ["gemini-3.5-flash-extra-low", "light"],
    ["claude-sonnet-5", "standard"],
    ["claude-opus-5", "heavy"],
    ["claude-opus-4-6-thinking", "heavy"],
    ["gemini-pro-agent", "heavy"],
    ["gpt-oss-120b-medium", "standard"],
  ] as const) {
    test(`${model} → ${tier}`, () => {
      expect(inferTier(model)).toBe(tier);
    });
  }
});

/* The real model list from the configured provider. Unanchored token matching
   put "gemini-pro-agent" in the light tier because it contains "mini", which
   would have routed heavy work to a small model and produced confident wrong
   answers rather than an honest failure. */
describe("the provider's actual models", () => {
  const expected: Array<[string, "light" | "standard" | "heavy"]> = [
    ["claude-opus-5", "heavy"],
    ["claude-opus-4-6", "heavy"],
    ["claude-opus-4-6-thinking", "heavy"],
    ["claude-sonnet-5", "standard"],
    ["claude-sonnet-4-5-20250929", "standard"],
    ["claude-haiku-4-5-20251001", "light"],
    ["gemini-3-flash", "standard"],
    ["gemini-3-flash-agent", "heavy"],
    ["gemini-pro-agent", "heavy"],
    ["gemini-3.5-flash-low", "light"],
    ["gemini-3.5-flash-extra-low", "light"],
    ["gemini-3.1-flash-lite", "light"],
    ["gemini-3.1-pro-low", "light"],
    ["gpt-oss-120b-medium", "standard"],
  ];

  for (const [model, tier] of expected) {
    test(`${model} → ${tier}`, () => {
      expect(inferTier(model)).toBe(tier);
    });
  }

  test("no model containing 'mini' as a substring is misread", () => {
    expect(inferTier("gemini-3-flash")).not.toBe("light");
    expect(inferTier("gemini-pro-agent")).not.toBe("light");
    /* But a real mini still reads as one. */
    expect(inferTier("gpt-4o-mini")).toBe("light");
  });
});

describe("every verdict explains itself", () => {
  test("because it appears in the composer chip and the thread", () => {
    for (const prompt of ["Rename x to y", "Refactor everything", "Add an endpoint"]) {
      expect(weighTask(prompt).because.length).toBeGreaterThan(8);
    }
  });
});
