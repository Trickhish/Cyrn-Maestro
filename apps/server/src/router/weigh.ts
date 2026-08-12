/* Estimating how heavy a task is, from the only thing available before it runs:
 * what the user typed.
 *
 * This is a heuristic and is treated as one. It picks a starting tier, the user
 * can override it, and the decision is shown before dispatch rather than
 * explained afterwards — which is what makes a wrong guess cheap. Presenting a
 * guess as a fact is the failure mode to avoid, not the guess itself. */

export type Tier = "light" | "standard" | "heavy";

export interface Weight {
  tier: Tier;
  /* The phrase shown in the routing chip and recorded in the decision. */
  because: string;
}

/* Work that is mechanical: the shape of the change is known from the sentence,
   and a smaller model does it as well as a larger one. */
const LIGHT_SIGNALS = [
  /\brenam(e|ing)\b/i,
  /\bformat(ting)?\b/i,
  /\blint\b/i,
  /\btypo\b/i,
  /\bcomment(s)?\b/i,
  /\bbump\b.*\bversion\b/i,
  /\badd\b.*\b(log|logging)\b/i,
  /^\s*(run|execute)\b/i,
  /\bsummar(y|ise|ize)\b/i,
];

/* Work where the difficulty is in deciding what to do, not doing it. */
const HEAVY_SIGNALS = [
  /\brefactor\b/i,
  /\barchitect(ure)?\b/i,
  /\bredesign\b/i,
  /\bmigrat(e|ion)\b/i,
  /\bdebug\b/i,
  /\bwhy\b.*\b(fail|break|crash|wrong)/i,
  /\bflaky\b/i,
  /\brace condition\b/i,
  /\bperformance\b/i,
  /\bsecurity\b/i,
  /\bdesign\b.*\b(system|schema|api)\b/i,
  /\bacross\b.*\bfiles\b/i,
];

/* A prompt long enough to describe several requirements is rarely a one-liner
   of work, whatever words it uses. */
const LONG_PROMPT_WORDS = 120;

/* A mechanical change is one instruction. "Rename this, then update every
   import, and make sure CI passes" is three, and the word "rename" at the front
   says nothing about the size of the other two. */
const SHORT_ENOUGH_TO_BE_MECHANICAL = 25;

function instructionCount(text: string): number {
  const separators = text.match(/\b(then|also|after that|and then)\b|;/gi) ?? [];
  return separators.length + 1;
}

export function weighTask(prompt: string): Weight {
  const text = prompt.trim();
  const words = text.split(/\s+/).length;

  const heavy = HEAVY_SIGNALS.find((pattern) => pattern.test(text));
  if (heavy) {
    return { tier: "heavy", because: "the task describes work with an unclear shape" };
  }

  if (words >= LONG_PROMPT_WORDS) {
    return { tier: "heavy", because: "the request is long enough to carry several requirements" };
  }

  const light = LIGHT_SIGNALS.find((pattern) => pattern.test(text));
  if (light && words < SHORT_ENOUGH_TO_BE_MECHANICAL && instructionCount(text) === 1) {
    return { tier: "light", because: "the change looks mechanical" };
  }

  return { tier: "standard", because: "ordinary feature work" };
}

/* Which tiers may serve a request for a given tier, best first.
 *
 * Falling back to a larger model is acceptable — it costs more but does the
 * job. Falling back to a smaller one is not: a heavy task on a light model
 * produces a confident, wrong answer, which is worse than an honest failure. */
export function acceptableTiers(wanted: Tier): Tier[] {
  switch (wanted) {
    case "light":
      return ["light", "standard", "heavy"];
    case "standard":
      return ["standard", "heavy"];
    case "heavy":
      return ["heavy"];
  }
}

/* Model ids do not carry their tier, so it is inferred from the name and
   stored on the model row, where a human can correct it.
 *
 * Tokens are anchored to hyphen or string boundaries rather than matched as
 * substrings. Unanchored, "mini" matches "ge-MINI-ni" and quietly routes heavy
 * work to a small model — a wrong answer delivered confidently, which is the
 * expensive failure here. Heavy is checked first so a name carrying both
 * signals resolves upward. */
function hasToken(id: string, token: string): boolean {
  return new RegExp(`(^|[-_.])${token}([-_.]|$)`).test(id);
}

const HEAVY_TOKENS = ["opus", "ultra", "thinking", "agent", "405b", "70b", "max"];
const LIGHT_TOKENS = ["haiku", "mini", "nano", "lite", "small", "8b", "instant", "low"];

export function inferTier(modelId: string): Tier {
  const id = modelId.toLowerCase();

  if (HEAVY_TOKENS.some((token) => hasToken(id, token))) return "heavy";
  /* Compound suffixes that carry the signal without standing alone. */
  if (/(flash-lite|extra-low|-low$|-lite$)/.test(id)) return "light";
  if (LIGHT_TOKENS.some((token) => hasToken(id, token))) return "light";

  return "standard";
}
