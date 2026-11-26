import type { Begun, SessionPort, TurnCommit } from "../agent/session-run";
import type { Env } from "../env";
import type { ModelMessage } from "../llm/provider";
import type { Pending } from "./session";
import type { Begun as StoredBegun, ReadOptions, Session } from "./session-object";
import { REFUSAL_STATUS } from "./turn";

export interface TurnIdentity {
  owner: string;
  key: string | null;
  fingerprint: string;
  tail: number;
}

export interface SessionView {
  owner: string;
  updatedAt: number;
  awaitingToolResults: boolean;
  messages: ModelMessage[];
  nextBefore: number | null;
}

export const sessionStub = (
  env: Env,
  tenantId: string,
  sessionId: string,
): DurableObjectStub<Session> =>
  env.SESSION.get(env.SESSION.idFromName(`session:${tenantId}:${sessionId}`));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const messageOf = (serialized: string): ModelMessage => JSON.parse(serialized) as ModelMessage;

const pendingOf = (serialized: string | null): Pending | null => {
  if (serialized === null) {
    return null;
  }
  const parsed = JSON.parse(serialized) as Omit<Pending, "messages"> & {
    messages?: ModelMessage[];
  };
  return { ...parsed, messages: parsed.messages ?? [] };
};

const bodyOf = (serialized: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(serialized);
  return isRecord(parsed) ? parsed : {};
};

const begunOf = (stored: StoredBegun): Begun => {
  if (stored.kind === "refused") {
    return { kind: "refused", status: REFUSAL_STATUS[stored.code], code: stored.code };
  }
  if (stored.kind === "replay") {
    return { kind: "replay", body: bodyOf(stored.body) };
  }
  return {
    kind: "started",
    history: stored.history.map(messageOf),
    pending: pendingOf(stored.pending),
    tokensPerChar: stored.tokensPerChar,
  };
};

export const readSession = async (
  stub: DurableObjectStub<Session>,
  options?: ReadOptions,
): Promise<SessionView | null> => {
  const stored = await stub.read(options);
  if (stored === null) {
    return null;
  }
  const pending = pendingOf(stored.pending);
  return {
    owner: stored.owner,
    updatedAt: stored.updatedAt,
    awaitingToolResults: pending !== null,
    messages: [...stored.messages.map(messageOf), ...(pending?.messages ?? [])],
    nextBefore: stored.nextBefore,
  };
};

export const sessionPort = (
  stub: DurableObjectStub<Session>,
  identity: TurnIdentity,
): SessionPort => {
  const leaseId = crypto.randomUUID();
  const { key, fingerprint } = identity;
  let held = false;
  const commit = async (turn: TurnCommit): Promise<boolean> => {
    const saved = await stub.commit({
      leaseId,
      now: Date.now(),
      messages: turn.append.map((message) => JSON.stringify(message)),
      pending: turn.pending === null ? null : JSON.stringify(turn.pending),
      replay: key === null ? null : { key, fingerprint, body: JSON.stringify(turn.body) },
      tokensPerChar: turn.tokensPerChar,
    });
    held = held && !saved;
    return saved;
  };
  return {
    begin: async () => {
      const begun = await stub.begin({ ...identity, leaseId, now: Date.now() });
      held = begun.kind === "started";
      return begunOf(begun);
    },
    renew: async () => stub.renew({ leaseId, now: Date.now() }),
    commit,
    release: async () => {
      if (held) {
        held = false;
        await stub.release({ leaseId, now: Date.now() });
      }
    },
  };
};
