import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import type { BeginInput, Refusal, Replay, SessionRecord } from "./turn";
import { beginTurn, commitTurn, fromLegacy, releaseTurn, renewTurn } from "./turn";

const RECORD_KEY = "record";
const MESSAGE_PREFIX = "message:";
const LEGACY_KEY = "session";
const INDEX_DIGITS = 10;
const KEYS_PER_PUT = 100;
const DEFAULT_READ_LIMIT = 500;
const MAX_READ_LIMIT = 500;

export type Begun =
  | { kind: "started"; history: string[]; pending: string | null; tokensPerChar: number | null }
  | { kind: "replay"; body: string }
  | { kind: "refused"; code: Refusal };

export interface BeginCall extends BeginInput {
  tail: number;
}

export interface LeaseCall {
  leaseId: string;
  now: number;
}

export interface CommitCall extends LeaseCall {
  messages: string[];
  pending: string | null;
  replay: Replay | null;
  tokensPerChar: number | null;
}

export interface ReadOptions {
  limit?: number;
  before?: number;
}

export interface StoredSession {
  owner: string;
  updatedAt: number;
  pending: string | null;
  messages: string[];
  nextBefore: number | null;
}

const messageKey = (index: number): string =>
  `${MESSAGE_PREFIX}${String(index).padStart(INDEX_DIGITS, "0")}`;

const boundedLimit = (limit: number | undefined): number =>
  Math.max(1, Math.min(MAX_READ_LIMIT, limit ?? DEFAULT_READ_LIMIT));

interface WriteBatch {
  record: SessionRecord;
  from: number;
  messages: readonly string[];
}

const writeIn = async (txn: DurableObjectTransaction, batch: WriteBatch): Promise<void> => {
  const entries = batch.messages.map(
    (message, index) => [messageKey(batch.from + index), message] as const,
  );
  const puts: Promise<void>[] = [txn.put(RECORD_KEY, batch.record)];
  for (let start = 0; start < entries.length; start += KEYS_PER_PUT) {
    puts.push(txn.put(Object.fromEntries(entries.slice(start, start + KEYS_PER_PUT))));
  }
  await Promise.all(puts);
};

export class Session extends DurableObject<Env> {
  async begin(input: BeginCall): Promise<Begun> {
    const decision = beginTurn(await this.record(), input);
    if (decision.kind !== "started") {
      return decision;
    }
    await this.ctx.storage.put(RECORD_KEY, decision.record);
    return {
      kind: "started",
      history: await this.messages(input.tail),
      pending: decision.record.pending,
      tokensPerChar: decision.record.tokensPerChar,
    };
  }

  async renew(input: LeaseCall): Promise<boolean> {
    const renewed = renewTurn(await this.record(), input.leaseId, input.now);
    if (renewed !== null) {
      await this.ctx.storage.put(RECORD_KEY, renewed);
    }
    return renewed !== null;
  }

  async commit(input: CommitCall): Promise<boolean> {
    const record = await this.record();
    const committed = commitTurn(record, { ...input, appended: input.messages.length });
    if (committed === null) {
      return false;
    }
    const from = record?.count ?? 0;
    await this.ctx.storage.transaction(async (txn) => {
      await writeIn(txn, { record: committed, from, messages: input.messages });
    });
    return true;
  }

  async release(input: LeaseCall): Promise<void> {
    const released = releaseTurn(await this.record(), input.leaseId);
    if (released.kind === "kept") {
      await this.ctx.storage.put(RECORD_KEY, released.record);
    }
    if (released.kind === "emptied") {
      await this.ctx.storage.deleteAll();
    }
  }

  async read(options: ReadOptions = {}): Promise<StoredSession | null> {
    const record = await this.record();
    if (record === null) {
      return null;
    }
    const limit = boundedLimit(options.limit);
    const end = Math.max(0, Math.min(record.count, options.before ?? record.count));
    const messages = await this.page(end, limit);
    const firstIndex = end - messages.length;
    return {
      owner: record.owner,
      updatedAt: record.updatedAt,
      pending: options.before === undefined ? record.pending : null,
      messages,
      nextBefore: firstIndex > 0 ? firstIndex : null,
    };
  }

  async clear(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  private async record(): Promise<SessionRecord | null> {
    return (await this.ctx.storage.get<SessionRecord>(RECORD_KEY)) ?? this.migrate();
  }

  private async migrate(): Promise<SessionRecord | null> {
    const legacy = await this.ctx.storage.get<string>(LEGACY_KEY);
    const migrated = legacy === undefined ? null : fromLegacy(legacy, Date.now());
    if (migrated === null) {
      return null;
    }
    await this.ctx.storage.transaction(async (txn) => {
      await txn.delete(LEGACY_KEY);
      await writeIn(txn, { record: migrated.record, from: 0, messages: migrated.messages });
    });
    return migrated.record;
  }

  private async messages(limit: number): Promise<string[]> {
    if (limit <= 0) {
      return [];
    }
    const found = await this.ctx.storage.list<string>({
      prefix: MESSAGE_PREFIX,
      reverse: true,
      limit,
    });
    return [...found.values()].reverse();
  }

  private async page(end: number, limit: number): Promise<string[]> {
    if (end <= 0) {
      return [];
    }
    const found = await this.ctx.storage.list<string>({
      prefix: MESSAGE_PREFIX,
      end: messageKey(end),
      reverse: true,
      limit,
    });
    return [...found.values()].reverse();
  }
}
