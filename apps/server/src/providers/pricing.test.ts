import { expect, test, describe } from "bun:test";
import { inferPrice } from "./pricing";
import { estimateCost } from "./gateway";

/* Prices inferred from model names.
 *
 * The table will drift as vendors change their list prices, so these tests do
 * not assert exact dollars for their own sake. What they hold is the shape:
 * that a name resolves to the right family, that a small model never resolves
 * to a large one's price, and above all that an unknown model returns null
 * rather than zero — a zero price accrues no spend and slips past every cap. */

describe("recognising a model family", () => {
  test("matches Anthropic models", () => {
    expect(inferPrice("claude-opus-4-20250514")?.label).toBe("Claude Opus 4");
    expect(inferPrice("claude-sonnet-4-5-20250929")?.label).toBe("Claude Sonnet");
    expect(inferPrice("claude-3-5-haiku-20241022")?.label).toBe("Claude Haiku 3.5");
  });

  test("matches OpenAI models", () => {
    expect(inferPrice("gpt-4o")?.label).toBe("GPT-4o");
    expect(inferPrice("gpt-4o-mini")?.label).toBe("GPT-4o mini");
    expect(inferPrice("gpt-5")?.label).toBe("GPT-5");
    expect(inferPrice("o3-mini")?.label).toBe("OpenAI o-series mini");
  });

  test("matches Google, DeepSeek and the rest", () => {
    expect(inferPrice("gemini-2.5-pro")?.label).toBe("Gemini Pro");
    expect(inferPrice("gemini-2.0-flash-lite")?.label).toBe("Gemini Flash Lite");
    expect(inferPrice("deepseek-reasoner")?.label).toBe("DeepSeek Reasoner");
    expect(inferPrice("grok-4")?.label).toBe("Grok");
  });

  /* The expensive mistake in the other direction: charging a cheap model at a
     frontier model's rate would exhaust a cap that was never really spent. */
  test("never prices a small model as its large sibling", () => {
    const pairs: Array<[string, string]> = [
      ["claude-3-5-haiku-20241022", "claude-opus-4-20250514"],
      ["gpt-4o-mini", "gpt-4o"],
      ["gemini-2.0-flash-lite", "gemini-2.5-pro"],
      ["grok-3-mini", "grok-4"],
    ];

    for (const [small, large] of pairs) {
      const cheap = inferPrice(small)!;
      const dear = inferPrice(large)!;
      expect(cheap.inPerMTok).toBeLessThan(dear.inPerMTok);
    }
  });

  test("output is priced at or above input, as every vendor prices it", () => {
    for (const id of ["claude-opus-4", "gpt-4o", "gemini-2.5-pro", "deepseek-chat"]) {
      const price = inferPrice(id)!;
      expect(price.outPerMTok).toBeGreaterThanOrEqual(price.inPerMTok);
    }
  });
});

describe("a model nothing is known about", () => {
  /* The distinction the whole feature rests on: unknown is not free. */
  test("returns null rather than zero", () => {
    for (const id of ["some-internal-model", "qwen-72b-custom", "", "my-finetune-v3"]) {
      expect(inferPrice(id)).toBeNull();
    }
  });

  test("and so records no cost, which is what marks a cap unenforceable", () => {
    const price = inferPrice("some-internal-model");
    const cost = estimateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      { priceInPerMTok: price?.inPerMTok, priceOutPerMTok: price?.outPerMTok },
    );
    expect(cost).toBe(0);
  });
});

describe("what a task actually costs", () => {
  test("a priced model produces a real number", () => {
    const price = inferPrice("claude-sonnet-4-5-20250929")!;
    const cost = estimateCost(
      { inputTokens: 2_000_000, outputTokens: 500_000 },
      { priceInPerMTok: price.inPerMTok, priceOutPerMTok: price.outPerMTok },
    );
    /* 2M in at $3 plus 0.5M out at $15. */
    expect(cost).toBeCloseTo(6 + 7.5, 5);
  });

  test("a realistic task lands in cents, not dollars or nothing", () => {
    const price = inferPrice("claude-sonnet-4-5-20250929")!;
    const cost = estimateCost(
      { inputTokens: 6_592, outputTokens: 463 },
      { priceInPerMTok: price.inPerMTok, priceOutPerMTok: price.outPerMTok },
    );
    expect(cost).toBeGreaterThan(0.001);
    expect(cost).toBeLessThan(1);
  });
});
