import { describe, expect, it } from "vitest";

import {
  ask,
  askStream,
  createTenant,
  eventually,
  metricsFor,
  postRun,
  runtimeUrl,
} from "./support/client.ts";

const SECRET_QUESTION = "Is the zebra-umbrella feature in Lumen?";

describe("observability", () => {
  it("counts every request by how it ended, with cost, tokens and timings", async () => {
    const tenant = await createTenant({ limits: { ipPerHour: 4 } });
    await ask(tenant, SECRET_QUESTION);
    await askStream(tenant, "Does Lumen sync?");
    await ask(tenant, "OFFTOPIC joke");
    await ask(tenant, "UPSTREAM500 now");
    await ask(tenant, "one too many");
    await postRun(tenant, "{nope");
    const view = await eventually(
      async () => metricsFor(tenant),
      (metrics) => metrics.totals.requests >= 6,
    );
    expect(view.totals.requests).toBe(6);
    expect(view.totals.counts).toEqual({
      answered: 2,
      guarded: 1,
      limited: 1,
      rejected: 1,
      failed: 1,
    });
    expect(view.totals.costNanoEur).toBe(3 * Math.round((40 * 100 + 25 * 500 + 5000 * 10) / 1.08));
    expect(view.totals.cacheHitRatio).toBeCloseTo(5000 / 5040, 5);
    expect(view.totals.latencyP50).toBeGreaterThan(0);
    expect(view.totals.ttftP50).toBeGreaterThan(0);
    expect(view.outcomes.map((entry) => entry.outcome).sort()).toEqual(
      ["answered", "bad_json", "ip_hour", "off_topic", "upstream"].sort(),
    );
    expect(view.buckets.length).toBeGreaterThan(10);
  });

  it("stores codes and measurements, never what was asked or answered", async () => {
    const tenant = await createTenant();
    await ask(tenant, SECRET_QUESTION);
    const view = await eventually(
      async () => metricsFor(tenant),
      (metrics) => metrics.totals.requests >= 1,
    );
    const stored = JSON.stringify(view);
    expect(stored).not.toContain("zebra");
    expect(stored).not.toContain("Answer to");
    expect(Object.keys(view.recent[0] ?? {}).sort()).toEqual(
      [
        "at",
        "attempts",
        "cacheReadTokens",
        "cacheWriteTokens",
        "costNanoEur",
        "evaluated",
        "inputTokens",
        "latencyMs",
        "model",
        "outcome",
        "outputTokens",
        "requestId",
        "status",
        "streamed",
        "tenant",
        "ttftMs",
      ].sort(),
    );
  });

  it("keeps one tenant's numbers out of another tenant's view", async () => {
    const busy = await createTenant();
    const quiet = await createTenant();
    await ask(busy, "hello");
    await eventually(
      async () => metricsFor(busy),
      (metrics) => metrics.totals.requests >= 1,
    );
    expect((await metricsFor(quiet)).totals.requests).toBe(0);
  });

  it("serves the dashboard page without data and locked down", async () => {
    const response = await fetch(`${runtimeUrl()}/admin`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const page = await response.text();
    expect(page).toContain("Enter the admin token");
    expect(page).toContain("Date & time");
    expect(page).not.toContain("toLocaleTimeString");
    expect(page).not.toContain("Lumen");
  });

  it("refuses metrics without the admin token", async () => {
    const response = await fetch(`${runtimeUrl()}/admin/api/metrics`);
    expect(response.status).toBe(401);
  });
});
