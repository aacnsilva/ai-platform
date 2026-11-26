import { beforeAll, describe, expect, it } from "vitest";

import {
  ask,
  askStream,
  createTenant,
  postRun,
  providerCalls,
  runtimeUrl,
} from "./support/client.ts";

const SAMPLES = 15;
const MOCK_FIRST_TOKEN_MS = 30;

const median = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

const timed = async (work: () => Promise<unknown>): Promise<number> => {
  const startedAt = performance.now();
  await work();
  return performance.now() - startedAt;
};

const sample = async (work: () => Promise<unknown>): Promise<number> => {
  const durations: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    durations.push(await timed(work));
  }
  return median(durations);
};

describe("performance budgets (local worker, fake provider)", () => {
  let tenant = "";

  beforeAll(async () => {
    tenant = await createTenant({ limits: { ipPerHour: 1000, ipPerDay: 5000 } });
    await ask(tenant, "warm up");
  });

  it("rejects a bad request in under 25 ms at the median", async () => {
    const medianMs = await sample(async () => (await postRun(tenant, "{nope")).text());
    expect(medianMs).toBeLessThan(25);
  });

  it("adds under 60 ms to a complete answer at the median", async () => {
    const medianMs = await sample(async () => (await ask(tenant, "PERFPROBE export?")).text());
    const provider = (await providerCalls()).filter((call) => call.question.includes("PERFPROBE"));
    expect(provider).toHaveLength(SAMPLES);
    expect(medianMs - median(provider.map((call) => call.tookMs))).toBeLessThan(60);
  });

  it("answers status reads in under 20 ms at the median", async () => {
    const url = `${runtimeUrl()}/v1/tenants/${tenant}/status`;
    const medianMs = await sample(async () => (await fetch(url)).text());
    expect(medianMs).toBeLessThan(20);
  });

  it("delivers the first streamed text within 60 ms of the provider's first token", async () => {
    const firsts: number[] = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      const events = await askStream(tenant, "Does it sync?");
      firsts.push(events.find((event) => event.type === "delta")?.atMs ?? Number.NaN);
    }
    expect(median(firsts) - MOCK_FIRST_TOKEN_MS).toBeLessThan(60);
  });
});
