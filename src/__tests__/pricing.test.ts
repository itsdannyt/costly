import { describe, it, expect } from "vitest";
import { calculateCost } from "../pricing.js";

describe("calculateCost", () => {
  it("calculates cost for claude-sonnet-4-20250514", () => {
    // $3/M input, $15/M output
    const cost = calculateCost("claude-sonnet-4-20250514", 1_000_000, 1_000_000);
    expect(cost).toBe(18); // $3 + $15
  });

  it("calculates cost for claude-opus-4-20250514", () => {
    // $15/M input, $75/M output
    const cost = calculateCost("claude-opus-4-20250514", 1_000, 500);
    expect(cost).toBeCloseTo(0.015 + 0.0375, 6);
  });

  it("calculates cost for claude-haiku-4-5-20251001", () => {
    // $0.8/M input, $4/M output
    const cost = calculateCost("claude-haiku-4-5-20251001", 10_000, 5_000);
    expect(cost).toBeCloseTo(0.008 + 0.02, 6);
  });

  it("resolves model aliases", () => {
    const aliased = calculateCost("claude-sonnet-4-0", 1_000_000, 0);
    const direct = calculateCost("claude-sonnet-4-20250514", 1_000_000, 0);
    expect(aliased).toBe(direct);
  });

  it("returns 0 for unknown models", () => {
    expect(calculateCost("gpt-4o", 1_000, 1_000)).toBe(0);
  });

  it("returns 0 for zero tokens", () => {
    expect(calculateCost("claude-sonnet-4-20250514", 0, 0)).toBe(0);
  });

  it("rounds to 6 decimal places", () => {
    const cost = calculateCost("claude-3-haiku-20240307", 1, 1);
    const decimals = cost.toString().split(".")[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(6);
  });
});
