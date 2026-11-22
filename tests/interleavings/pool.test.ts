import { describe, expect, it } from "vitest";

import type { LedgerState } from "../../src/quota/ledger";
import {
  begin,
  emptyState,
  LAPSED_TTL_MS,
  release,
  RESERVATION_TTL_MS,
  settle,
  status,
} from "../../src/quota/ledger";
import type { Actor } from "../support/interleave";
import { explore } from "../support/interleave";

const MONTH_START = Date.UTC(2026, 10, 1);
const LIMITS = { perHour: 100, perDay: 100, poolNanoEur: 1000 };
const TOLERANCE = 0.05;

interface Plan {
  reserve: number;
  actual: number;
  ending: "settle" | "release" | "settle_twice";
}

interface Run {
  admittedAt: number | null;
  charge: number | null;
}

interface World {
  now: number;
  state: LedgerState;
  runs: Record<string, Run>;
}

const runOf = (world: World, name: string): Run =>
  world.runs[name] ?? { admittedAt: null, charge: null };

const withRun = (world: World, name: string, run: Run): World => ({
  ...world,
  runs: { ...world.runs, [name]: run },
});

const reserveStep =
  (name: string, plan: Plan) =>
  (world: World): World => {
    const step = begin(world.state, {
      now: world.now,
      ip: name,
      skipNetworkLimit: true,
      reserveNanoEur: plan.reserve,
      reservationId: name,
      limits: LIMITS,
    });
    const run = { admittedAt: step.result.ok ? world.now : null, charge: null };
    return withRun({ ...world, state: step.state }, name, run);
  };

const isForgotten = (world: World, admittedAt: number): boolean =>
  world.now - admittedAt > RESERVATION_TTL_MS + LAPSED_TTL_MS;

const closeStep =
  (name: string, plan: Plan) =>
  (world: World): World => {
    const run = runOf(world, name);
    if (run.admittedAt === null) {
      return world;
    }
    const closing = { now: world.now, reservationId: name };
    const state =
      plan.ending === "release"
        ? release(world.state, closing).state
        : settle(world.state, { ...closing, actualNanoEur: plan.actual }).state;
    const owed = plan.ending === "release" ? 0 : plan.actual;
    const charge = run.charge ?? (isForgotten(world, run.admittedAt) ? plan.reserve : owed);
    return withRun({ ...world, state }, name, { ...run, charge });
  };

const runActor = (name: string, plan: Plan): Actor<World> => ({
  name,
  mayStop: true,
  steps: [
    reserveStep(name, plan),
    closeStep(name, plan),
    ...(plan.ending === "settle_twice" ? [closeStep(name, plan)] : []),
  ],
});

const clock = (waits: readonly number[]): Actor<World> => ({
  name: "clock",
  mayStop: false,
  steps: waits.map((wait) => (world: World): World => ({ ...world, now: world.now + wait })),
});

const owedBy = (world: World, plans: Record<string, Plan>): { spent: number; reserved: number } => {
  let spent = 0;
  let reserved = 0;
  for (const [name, plan] of Object.entries(plans)) {
    const run = runOf(world, name);
    const open = run.admittedAt !== null && run.charge === null;
    const lapsed = open && world.now - (run.admittedAt ?? 0) > RESERVATION_TTL_MS;
    spent += run.charge ?? (lapsed ? plan.reserve : 0);
    reserved += open && !lapsed ? plan.reserve : 0;
  }
  return { spent, reserved };
};

const exploreAll = (plans: Record<string, Plan>, waits: readonly number[]): number => {
  const actors = [
    ...Object.entries(plans).map(([name, plan]) => runActor(name, plan)),
    clock(waits),
  ];
  const start: World = { now: MONTH_START, state: emptyState(MONTH_START), runs: {} };
  return explore(start, actors, ({ world, trace }) => {
    const pool = status(world.state, { now: world.now, limits: LIMITS }).result;
    const owed = owedBy(world, plans);
    const seen = { spent: pool.spentNanoEur, reserved: pool.reservedNanoEur };
    expect(seen, trace.join(" ")).toEqual(owed);
    expect(seen.spent + seen.reserved, trace.join(" ")).toBeLessThanOrEqual(
      LIMITS.poolNanoEur * (1 + TOLERANCE),
    );
  });
};

describe("pool under every ordering of runs, crashes, retries and lapsed reservations", () => {
  it("charges each run once and stays within five percent of the pool", () => {
    const finished = exploreAll(
      {
        dear: { reserve: 400, actual: 420, ending: "settle" },
        cheap: { reserve: 400, actual: 100, ending: "settle_twice" },
        late: { reserve: 300, actual: 315, ending: "settle" },
      },
      [RESERVATION_TTL_MS + 1, RESERVATION_TTL_MS + 1],
    );
    expect(finished).toBeGreaterThan(1000);
  });

  it("gives a released run back even after it lapsed, and keeps the charge once it is forgotten", () => {
    const finished = exploreAll(
      {
        failed: { reserve: 600, actual: 0, ending: "release" },
        slow: { reserve: 400, actual: 380, ending: "settle" },
        other: { reserve: 300, actual: 10, ending: "settle" },
      },
      [RESERVATION_TTL_MS + 1, LAPSED_TTL_MS],
    );
    expect(finished).toBeGreaterThan(1000);
  });
});
