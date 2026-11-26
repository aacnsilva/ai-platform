import { describe, expect, it } from "vitest";

import { fingerprintOf, readIdempotencyKey, sessionIdFor } from "../src/sessions/idempotency";
import type { BeginInput, SessionRecord } from "../src/sessions/turn";
import {
  beginTurn,
  commitTurn,
  fromLegacy,
  KEPT_KEYS,
  releaseTurn,
  renewTurn,
  TURN_LEASE_MS,
} from "../src/sessions/turn";

const input = (overrides: Partial<BeginInput> = {}): BeginInput => ({
  owner: "ana",
  leaseId: "lease-1",
  now: 1000,
  key: null,
  fingerprint: "f1",
  ...overrides,
});

const started = (
  stored: SessionRecord | null,
  overrides: Partial<BeginInput> = {},
): SessionRecord => {
  const decision = beginTurn(stored, input(overrides));
  if (decision.kind !== "started") {
    throw new Error(`expected the turn to start, got ${decision.kind}`);
  }
  return decision.record;
};

const committed = (record: SessionRecord, key: string | null): SessionRecord => {
  const next = commitTurn(record, {
    leaseId: record.lease?.id ?? "",
    now: 2000,
    appended: 2,
    pending: null,
    replay: key === null ? null : { key, fingerprint: "f1", body: `{"answer":"${key}"}` },
    tokensPerChar: 0.3,
  });
  if (next === null) {
    throw new Error("expected the commit to be accepted");
  }
  return next;
};

describe("turn lock", () => {
  it("lets one turn in and refuses the next until the first commits or lets go", () => {
    const held = started(null);
    expect(beginTurn(held, input({ leaseId: "lease-2" }))).toEqual({
      kind: "refused",
      code: "session_busy",
    });
    const done = committed(held, null);
    expect(done).toMatchObject({ count: 2, lease: null, tokensPerChar: 0.3, updatedAt: 2000 });
    expect(started(done, { leaseId: "lease-2" }).lease?.id).toBe("lease-2");
  });

  it("hides a session from anyone but its owner", () => {
    const done = committed(started(null), null);
    expect(beginTurn(done, input({ owner: "bo" }))).toEqual({ kind: "refused", code: "not_found" });
  });

  it("gives a stuck lock up after the lease runs out, and then refuses the late commit", () => {
    const held = started(null);
    const later = held.lease === null ? 0 : held.lease.expiresAt + 1;
    expect(later).toBe(1000 + TURN_LEASE_MS + 1);
    const taken = started(held, { leaseId: "lease-2", now: later });
    expect(commitTurn(taken, { ...COMMIT, leaseId: "lease-1" })).toBeNull();
    expect(renewTurn(taken, "lease-1", later)).toBeNull();
    expect(renewTurn(taken, "lease-2", later + 5)?.lease?.expiresAt).toBe(
      later + 5 + TURN_LEASE_MS,
    );
  });

  it("leaves nothing behind when a new session's first turn fails, and keeps an existing one", () => {
    expect(releaseTurn(started(null), "lease-1")).toEqual({ kind: "emptied" });
    const second = started(committed(started(null), null), { leaseId: "lease-2" });
    expect(releaseTurn(second, "lease-2")).toMatchObject({
      kind: "kept",
      record: { count: 2, lease: null },
    });
    expect(releaseTurn(second, "someone-else")).toEqual({ kind: "untouched" });
  });
});

const COMMIT = {
  leaseId: "lease-1",
  now: 2000,
  appended: 2,
  pending: null,
  replay: null,
  tokensPerChar: null,
};

describe("idempotency key", () => {
  it("answers a repeated key with the stored reply instead of starting a turn", () => {
    const done = committed(started(null, { key: "k1" }), "k1");
    expect(beginTurn(done, input({ key: "k1", leaseId: "lease-2" }))).toEqual({
      kind: "replay",
      body: '{"answer":"k1"}',
    });
  });

  it("refuses a key that comes back with a different request", () => {
    const done = committed(started(null, { key: "k1" }), "k1");
    expect(beginTurn(done, input({ key: "k1", fingerprint: "other" }))).toEqual({
      kind: "refused",
      code: "idempotency_key_reused",
    });
  });

  it("tells a retry that arrives while the first is still running to come back", () => {
    const held = started(null, { key: "k1" });
    expect(beginTurn(held, input({ key: "k1", leaseId: "lease-2" }))).toEqual({
      kind: "refused",
      code: "session_busy",
    });
  });

  it("remembers earlier keys as spent, up to a bound, and never runs them again", () => {
    let record = committed(started(null, { key: "k0" }), "k0");
    for (let turn = 1; turn <= KEPT_KEYS + 1; turn += 1) {
      record = committed(started(record, { key: `k${String(turn)}` }), `k${String(turn)}`);
    }
    expect(record.spentKeys).toHaveLength(KEPT_KEYS);
    expect(beginTurn(record, input({ key: "k5" }))).toEqual({
      kind: "refused",
      code: "idempotency_key_spent",
    });
    expect(beginTurn(record, input({ key: "fresh" })).kind).toBe("started");
  });

  it("retires the previous key when an unkeyed turn commits after it", () => {
    const first = committed(started(null, { key: "k1" }), "k1");
    const second = committed(started(first, { key: null, leaseId: "lease-2" }), null);
    expect(second.replay).toBeNull();
    expect(second.spentKeys).toContain("k1");
    expect(beginTurn(second, input({ key: "k1", leaseId: "lease-3" }))).toEqual({
      kind: "refused",
      code: "idempotency_key_spent",
    });
  });

  it("accepts visible ASCII up to 128 characters and nothing else", () => {
    expect(readIdempotencyKey(null)).toEqual({ ok: true, key: null });
    expect(readIdempotencyKey(" abc-123 ")).toEqual({ ok: true, key: "abc-123" });
    expect(readIdempotencyKey("")).toEqual({ ok: false });
    expect(readIdempotencyKey("two words")).toEqual({ ok: false });
    expect(readIdempotencyKey("x".repeat(129))).toEqual({ ok: false });
  });

  it("gives a first turn's retry the same session, and another subject a different one", async () => {
    const first = await sessionIdFor("ana", "k1");
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await sessionIdFor("ana", "k1")).toBe(first);
    expect(await sessionIdFor("bo", "k1")).not.toBe(first);
    expect(await fingerprintOf("a")).not.toBe(await fingerprintOf("b"));
  });
});

describe("sessions stored before the log", () => {
  it("become a log of the same messages, still waiting on the client if they were", () => {
    const legacy = JSON.stringify({
      owner: "ana",
      version: 3,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
      pending: { orderedIds: ["t1"], clientIds: ["t1"], serverResults: [], toolRounds: 1 },
      updatedAt: 77,
    });
    const migrated = fromLegacy(legacy, 500);
    expect(migrated?.record).toMatchObject({ owner: "ana", count: 2, updatedAt: 77, lease: null });
    expect(migrated?.messages.map((message) => JSON.parse(message) as unknown)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    expect(JSON.parse(migrated?.record.pending ?? "{}")).toMatchObject({ clientIds: ["t1"] });
    expect(fromLegacy('"not a session"', 500)).toBeNull();
  });
});
