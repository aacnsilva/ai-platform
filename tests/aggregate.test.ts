import { describe, expect, it } from "vitest";

import { classify, percentile, summarize } from "../src/observability/aggregate";
import type { RunEvent } from "../src/observability/events";

const MINUTE = 60_000;

const event = (overrides: Partial<RunEvent>): RunEvent => ({
  at: 0,
  tenant: "demo",
  requestId: "r",
  outcome: "answered",
  status: 200,
  streamed: false,
  evaluated: false,
  model: "claude-haiku-5-5",
  attempts: 1,
  latencyMs: 100,
  ttftMs: null,
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 900,
  cacheWriteTokens: 0,
  costNanoEur: 50,
  ...overrides,
});

describe("aggregate", () => {
  it.each([
    ["answered", { outcome: "answered", status: 200 }],
    ["answered", { outcome: "tool_round", status: 200 }],
    ["guarded", { outcome: "off_topic", status: 200 }],
    ["limited", { outcome: "message_cap", status: 429 }],
    ["rejected", { outcome: "bad_token", status: 401 }],
    ["limited", { outcome: "ip_hour", status: 429 }],
    ["rejected", { outcome: "bad_json", status: 400 }],
    ["failed", { outcome: "upstream", status: 502 }],
  ])("classifies as %s", (expected, overrides) => {
    expect(classify(event(overrides))).toBe(expected);
  });

  it("takes percentiles by nearest rank", () => {
    const values = [50, 10, 40, 20, 30];
    expect(percentile(values, 0.5)).toBe(30);
    expect(percentile(values, 0.95)).toBe(50);
    expect(percentile([], 0.5)).toBeNull();
  });

  it("summarizes totals, an unbroken series of buckets, and the outcome breakdown", () => {
    const events = [
      event({ at: 0, latencyMs: 100, ttftMs: 40, streamed: true }),
      event({ at: 10, latencyMs: 300 }),
      event({
        at: 2 * MINUTE,
        outcome: "ip_hour",
        status: 429,
        model: null,
        latencyMs: 2,
        costNanoEur: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
      }),
    ];
    const summary = summarize(events, { since: 0, until: 2 * MINUTE, bucketMs: MINUTE });
    expect(summary.totals).toMatchObject({
      requests: 3,
      counts: { answered: 2, guarded: 0, limited: 1, rejected: 0, failed: 0 },
      costNanoEur: 100,
      cacheHitRatio: 0.9,
      latencyP50: 100,
      latencyP95: 300,
      ttftP50: 40,
    });
    expect(summary.buckets.map((bucket) => bucket.counts.answered)).toEqual([2, 0, 0]);
    expect(summary.buckets.map((bucket) => bucket.counts.limited)).toEqual([0, 0, 1]);
    expect(summary.outcomes).toEqual([
      { outcome: "answered", count: 2 },
      { outcome: "ip_hour", count: 1 },
    ]);
    expect(summary.recent[0]?.outcome).toBe("ip_hour");
  });

  it("leaves latency out of rejected requests so they do not flatter the percentiles", () => {
    const summary = summarize(
      [event({ model: null, latencyMs: 1, status: 400, outcome: "bad_json" })],
      {
        since: 0,
        until: MINUTE,
        bucketMs: MINUTE,
      },
    );
    expect(summary.totals.latencyP50).toBeNull();
  });

  it("aggregates 50,000 events in one bucket in linear time", () => {
    const many = Array.from({ length: 50_000 }, (_, index) =>
      event({ at: 1000 + (index % 1000), latencyMs: 50 + (index % 200) }),
    );
    const startedAt = performance.now();
    const summary = summarize(many, { since: 0, until: MINUTE, bucketMs: MINUTE });
    const elapsedMs = performance.now() - startedAt;
    expect(summary.totals.requests).toBe(50_000);
    expect(summary.recent).toHaveLength(50);
    expect(elapsedMs).toBeLessThan(1000);
  });
});
