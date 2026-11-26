import { readToolResults } from "../gateway/chat-body";
import { Rejection } from "../http/respond";
import type { Usage } from "../llm/cost";
import { NO_USAGE } from "../llm/cost";
import type { Listeners, MessageBlock, ModelMessage, ToolUseBlock } from "../llm/provider";
import type { Pending } from "../sessions/session";
import {
  historyLimits,
  measuredTokensPerChar,
  orderedResults,
  trimHistory,
  withoutImages,
} from "../sessions/session";
import type { ToolRuntime } from "../tools/execute";
import { executeServerCall, runsOnClient } from "../tools/execute";
import type { ChatTurn, RoundResult, SpentGrant } from "./chat";
import { chatRound } from "./chat";

export type Begun =
  | {
      kind: "started";
      history: ModelMessage[];
      pending: Pending | null;
      tokensPerChar: number | null;
    }
  | { kind: "replay"; body: Record<string, unknown> }
  | { kind: "refused"; status: number; code: string };

export interface TurnCommit {
  append: ModelMessage[];
  pending: Pending | null;
  body: Record<string, unknown>;
  tokensPerChar: number | null;
}

export interface SessionPort {
  begin: () => Promise<Begun>;
  renew: () => Promise<boolean>;
  commit: (turn: TurnCommit) => Promise<boolean>;
  release: () => Promise<void>;
}

export type TurnInput =
  { kind: "message"; content: string | MessageBlock[] } | { kind: "tool_results"; raw: unknown };

export interface SessionTurn {
  base: Omit<ChatTurn, "messages" | "toolRounds">;
  store: SessionPort;
  input: TurnInput;
  tools: ToolRuntime;
  listenersForRound: () => Listeners;
}

type Started = Extract<Begun, { kind: "started" }>;

interface Progress {
  messages: ModelMessage[];
  toolRounds: number;
  tokensPerChar: number | null;
}

export type PreparedTurn =
  | { kind: "replay"; body: Record<string, unknown> }
  | { kind: "started"; begun: Started; progress: Progress };

const addUsage = (left: Usage, right: Usage): Usage => ({
  input: left.input + right.input,
  output: left.output + right.output,
  cacheWrite: left.cacheWrite + right.cacheWrite,
  cacheRead: left.cacheRead + right.cacheRead,
});

const combine = (total: RoundResult | null, round: RoundResult): RoundResult =>
  total === null
    ? round
    : {
        ...round,
        attempts: total.attempts + round.attempts,
        allCalls: [...total.allCalls, ...round.allCalls],
        serverResults: [...total.serverResults, ...round.serverResults],
        usage: addUsage(total.usage, round.usage),
        costNanoEur: total.costNanoEur + round.costNanoEur,
      };

const startFrom = (turn: SessionTurn, begun: Started): Progress => {
  const { input } = turn;
  const { pending, tokensPerChar } = begun;
  if (input.kind === "message") {
    if (pending !== null) {
      throw new Rejection(409, "awaiting_tool_results");
    }
    return { messages: [{ role: "user", content: input.content }], toolRounds: 0, tokensPerChar };
  }
  if (pending === null) {
    throw new Rejection(400, "bad_tool_result");
  }
  const results = readToolResults(input.raw, pending.clientIds, turn.base.agent.input);
  return {
    messages: [...pending.messages, { role: "user", content: orderedResults(pending, results) }],
    toolRounds: pending.toolRounds,
    tokensPerChar,
  };
};

const SESSION_BUSY_RETRY_SECONDS = 1;

const busy = (): Rejection =>
  new Rejection(409, "session_busy", { retryAfterSeconds: SESSION_BUSY_RETRY_SECONDS });

const persist = async (turn: SessionTurn, commit: TurnCommit): Promise<void> => {
  if (!(await turn.store.commit(commit))) {
    throw busy();
  }
};

const handBack = (round: RoundResult, clientCalls: ToolUseBlock[]): RoundResult => ({
  ...round,
  content: clientCalls,
  calls: clientCalls,
  body: { ...round.body, content: clientCalls },
});

interface ToolStep {
  pending: Pending | null;
  messages: ModelMessage[];
  executed: string[];
}

const afterToolCalls = async (
  turn: SessionTurn,
  progress: Progress,
  round: RoundResult,
): Promise<ToolStep> => {
  const { contract } = turn.base;
  const messages: ModelMessage[] = [
    ...progress.messages,
    { role: "assistant", content: round.content },
  ];
  const clientCalls = round.calls.filter((call) => runsOnClient(contract, call));
  const serverCalls = round.calls.filter((call) => !runsOnClient(contract, call));
  const serverResults = await Promise.all(
    serverCalls.map((call) => executeServerCall(turn.tools, contract, call)),
  );
  const executed = serverResults.map((result) => result.content);
  if (clientCalls.length === 0) {
    return {
      pending: null,
      messages: [...messages, { role: "user", content: serverResults }],
      executed,
    };
  }
  const pending = {
    orderedIds: round.calls.map((call) => call.id),
    clientIds: clientCalls.map((call) => call.id),
    serverResults,
    toolRounds: progress.toolRounds + 1,
    messages,
  };
  return { pending, messages, executed };
};

const TOO_MANY_ROUNDS = {
  status: 502,
  outcome: "too_many_rounds",
  body: { error: "too_many_rounds", message: "That took too many steps. Ask again more simply." },
  content: [],
  calls: [],
  allCalls: [],
  serverResults: [],
  quota: null,
  model: null,
  attempts: 0,
  usage: NO_USAGE,
  costNanoEur: 0,
  promptChars: 0,
} satisfies RoundResult;

