import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { DeviceState } from "../../src/authn/device";
import {
  bumpCounter,
  CHALLENGE_TTL_MS,
  emptyDevice,
  putChallenge,
  putDevice,
  takeChallenge,
} from "../../src/authn/device";
import type { BreakerState } from "../../src/llm/breaker";
import {
  FAILURES_TO_OPEN,
  isOpen,
  OPEN_MS,
  orderCandidates,
  recordFailure,
  recordSuccess,
} from "../../src/llm/breaker";
import type { Candidates, ModelId } from "../../src/llm/catalog";
import { candidatesFor, MODELS } from "../../src/llm/catalog";
import type { Usage } from "../../src/llm/cost";
import { costNanoEur, reserveNanoEur, worstCaseUsage } from "../../src/llm/cost";
import type { Counting, QuotaState } from "../../src/quota/subject";
import { beginQuota, emptyQuota, refundQuota, usedThisMonth } from "../../src/quota/subject";

const MONTH_START = Date.UTC(2026, 10, 1);
const MODEL_IDS = Object.keys(MODELS).filter((id): id is ModelId => id in MODELS);
const countings = fc.constantFrom<Counting>("first_round_free", "every_call", "questions_only");

const quotaCalls = fc.array(
  fc.record({
    wait: fc.integer({ min: 0, max: 20 * 24 * 60 * 60 * 1000 }),
    toolRounds: fc.integer({ min: 0, max: 3 }),
    counting: countings,
    refund: fc.boolean(),
  }),
  { maxLength: 60 },
);

describe("message quota invariants", () => {
  it("never counts past the limit, and a refund puts back exactly what was taken", () => {
    fc.assert(
      fc.property(quotaCalls, fc.integer({ min: 0, max: 6 }), (calls, limit) => {
        let state: QuotaState = emptyQuota();
        let now = MONTH_START;
        for (const call of calls) {
          now += call.wait;
          const before = { month: "", count: usedThisMonth(state, now), free: state.free };
          const step = beginQuota(state, { now, limit, ...call });
          state = step.state;
          expect(state.count).toBeLessThanOrEqual(limit);
          expect(state.count).toBeGreaterThanOrEqual(before.count);
          if (step.result.ok && call.refund) {
            const refunded = refundQuota(state, { now, ...step.result }).state;
            expect(refunded.count).toBe(before.count);
            state = refunded;
          }
          expect(state.free).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 500 },
    );
  });
});

const usages = fc.record({
  promptChars: fc.integer({ min: 0, max: 2_000_000 }),
  maxOutputTokens: fc.integer({ min: 0, max: 64_000 }),
  cut: fc.tuple(
    fc.double({ min: 0, max: 1, noNaN: true }),
    fc.double({ min: 0, max: 1, noNaN: true }),
  ),
  share: fc.double({ min: 0, max: 1, noNaN: true }),
  usdPerEur: fc.double({ min: 0.5, max: 2, noNaN: true }),
});

describe("reservation price", () => {
  it("covers any real usage that stays within the estimated tokens, on every candidate model", () => {
    fc.assert(
      fc.property(usages, fc.constantFrom("fast" as const, "balanced" as const), (drawn, tier) => {
        const worst = worstCaseUsage(drawn);
        const prompt = Math.floor(worst.input * drawn.share);
        const cacheWrite = Math.floor(prompt * Math.min(...drawn.cut));
        const cacheRead = Math.floor((prompt - cacheWrite) * Math.max(...drawn.cut));
        const usage: Usage = {
          input: prompt - cacheWrite - cacheRead,
          cacheWrite,
          cacheRead,
          output: Math.floor(drawn.maxOutputTokens * drawn.share),
        };
        const reserved = reserveNanoEur(drawn, candidatesFor(tier), drawn.usdPerEur);
        for (const model of candidatesFor(tier)) {
          const cost = costNanoEur(usage, { model, usdPerEur: drawn.usdPerEur });
          expect(cost).toBeLessThanOrEqual(reserved);
        }
      }),
      { numRuns: 2000 },
    );
  });
});

const breakerEvents = fc.array(
  fc.record({
    wait: fc.integer({ min: 0, max: 40_000 }),
    model: fc.constantFrom(...MODEL_IDS),
    failed: fc.boolean(),
  }),
  { maxLength: 60 },
);

describe("breaker invariants", () => {
  it("always offers a model, keeps the configured order, and skips open ones when it can", () => {
    const candidates: Candidates = candidatesFor("balanced");
    fc.assert(
      fc.property(breakerEvents, (events) => {
        let state: BreakerState = {};
        let now = 0;
        for (const event of events) {
          now += event.wait;
          state = event.failed
            ? recordFailure(state, event.model, now)
            : recordSuccess(state, event.model);
          const offered = orderCandidates(state, candidates, now);
          const closed = candidates.filter((model) => !isOpen(state, model, now));
          expect(offered).toEqual(closed.length === 0 ? [candidates[0]] : closed);
          expect(state[event.model]?.failures.length ?? 0).toBeLessThanOrEqual(FAILURES_TO_OPEN);
          expect(event.failed || !isOpen(state, event.model, now)).toBe(true);
          expect(isOpen(state, event.model, now + OPEN_MS)).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });
});

const deviceEvents = fc.array(
  fc.oneof(
    fc.record({
      kind: fc.constant("challenge" as const),
      wait: fc.integer({ min: 0, max: 400_000 }),
    }),
    fc.record({ kind: fc.constant("take" as const), wait: fc.integer({ min: 0, max: 400_000 }) }),
    fc.record({ kind: fc.constant("attest" as const), wait: fc.constant(0) }),
    fc.record({
      kind: fc.constant("assert" as const),
      wait: fc.constant(0),
      counter: fc.oneof(fc.integer({ min: -2, max: 20 }), fc.constantFrom(1.5, Number.NaN)),
    }),
  ),
  { maxLength: 60 },
);

interface DeviceWorld {
  state: DeviceState;
  now: number;
  issuedAt: number | null;
  serial: number;
}

const takeOnce = (world: DeviceWorld): void => {
  const taken = takeChallenge(world.state, world.now);
  const usable = world.issuedAt !== null && world.now - world.issuedAt < CHALLENGE_TTL_MS;
  expect(taken.result).toBe(usable ? `nonce-${String(world.serial)}` : null);
  expect(takeChallenge(taken.state, world.now).result).toBeNull();
  world.state = taken.state;
  world.issuedAt = null;
};

describe("device invariants", () => {
  it("hands out a challenge once and only accepts a counter that grows", () => {
    fc.assert(
      fc.property(deviceEvents, (events) => {
        const world: DeviceWorld = { state: emptyDevice(), now: 0, issuedAt: null, serial: 0 };
        for (const event of events) {
          world.now += event.wait;
          if (event.kind === "challenge") {
            world.serial += 1;
            world.issuedAt = world.now;
            world.state = putChallenge(world.state, `nonce-${String(world.serial)}`, world.now);
          } else if (event.kind === "take") {
            takeOnce(world);
          } else if (event.kind === "attest") {
            world.state = putDevice(world.state, { x: "x", y: "y" }, "production");
            world.issuedAt = null;
          } else {
            const before = world.state.counter;
            const bumped = bumpCounter(world.state, event.counter);
            expect(bumped.result).toBe(
              world.state.publicKey !== null &&
                Number.isInteger(event.counter) &&
                event.counter > before,
            );
            expect(bumped.state.counter).toBeGreaterThanOrEqual(before);
            world.state = bumped.state;
          }
        }
      }),
      { numRuns: 500 },
    );
  });
});
