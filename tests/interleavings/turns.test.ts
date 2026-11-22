import { describe, expect, it } from "vitest";

import type { SessionRecord } from "../../src/sessions/turn";
import { beginTurn, commitTurn, releaseTurn, TURN_LEASE_MS } from "../../src/sessions/turn";
import type { Actor } from "../support/interleave";
import { explore } from "../support/interleave";

interface Plan {
  owner: string;
  key: string | null;
  print: string;
  ending: "commit" | "release";
}

interface World {
  now: number;
  record: SessionRecord | null;
  log: readonly string[];
  started: readonly string[];
  commits: readonly string[];
  replays: Record<string, string>;
  refusals: Record<string, string>;
}

const START: World = {
  now: 1_000_000,
  record: null,
  log: [],
  started: [],
  commits: [],
  replays: {},
  refusals: {},
};

const beginStep =
  (name: string, plan: Plan) =>
  (world: World): World => {
    const decision = beginTurn(world.record, {
      owner: plan.owner,
      leaseId: name,
      now: world.now,
      key: plan.key,
      fingerprint: plan.print,
    });
    if (decision.kind === "started") {
      return { ...world, record: decision.record, started: [...world.started, name] };
    }
    if (decision.kind === "replay") {
      return { ...world, replays: { ...world.replays, [name]: decision.body } };
    }
    return { ...world, refusals: { ...world.refusals, [name]: decision.code } };
  };

const written = (log: readonly string[], at: number, message: string): string[] => {
  const next = [...log];
  next[at] = message;
  return next;
};

const commitStep =
  (name: string, plan: Plan) =>
  (world: World): World => {
    if (!world.started.includes(name)) {
      return world;
    }
    const committed = commitTurn(world.record, {
      leaseId: name,
      now: world.now,
      appended: 1,
      pending: null,
      replay: plan.key === null ? null : { key: plan.key, fingerprint: plan.print, body: name },
      tokensPerChar: null,
    });
    if (committed === null) {
      return world;
    }
    return {
      ...world,
      record: committed,
      log: written(world.log, world.record?.count ?? 0, name),
      commits: [...world.commits, name],
    };
  };

const releaseStep =
  (name: string) =>
  (world: World): World => {
    if (!world.started.includes(name)) {
      return world;
    }
    const released = releaseTurn(world.record, name);
    if (released.kind === "kept") {
      return { ...world, record: released.record };
    }
    return released.kind === "emptied" ? { ...world, record: null, log: [] } : world;
  };

const requestActor = (name: string, plan: Plan): Actor<World> => ({
  name,
  mayStop: true,
  steps: [
    beginStep(name, plan),
    plan.ending === "commit" ? commitStep(name, plan) : releaseStep(name),
  ],
});

const clock: Actor<World> = {
  name: "clock",
  mayStop: false,
  steps: [1, 2].map(() => (world: World): World => ({
    ...world,
    now: world.now + TURN_LEASE_MS + 1,
  })),
};

const check = (world: World, plans: Record<string, Plan>, trace: string): void => {
  expect(world.log, trace).toEqual(world.commits);
  expect(world.record?.count ?? 0, trace).toBe(world.commits.length);
  const keys = world.commits.map((name) => plans[name]?.key ?? null).filter((key) => key !== null);
  expect(new Set(keys).size, trace).toBe(keys.length);
  const owners = new Set(world.commits.map((name) => plans[name]?.owner));
  expect(owners.size, trace).toBeLessThanOrEqual(1);
  for (const [name, body] of Object.entries(world.replays)) {
    expect(plans[body]?.key, trace).toBe(plans[name]?.key);
    expect(plans[body]?.print, trace).toBe(plans[name]?.print);
    expect(world.commits, trace).toContain(body);
  }
};

const exploreAll = (plans: Record<string, Plan>): World[] => {
  const actors = [...Object.entries(plans).map(([name, plan]) => requestActor(name, plan)), clock];
  const ends: World[] = [];
  explore(START, actors, ({ world, trace, finished }) => {
    check(world, plans, trace.join(" "));
    if (finished) {
      ends.push(world);
    }
  });
  return ends;
};

describe("a session under every ordering of requests, retries, crashes and expired leases", () => {
  it("runs a retried key at most once and never loses or overwrites a committed turn", () => {
    const ends = exploreAll({
      first: { owner: "ann", key: "k", print: "p", ending: "commit" },
      retry: { owner: "ann", key: "k", print: "p", ending: "commit" },
      failed: { owner: "ann", key: null, print: "q", ending: "release" },
    });
    expect(ends.length).toBeGreaterThan(500);
    expect(ends.some((world) => world.replays["retry"] === "first")).toBe(true);
    expect(ends.some((world) => world.refusals["retry"] === "session_busy")).toBe(true);
  });

  it("refuses a key reused for another body and keeps another owner out of a session with turns", () => {
    const plans: Record<string, Plan> = {
      first: { owner: "ann", key: "k", print: "p", ending: "commit" },
      other: { owner: "ann", key: "k", print: "changed", ending: "commit" },
      stranger: { owner: "bob", key: null, print: "p", ending: "commit" },
    };
    const ends = exploreAll(plans);
    expect(ends.length).toBeGreaterThan(500);
    expect(ends.some((world) => world.refusals["other"] === "idempotency_key_reused")).toBe(true);
    expect(ends.some((world) => world.refusals["stranger"] === "not_found")).toBe(true);
  });
});
