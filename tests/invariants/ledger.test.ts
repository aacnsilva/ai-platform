import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { LedgerState, RefusalCode } from "../../src/quota/ledger";
import {
  begin,
  emptyState,
  LAPSED_TTL_MS,
  lapsedOf,
  release,
  RESERVATION_TTL_MS,
  reservedNanoEur,
  settle,
  status,
} from "../../src/quota/ledger";

const MONTH_START = Date.UTC(2026, 10, 1);
const NEXT_MONTH = Date.UTC(2026, 11, 1);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LIMITS = { perHour: 3, perDay: 5, poolNanoEur: 1000 };
const TOLERANCE = 0.05;

type Op =
  | { kind: "begin"; wait: number; run: number; reserve: number; ip: number; skip: boolean }
  | { kind: "settle"; wait: number; run: number; factor: number }
  | { kind: "release"; wait: number; run: number }
  | { kind: "status"; wait: number };

interface Open {
  nanoEur: number;
  at: number;
}

interface Model {
  now: number;
  settled: number;
  excess: number;
  open: Map<string, Open>;
  hits: Map<string, number[]>;
}

const waits = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 0, max: 50_000 }) },
  { weight: 3, arbitrary: fc.integer({ min: 60_000, max: 200_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: 30 * 60_000, max: 3 * HOUR }) },
);
const runs = fc.integer({ min: 0, max: 5 });
const reserves = fc.oneof(
  { weight: 9, arbitrary: fc.integer({ min: 1, max: 600 }) },
  { weight: 1, arbitrary: fc.constantFrom(0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY) },
);

const ops = (maxFactor: number): fc.Arbitrary<Op[]> =>
  fc.array(
    fc.oneof(
      fc.record({
        kind: fc.constant("begin" as const),
        wait: waits,
        run: runs,
        reserve: reserves,
        ip: fc.integer({ min: 0, max: 2 }),
        skip: fc.boolean(),
      }),
      fc.record({
        kind: fc.constant("settle" as const),
        wait: waits,
        run: runs,
        factor: fc.double({ min: 0, max: maxFactor, noNaN: true }),
      }),
      fc.record({ kind: fc.constant("release" as const), wait: waits, run: runs }),
      fc.record({ kind: fc.constant("status" as const), wait: waits }),
    ),
    { maxLength: 60 },
  );

const idOf = (run: number): string => `run-${String(run)}`;
const ipOf = (ip: number): string => `10.0.0.${String(ip)}`;
const isLive = (open: Open, now: number): boolean => now - open.at <= RESERVATION_TTL_MS;

const forget = (model: Model): void => {
  for (const [id, open] of model.open) {
    if (model.now - open.at > RESERVATION_TTL_MS + LAPSED_TTL_MS) {
      model.settled += open.nanoEur;
      model.open.delete(id);
    }
  }
};

const sumOf = (model: Model, live: boolean): number =>
  [...model.open.values()]
    .filter((open) => isLive(open, model.now) === live)
    .reduce((sum, open) => sum + open.nanoEur, 0);

const spentOf = (model: Model): number => model.settled + sumOf(model, false);

const recentHits = (model: Model, ip: string, span: number): number =>
  (model.hits.get(ip) ?? []).filter((hit) => hit >= model.now - span).length;

const networkCode = (model: Model, ip: string): RefusalCode | null => {
  if (recentHits(model, ip, HOUR) >= LIMITS.perHour) {
    return "ip_hour";
  }
  return recentHits(model, ip, DAY) >= LIMITS.perDay ? "ip_day" : null;
};

const expectedBegin = (model: Model, op: Op & { kind: "begin" }): RefusalCode | null => {
  const valid = Number.isSafeInteger(op.reserve) && op.reserve > 0;
  if (!valid || model.open.has(idOf(op.run))) {
    return "bad_reserve";
  }
  const network = op.skip ? null : networkCode(model, ipOf(op.ip));
  if (network !== null) {
    return network;
  }
  return spentOf(model) + sumOf(model, true) + op.reserve > LIMITS.poolNanoEur ? "budget" : null;
};

const applyBegin = (state: LedgerState, model: Model, op: Op & { kind: "begin" }): LedgerState => {
  const expected = expectedBegin(model, op);
  const step = begin(state, {
    now: model.now,
    ip: ipOf(op.ip),
    skipNetworkLimit: op.skip,
    reserveNanoEur: op.reserve,
    reservationId: idOf(op.run),
    limits: LIMITS,
  });
  expect(step.result.ok ? null : step.result.error).toBe(expected);
  if (expected === null) {
    model.open.set(idOf(op.run), { nanoEur: op.reserve, at: model.now });
    if (!op.skip) {
      model.hits.set(ipOf(op.ip), [...(model.hits.get(ipOf(op.ip)) ?? []), model.now]);
    }
  }
  return step.state;
};