const REPLAYED = {
  status: 200,
  outcome: "replayed",
  content: [],
  calls: [],
  allCalls: [],
  serverResults: [],
  quota: null,
  model: null,
  attempts: 0,
  usage: NO_USAGE,
  costNanoEur: 0,
  promptChars: 0,
  replayed: true,
} satisfies Omit<RoundResult, "body"> & { replayed: true };

export type TurnResult = RoundResult & { replayed?: true };

const modelRound = async (
  turn: SessionTurn,
  begun: Started,
  progress: Progress,
): Promise<RoundResult> =>
  chatRound(
    {
      ...turn.base,
      messages: trimHistory(
        [...begun.history, ...progress.messages],
        historyLimits(turn.base.agent.input, progress.tokensPerChar),
      ),
      toolRounds: progress.toolRounds,
    },
    turn.listenersForRound(),
  );

const answered = async (
  turn: SessionTurn,
  progress: Progress,
  total: RoundResult,
): Promise<RoundResult> => {
  const messages: ModelMessage[] = [
    ...progress.messages,
    { role: "assistant", content: total.content },
  ];
  await persist(turn, {
    append: withoutImages(messages),
    pending: null,
    body: total.body,
    tokensPerChar: progress.tokensPerChar,
  });
  return total;
};

const handedBack = async (
  turn: SessionTurn,
  progress: Progress,
  step: { total: RoundResult; pending: Pending },
): Promise<RoundResult> => {
  const { clientIds } = step.pending;
  const result = handBack(
    step.total,
    step.total.calls.filter((call) => clientIds.includes(call.id)),
  );
  await persist(turn, {
    append: [],
    pending: step.pending,
    body: result.body,
    tokensPerChar: progress.tokensPerChar,
  });
  return result;
};

const refundAll = async (turn: SessionTurn, grants: readonly SpentGrant[]): Promise<void> => {
  const now = Date.now();
  for (const grant of grants) {
    if (grant.spent > 0 || grant.usedFreeRound) {
      await turn.base.quota.refund({ now, ...grant }).catch(() => undefined);
    }
  }
};

const tooMany = (total: RoundResult | null): RoundResult =>
  total === null ? TOO_MANY_ROUNDS : { ...TOO_MANY_ROUNDS, ...measuredOf(total) };

interface LoopInput {
  begun: Started;
  initial: Progress;
  grants: SpentGrant[];
}

const runLoop = async (turn: SessionTurn, state: LoopInput): Promise<RoundResult> => {
  const { begun, grants } = state;
  let progress = state.initial;
  let total: RoundResult | null = null;
  for (let round = 0; round < turn.base.agent.maxRounds; round += 1) {
    if (round > 0 && !(await turn.store.renew())) {
      throw busy();
    }
    const result = await modelRound(turn, begun, progress);
    total = combine(total, result);
    if (result.status !== 200) {
      await refundAll(turn, grants);
      return total;
    }
    if (result.spentGrant !== undefined) {
      grants.push(result.spentGrant);
    }
    const tokensPerChar =
      measuredTokensPerChar(result.usage, result.promptChars) ?? progress.tokensPerChar;
    progress = { ...progress, tokensPerChar };
    if (result.calls.length === 0) {
      return answered(turn, progress, total);
    }
    if (progress.toolRounds >= turn.base.agent.maxRounds) {
      await refundAll(turn, grants);
      return tooMany(total);
    }
    const next = await afterToolCalls(turn, progress, result);
    total = { ...total, serverResults: [...total.serverResults, ...next.executed] };
    if (next.pending !== null) {
      return handedBack(turn, progress, { total, pending: next.pending });
    }
    progress = { ...progress, messages: next.messages, toolRounds: progress.toolRounds + 1 };
  }
  await refundAll(turn, grants);
  return tooMany(total);
};

export const prepareSessionTurn = async (turn: SessionTurn): Promise<PreparedTurn> => {
  const begun = await turn.store.begin();
  if (begun.kind === "refused") {
    throw begun.code === "session_busy" ? busy() : new Rejection(begun.status, begun.code);
  }
  if (begun.kind === "replay") {
    return { kind: "replay", body: begun.body };
  }
  try {
    return { kind: "started", begun, progress: startFrom(turn, begun) };
  } catch (error) {
    await turn.store.release();
    throw error;
  }
};

export const finishSessionTurn = async (
  turn: SessionTurn,
  prepared: PreparedTurn,
): Promise<TurnResult> => {
  if (prepared.kind === "replay") {
    return { ...REPLAYED, body: prepared.body };
  }
  const grants: SpentGrant[] = [];
  try {
    return await runLoop(turn, { begun: prepared.begun, initial: prepared.progress, grants });
  } catch (error) {
    await refundAll(turn, grants);
    throw error;
  } finally {
    await turn.store.release();
  }
};

export const runSessionTurn = async (turn: SessionTurn): Promise<TurnResult> =>
  finishSessionTurn(turn, await prepareSessionTurn(turn));

const measuredOf = (
  result: RoundResult,
): Pick<RoundResult, "model" | "attempts" | "usage" | "costNanoEur"> => ({
  model: result.model,
  attempts: result.attempts,
  usage: result.usage,
  costNanoEur: result.costNanoEur,
});
