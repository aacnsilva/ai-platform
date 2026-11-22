import { describe, expect, it } from "vitest";

import { costNanoEur, euroToNano, reserveNanoEur } from "../src/llm/cost";

const usage = { input: 50_000, output: 0, cacheWrite: 0, cacheRead: 0 };

describe("cost", () => {
  it("prices input tokens at the model's dollar price, in euros", () => {
    expect(costNanoEur(usage, { model: "claude-haiku-5-5", usdPerEur: 1 })).toBe(5_000_000);
    expect(costNanoEur(usage, { model: "claude-haiku-5-5", usdPerEur: 1.25 })).toBe(4_000_000);
    expect(costNanoEur(usage, { model: "claude-sonnet-5-5", usdPerEur: 1 })).toBe(100_000_000);
  });

  it("prices cached tokens far below fresh ones", () => {
    const cached = { input: 0, output: 0, cacheWrite: 0, cacheRead: 50_000 };
    expect(costNanoEur(cached, { model: "claude-haiku-5-5", usdPerEur: 1 })).toBe(500_000);
  });

  it("applies the long-prompt price once the prompt passes 100,000 tokens", () => {
    const long = { input: 100_001, output: 0, cacheWrite: 0, cacheRead: 0 };
    expect(costNanoEur(long, { model: "claude-haiku-5-5", usdPerEur: 1 })).toBe(5 * 100_001 * 100);
    expect(costNanoEur(long, { model: "claude-sonnet-5-5", usdPerEur: 1 })).toBe(100_001 * 2000);
  });

  it("reserves for the most expensive model the router might use, with the prompt at the cache-write price", () => {
    const input = { promptChars: 3000, maxOutputTokens: 1000 };
    const fast = reserveNanoEur(input, ["claude-haiku-5-5"], 1);
    const mixed = reserveNanoEur(input, ["claude-haiku-5-5", "claude-sonnet-5-5"], 1);
    expect(fast).toBe(1600 * 125 + 1000 * 500);
    expect(mixed).toBe(1600 * 2500 + 1000 * 10_000);
  });

  it("converts euros to whole nano-euros", () => {
    expect(euroToNano(0.000001)).toBe(1000);
  });
});
