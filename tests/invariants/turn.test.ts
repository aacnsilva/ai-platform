import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { SessionRecord } from "../../src/sessions/turn";
import {
  beginTurn,
  commitTurn,
  KEPT_KEYS,
  releaseTurn,
  renewTurn,
  TURN_LEASE_MS,
} from "../../src/sessions/turn";

type Op =
  | { kind: "begin"; wait: number; owner: string; lease: number; key: string | null; print: string }
  | { kind: "renew"; wait: number; lease: number }
  | { kind: "commit"; wait: number; lease: number; appended: number }
  | { kind: "release"; wait: number; lease: number };

interface World {
  now: number;
  record: SessionRecord | null;
  keys: Map<string, string | null>;
  committed: Set<string>;
  lastCommittedKey: string | null;
  nextLease: number;
}

const waits = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 0, max: 30_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: TURN_LEASE_MS, max: 2 * TURN_LEASE_MS }) },
);
const leases = fc.integer({ min: 0, max: 5 });

const ops = fc.array(
  fc.oneof(
    fc.record({
      kind: fc.constant("begin" as const),
      wait: waits,
      owner: fc.constantFrom("ann", "ann", "ann", "bob"),
      lease: leases,
      key: fc.constantFrom(null, "k0", "k1", "k2", "k3"),
      print: fc.constantFrom("f0", "f1"),
    }),
    fc.record({ kind: fc.constant("renew" as const), wait: waits, lease: leases }),
    fc.record({
      kind: fc.constant("commit" as const),
      wait: waits,
      lease: leases,
      appended: fc.integer({ min: 0, max: 3 }),
    }),
    fc.record({ kind: fc.constant("release" as const), wait: waits, lease: leases }),
  ),
  { maxLength: 80 },
);

const recent = (world: World, back: number): string => `lease-${String(world.nextLease - back)}`;

const isHeld = (world: World): boolean =>
  world.record?.lease !== null &&
  world.record?.lease !== undefined &&
  world.record.lease.expiresAt > world.now;

const begin = (world: World, op: Op & { kind: "begin" }): void => {
  const before = world.record;
  const wasHeld = isHeld(world);
  const leaseId = `lease-${String(world.nextLease)}`;
  const decision = beginTurn(before, {
    owner: op.owner,
    leaseId,
    now: world.now,
    key: op.key,
    fingerprint: op.print,
  });
  if (before !== null && before.owner !== op.owner) {
    expect(decision).toEqual({ kind: "refused", code: "not_found" });
  }
  if (decision.kind === "replay") {
    expect(op.key).toBe(world.lastCommittedKey);
    return;
  }
  if (decision.kind !== "started") {
    return;
  }
  expect(wasHeld).toBe(false);
  expect(op.key === null || !world.committed.has(op.key)).toBe(true);
  world.record = decision.record;
  world.keys.set(leaseId, op.key);
  world.nextLease += 1;
};

const commit = (world: World, op: Op & { kind: "commit" }): void => {
  const leaseId = recent(world, op.lease);
  const key = world.keys.get(leaseId) ?? null;
  const before = world.record;
  const committed = commitTurn(before, {
    leaseId,
    now: world.now,
    appended: op.appended,
    pending: null,
    replay: key === null ? null : { key, fingerprint: "f0", body: leaseId },
    tokensPerChar: null,
  });
  expect(committed !== null).toBe(before?.lease?.id === leaseId);
  if (committed === null) {
    return;
  }
  expect(committed.count).toBe((before?.count ?? 0) + op.appended);
  world.lastCommittedKey = key;
  if (key !== null) {
    world.committed.add(key);
  }
  world.record = committed;
};

const release = (world: World, op: Op & { kind: "release" }): void => {
  const leaseId = recent(world, op.lease);
  const before = world.record;
  const released = releaseTurn(before, leaseId);
  expect(released.kind !== "untouched").toBe(before?.lease?.id === leaseId);
  if (released.kind === "kept") {
    world.record = released.record;
  }
  if (released.kind === "emptied") {
    expect(before?.count).toBe(0);
    world.record = null;
  }
};

const renew = (world: World, op: Op & { kind: "renew" }): void => {
  const leaseId = recent(world, op.lease);
  const renewed = renewTurn(world.record, leaseId, world.now);
  expect(renewed !== null).toBe(world.record?.lease?.id === leaseId);
  world.record = renewed ?? world.record;
};

const apply = (world: World, op: Op): void => {
  world.now += op.wait;
  if (op.kind === "begin") {
    begin(world, op);
  } else if (op.kind === "commit") {
    commit(world, op);
  } else if (op.kind === "release") {
    release(world, op);
  } else {
    renew(world, op);
  }
};

const checkRecord = (record: SessionRecord | null, previous: SessionRecord | null): void => {
  if (record === null) {
    return;
  }
  expect(record.spentKeys.length).toBeLessThanOrEqual(KEPT_KEYS);
  expect(record.spentKeys.includes(record.replay?.key ?? "")).toBe(false);
  if (previous !== null) {
    expect(record.owner).toBe(previous.owner);
    expect(record.count).toBeGreaterThanOrEqual(previous.count);
  }
};

describe("turn invariants", () => {
  it("lets only the lease holder change a session, one turn at a time, one run per key", () => {
    fc.assert(
      fc.property(ops, (sequence) => {
        const world: World = {
          now: 1_000_000,
          record: null,
          keys: new Map(),
          committed: new Set(),
          lastCommittedKey: null,
          nextLease: 6,
        };
        for (const op of sequence) {
          const previous = world.record;
          apply(world, op);
          checkRecord(world.record, previous);
        }
      }),
      { numRuns: 1000 },
    );
  });
});
