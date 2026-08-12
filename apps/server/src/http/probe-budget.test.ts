import { expect, test, describe } from "bun:test";
import { rankForProbing } from "./providers.routes";

/* A gateway can advertise several hundred models. Probing each one costs a real
   API call, so a refresh verifies a budget of them and leaves the rest with no
   verdict — usable, but unverified. Which ones get the budget matters: a capped
   run should check what the router would actually pick. */

describe("who gets the probe budget", () => {
  test("frontier models come first", () => {
    for (const model of ["claude-opus-5", "claude-sonnet-5", "gpt-5", "gemini-3-flash"]) {
      expect(rankForProbing(model)).toBe(0);
    }
  });

  /* A dated snapshot is a specific older build. It is worth listing, but it is
     not what the router reaches for first. */
  test("dated snapshots rank below their undated equivalent", () => {
    expect(rankForProbing("claude-sonnet-4-5-20250929")).toBeGreaterThan(
      rankForProbing("claude-sonnet-5"),
    );
  });

  test("known families still beat unknown ones", () => {
    expect(rankForProbing("llama-3-70b")).toBeLessThan(rankForProbing("some-obscure-model"));
  });

  test("ordering puts the frontier at the front of a capped run", () => {
    const catalogue = [
      "obscure-thing-v2",
      "claude-sonnet-4-5-20250929",
      "claude-opus-5",
      "random-model",
      "gemini-3-flash",
    ];
    const ordered = [...catalogue].sort((a, b) => rankForProbing(a) - rankForProbing(b));

    expect(ordered.slice(0, 2).sort()).toEqual(["claude-opus-5", "gemini-3-flash"]);
    expect(ordered.at(-1)).toMatch(/obscure|random/);
  });
});
