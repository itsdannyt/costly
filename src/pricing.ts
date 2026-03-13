// Anthropic pricing per million tokens (as of March 2026)
// Source: https://docs.anthropic.com/en/docs/about-claude/models

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Claude 4.x family
  "claude-opus-4-20250514": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-sonnet-4-20250514": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-4-5-20251001": { inputPerMillion: 0.8, outputPerMillion: 4 },

  // Claude 3.5 family (deprecated but still in use)
  "claude-3-5-sonnet-20241022": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-3-5-sonnet-20240620": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-3-5-haiku-20241022": { inputPerMillion: 0.8, outputPerMillion: 4 },

  // Claude 3 family (deprecated)
  "claude-3-opus-20240229": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-3-sonnet-20240229": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-3-haiku-20240307": { inputPerMillion: 0.25, outputPerMillion: 1.25 },
};

// Model alias resolution
const ALIASES: Record<string, string> = {
  "claude-opus-4-0": "claude-opus-4-20250514",
  "claude-sonnet-4-0": "claude-sonnet-4-20250514",
  "claude-haiku-4-5-latest": "claude-haiku-4-5-20251001",
  "claude-3-5-sonnet-latest": "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-latest": "claude-3-5-haiku-20241022",
  "claude-3-opus-latest": "claude-3-opus-20240229",
  "claude-3-sonnet-latest": "claude-3-sonnet-20240229",
  "claude-3-haiku-latest": "claude-3-haiku-20240307",
};

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const resolvedModel = ALIASES[model] || model;
  const pricing = PRICING[resolvedModel];

  if (!pricing) {
    // Unknown model — return 0 rather than crashing the user's app
    return 0;
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;

  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // 6 decimal places
}