const applySettle = (
  state: LedgerState,
  model: Model,
  op: Op & { kind: "settle" },
): LedgerState => {
  const open = model.open.get(idOf(op.run));
  const actual = Math.floor((open?.nanoEur ?? 100) * op.factor);
  if (open !== undefined) {
    model.settled += actual;
    model.excess += Math.max(0, actual - open.nanoEur);
    model.open.delete(idOf(op.run));
  }
  const input = { now: model.now, reservationId: idOf(op.run), actualNanoEur: actual };
  const once = settle(state, input).state;
  expect(settle(once, input).state).toEqual(once);
  return once;
};

const applyRelease = (
  state: LedgerState,
  model: Model,
  op: Op & { kind: "release" },
): LedgerState => {
  model.open.delete(idOf(op.run));
  const input = { now: model.now, reservationId: idOf(op.run) };
  const once = release(state, input).state;
  expect(release(once, input).state).toEqual(once);
  return once;
};

const apply = (state: LedgerState, model: Model, op: Op): LedgerState => {
  model.now += op.wait;
  forget(model);
  if (op.kind === "begin") {
    return applyBegin(state, model, op);
  }
  if (op.kind === "settle") {
    return applySettle(state, model, op);
  }
  if (op.kind === "release") {
    return applyRelease(state, model, op);
  }
  return status(state, { now: model.now, limits: LIMITS }).state;
};

const newModel = (): Model => ({
  now: MONTH_START,
  settled: 0,
  excess: 0,
  open: new Map(),
  hits: new Map(),
});

const play = (sequence: readonly Op[], check: (state: LedgerState, model: Model) => void): void => {
  const model = newModel();
  let state = emptyState(MONTH_START);
  for (const op of sequence) {
    state = apply(state, model, op);
    check(state, model);
  }
};

const ids = (state: LedgerState): string[] =>
  [...state.reservations, ...lapsedOf(state)].map((reservation) => reservation.id);

describe("ledger invariants", () => {
  it("matches a plain account of what was reserved, charged and given back", () => {
    fc.assert(
      fc.property(ops(3), (sequence) => {
        play(sequence, (state, model) => {
          expect(state.spentNanoEur).toBe(spentOf(model));
          expect(reservedNanoEur(state)).toBe(sumOf(model, true));
        });
      }),
      { numRuns: 500 },
    );
  });

  it("never holds more than the pool plus what settled runs cost above their reservation", () => {
    fc.assert(
      fc.property(ops(3), (sequence) => {
        play(sequence, (state, model) => {
          const held = state.spentNanoEur + reservedNanoEur(state);
          expect(held).toBeLessThanOrEqual(LIMITS.poolNanoEur + model.excess);
          expect(new Set(ids(state)).size).toBe(ids(state).length);
          expect(Number.isSafeInteger(state.spentNanoEur) && state.spentNanoEur >= 0).toBe(true);
        });
      }),
      { numRuns: 500 },
    );
  });

  it("stays within five percent of the pool when no run costs more than that above its reservation", () => {
    fc.assert(
      fc.property(ops(1 + TOLERANCE), (sequence) => {
        play(sequence, (state) => {
          const held = state.spentNanoEur + reservedNanoEur(state);
          expect(held).toBeLessThanOrEqual(LIMITS.poolNanoEur * (1 + TOLERANCE));
        });
      }),
      { numRuns: 500 },
    );
  });

  it("starts a month with only the reservations still held at that moment, and nothing spent", () => {
    fc.assert(
      fc.property(ops(3), fc.integer({ min: 0, max: 40 * DAY }), (sequence, later) => {
        let last = emptyState(MONTH_START);
        play(sequence, (state) => {
          last = state;
        });
        const now = NEXT_MONTH + later;
        const held = last.reservations
          .filter((reservation) => now - reservation.at <= RESERVATION_TTL_MS)
          .reduce((sum, reservation) => sum + reservation.nanoEur, 0);
        const rolled = status(last, { now, limits: LIMITS }).state;
        expect(rolled.spentNanoEur).toBe(0);
        expect(reservedNanoEur(rolled)).toBe(held);
        expect(lapsedOf(rolled)).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it("never lets a late clock reopen a month that has ended", () => {
    fc.assert(
      fc.property(ops(3), fc.integer({ min: 1, max: 5 * DAY }), (sequence, back) => {
        let last = emptyState(MONTH_START);
        play(sequence, (state) => {
          last = state;
        });
        const december = status(last, { now: NEXT_MONTH + DAY, limits: LIMITS }).state;
        const stale = status(december, { now: NEXT_MONTH - back, limits: LIMITS }).state;
        expect(stale.month).toBe("2026-12");
        expect(stale.spentNanoEur).toBeGreaterThanOrEqual(december.spentNanoEur);
      }),
      { numRuns: 300 },
    );
  });
});
