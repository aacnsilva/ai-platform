export const TURN_LEASE_MS = 120_000;
export const KEPT_KEYS = 32;

export interface Lease {
  id: string;
  expiresAt: number;
}

export interface Replay {
  key: string;
  fingerprint: string;
  body: string;
}

export interface SessionRecord {
  owner: string;
  count: number;
  pending: string | null;
  lease: Lease | null;
  replay: Replay | null;
  spentKeys: string[];
  tokensPerChar: number | null;
  updatedAt: number;
}

export interface BeginInput {
  owner: string;
  leaseId: string;
  now: number;
  key: string | null;
  fingerprint: string;
}

export type Refusal =
  "not_found" | "session_busy" | "idempotency_key_reused" | "idempotency_key_spent";

export type BeginDecision =
  | { kind: "started"; record: SessionRecord }
  | { kind: "replay"; body: string }
  | { kind: "refused"; code: Refusal };

export const REFUSAL_STATUS: Record<Refusal, number> = {
  not_found: 404,
  session_busy: 409,
  idempotency_key_reused: 422,
  idempotency_key_spent: 409,
};

const newRecord = (owner: string, now: number): SessionRecord => ({
  owner,
  count: 0,
  pending: null,
  lease: null,
  replay: null,
  spentKeys: [],
  tokensPerChar: null,
  updatedAt: now,
});

const isHeld = (record: SessionRecord, now: number): boolean =>
  record.lease !== null && record.lease.expiresAt > now;

const keyDecision = (record: SessionRecord, input: BeginInput): BeginDecision | null => {
  const { replay } = record;
  if (input.key === null) {
    return null;
  }
  if (replay?.key === input.key) {
    return replay.fingerprint === input.fingerprint
      ? { kind: "replay", body: replay.body }
      : { kind: "refused", code: "idempotency_key_reused" };
  }
  return record.spentKeys.includes(input.key)
    ? { kind: "refused", code: "idempotency_key_spent" }
    : null;
};

export const beginTurn = (stored: SessionRecord | null, input: BeginInput): BeginDecision => {
  const record = stored ?? newRecord(input.owner, input.now);
  if (record.owner !== input.owner) {
    return { kind: "refused", code: "not_found" };
  }
  if (isHeld(record, input.now)) {
    return { kind: "refused", code: "session_busy" };
  }
  const lease = { id: input.leaseId, expiresAt: input.now + TURN_LEASE_MS };
  return keyDecision(record, input) ?? { kind: "started", record: { ...record, lease } };
};

const holds = (record: SessionRecord | null, leaseId: string): record is SessionRecord =>
  record?.lease?.id === leaseId;

export const renewTurn = (
  record: SessionRecord | null,
  leaseId: string,
  now: number,
): SessionRecord | null =>
  holds(record, leaseId)
    ? { ...record, lease: { id: leaseId, expiresAt: now + TURN_LEASE_MS } }
    : null;

export interface CommitInput {
  leaseId: string;
  now: number;
  appended: number;
  pending: string | null;
  replay: Replay | null;
  tokensPerChar: number | null;
}

const spentAfter = (record: SessionRecord): string[] =>
  record.replay === null
    ? record.spentKeys
    : [...record.spentKeys, record.replay.key].slice(-KEPT_KEYS);

export const commitTurn = (
  record: SessionRecord | null,
  input: CommitInput,
): SessionRecord | null =>
  holds(record, input.leaseId)
    ? {
        owner: record.owner,
        count: record.count + input.appended,
        pending: input.pending,
        lease: null,
        replay: input.replay,
        spentKeys: spentAfter(record),
        tokensPerChar: input.tokensPerChar ?? record.tokensPerChar,
        updatedAt: input.now,
      }
    : null;

export type Release =
  { kind: "kept"; record: SessionRecord } | { kind: "emptied" } | { kind: "untouched" };

const hasNothing = (record: SessionRecord): boolean =>
  record.count === 0 &&
  record.pending === null &&
  record.replay === null &&
  record.spentKeys.length === 0;

export const releaseTurn = (record: SessionRecord | null, leaseId: string): Release => {
  if (!holds(record, leaseId)) {
    return { kind: "untouched" };
  }
  return hasNothing(record)
    ? { kind: "emptied" }
    : { kind: "kept", record: { ...record, lease: null } };
};

interface LegacyState {
  owner: string;
  messages: unknown[];
  pending: unknown;
  updatedAt: number;
}

const isLegacy = (value: unknown): value is LegacyState =>
  typeof value === "object" &&
  value !== null &&
  "owner" in value &&
  typeof value.owner === "string" &&
  "messages" in value &&
  Array.isArray(value.messages);

export interface Migrated {
  record: SessionRecord;
  messages: string[];
}

export const fromLegacy = (serialized: string, now: number): Migrated | null => {
  const parsed: unknown = JSON.parse(serialized);
  if (!isLegacy(parsed)) {
    return null;
  }
  const pending = parsed.pending ?? null;
  return {
    record: {
      ...newRecord(parsed.owner, typeof parsed.updatedAt === "number" ? parsed.updatedAt : now),
      count: parsed.messages.length,
      pending: pending === null ? null : JSON.stringify(pending),
    },
    messages: parsed.messages.map((message) => JSON.stringify(message)),
  };
};
