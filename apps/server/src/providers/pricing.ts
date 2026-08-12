/* What a model costs, in USD per million tokens.
 *
 * Prices have to come from somewhere. Most OpenAI-compatible endpoints — and
 * every aggregating proxy this connects to — answer /v1/models with an id and
 * nothing else, so there is no price to read off the wire. Without one, every
 * task records $0, spend never accrues, and a spend cap silently never fires:
 * a setting that promises protection it cannot deliver.
 *
 * So the price is inferred from the model name, exactly as the tier is, and
 * stored on the model row where a human can correct it. The table below is
 * published list pricing for well-known families. It will drift, which is why
 * a correction is `manual` and survives a refresh, and why an unpriced model is
 * reported as unpriced rather than as free.
 *
 * Entries are ordered most-specific first: the first pattern that matches wins,
 * so "claude-haiku" is settled before the generic "claude" fallback is reached. */

export interface ModelPrice {
  /* USD per million tokens. */
  inPerMTok: number;
  outPerMTok: number;
}

interface PriceRule extends ModelPrice {
  /* Matched against the lowercased model id. */
  match: RegExp;
  label: string;
}

/* List prices as published by each vendor. Checked August 2026. */
const RULES: PriceRule[] = [
  /* --- Anthropic --- */
  { match: /claude.*opus.*4|claude-opus-4/, inPerMTok: 15, outPerMTok: 75, label: "Claude Opus 4" },
  { match: /claude.*opus/, inPerMTok: 15, outPerMTok: 75, label: "Claude Opus" },
  { match: /claude.*sonnet/, inPerMTok: 3, outPerMTok: 15, label: "Claude Sonnet" },
  { match: /claude.*haiku.*3-5|claude-3-5-haiku/, inPerMTok: 0.8, outPerMTok: 4, label: "Claude Haiku 3.5" },
  { match: /claude.*haiku/, inPerMTok: 1, outPerMTok: 5, label: "Claude Haiku" },

  /* --- OpenAI --- */
  { match: /^o3-mini|o4-mini/, inPerMTok: 1.1, outPerMTok: 4.4, label: "OpenAI o-series mini" },
  { match: /^o3|^o1-pro/, inPerMTok: 10, outPerMTok: 40, label: "OpenAI o-series" },
  { match: /^o1/, inPerMTok: 15, outPerMTok: 60, label: "OpenAI o1" },
  { match: /gpt-5.*(mini|nano)/, inPerMTok: 0.25, outPerMTok: 2, label: "GPT-5 mini" },
  { match: /gpt-5/, inPerMTok: 1.25, outPerMTok: 10, label: "GPT-5" },
  { match: /gpt-4\.1.*nano/, inPerMTok: 0.1, outPerMTok: 0.4, label: "GPT-4.1 nano" },
  { match: /gpt-4\.1.*mini/, inPerMTok: 0.4, outPerMTok: 1.6, label: "GPT-4.1 mini" },
  { match: /gpt-4\.1/, inPerMTok: 2, outPerMTok: 8, label: "GPT-4.1" },
  { match: /gpt-4o.*mini/, inPerMTok: 0.15, outPerMTok: 0.6, label: "GPT-4o mini" },
  { match: /gpt-4o/, inPerMTok: 2.5, outPerMTok: 10, label: "GPT-4o" },

  /* --- Google --- */
  { match: /gemini.*2\.5.*pro|gemini.*3.*pro/, inPerMTok: 1.25, outPerMTok: 10, label: "Gemini Pro" },
  { match: /gemini.*flash-lite/, inPerMTok: 0.1, outPerMTok: 0.4, label: "Gemini Flash Lite" },
  { match: /gemini.*flash/, inPerMTok: 0.3, outPerMTok: 2.5, label: "Gemini Flash" },
  { match: /gemini.*pro/, inPerMTok: 1.25, outPerMTok: 10, label: "Gemini Pro" },

  /* --- DeepSeek --- */
  { match: /deepseek.*(reasoner|r1)/, inPerMTok: 0.55, outPerMTok: 2.19, label: "DeepSeek Reasoner" },
  { match: /deepseek/, inPerMTok: 0.27, outPerMTok: 1.1, label: "DeepSeek Chat" },

  /* --- Mistral, Meta, xAI --- */
  { match: /mistral.*large/, inPerMTok: 2, outPerMTok: 6, label: "Mistral Large" },
  { match: /mistral|mixtral/, inPerMTok: 0.2, outPerMTok: 0.6, label: "Mistral" },
  { match: /llama.*405b/, inPerMTok: 3.5, outPerMTok: 3.5, label: "Llama 405B" },
  { match: /llama.*70b/, inPerMTok: 0.6, outPerMTok: 0.6, label: "Llama 70B" },
  { match: /llama/, inPerMTok: 0.2, outPerMTok: 0.2, label: "Llama" },
  { match: /grok.*mini/, inPerMTok: 0.3, outPerMTok: 0.5, label: "Grok mini" },
  { match: /grok/, inPerMTok: 3, outPerMTok: 15, label: "Grok" },
];

/* The price for a model id, or null when nothing is known about it.
 *
 * Null is a real answer and not a zero: a model with no price must be reported
 * as unpriced, because showing $0.00 for it would read as free. */
export function inferPrice(modelId: string): (ModelPrice & { label: string }) | null {
  const id = modelId.toLowerCase();

  for (const rule of RULES) {
    if (rule.match.test(id)) {
      return { inPerMTok: rule.inPerMTok, outPerMTok: rule.outPerMTok, label: rule.label };
    }
  }
  return null;
}
