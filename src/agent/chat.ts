import type { Principal } from "../authn/principal";
import type { ChatContext } from "../gateway/chat-body";
import { conversationChars } from "../gateway/chat-body";
import { Rejection } from "../http/respond";
import type { ModelId } from "../llm/catalog";
import type { Usage } from "../llm/cost";
import type {
  Listeners,
  ModelMessage,
  ModelReply,
  ReplyBlock,
  ToolUseBlock,
} from "../llm/provider";
import type { QuotaBegin, QuotaGrant, QuotaRefund, QuotaRefusal } from "../quota/subject";
import type { ChatAgent, Contract } from "../tenants/schema";
import { latestQuestion, refusalFor, systemFor, systemTail } from "./chat-prompt";
import type { Spend } from "./spend";
import type { FailureReport } from "./spend";
import { callModel, failureReport, releasePool, reservePool } from "./spend";

export interface QuotaPort {
  begin: (input: QuotaBegin) => Promise<QuotaGrant | QuotaRefusal>;
  refund: (input: QuotaRefund) => Promise<void>;
}

export interface ChatTurn {
  spend: Spend;
  agent: ChatAgent;
  principal: Principal;
  contract: Contract;
  quota: QuotaPort;
  messages: readonly ModelMessage[];
  context: ChatContext;
  toolRounds: number;
}

export interface QuotaView {
  used: number;
  limit: number;
}

export interface SpentGrant {
  spent: 0 | 1;
  usedFreeRound: boolean;
}

export interface RoundResult {
  status: number;
  outcome: string;
  body: Record<string, unknown>;
  content: ReplyBlock[];
  calls: ToolUseBlock[];
  allCalls: ToolUseBlock[];
  serverResults: string[];
  quota: QuotaView | null;
  spentGrant?: SpentGrant;
  model: ModelId | null;
  attempts: number;
  usage: Usage;
  costNanoEur: number;
  promptChars: number;
}

const TOOL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CAP_MESSAGE = "This month's messages are used up.";

const toolSpecs = (contract: Contract): Contract["tools"] => contract.tools;

const promptChars = (turn: ChatTurn, tail: readonly string[]): number =>
  conversationChars(turn.messages, turn.agent.input.imageChars) +
  systemFor(turn).length +
  tail.reduce((total, part) => total + part.length, 0) +
  JSON.stringify(toolSpecs(turn.contract)).length;

const beginQuota = async (turn: ChatTurn): Promise<QuotaGrant> => {
  const limit = turn.principal.messagesPerMonth ?? Number.MAX_SAFE_INTEGER;
  const grant = await turn.quota.begin({
    now: Date.now(),
    limit,
    toolRounds: turn.toolRounds,
    counting: turn.agent.counting,
  });
  if (!grant.ok) {
    throw new Rejection(429, grant.error, {
      message: CAP_MESSAGE,
      retryAfterSeconds: grant.retryAfterSeconds,
    });
  }
  return grant;
};

const publicBlocks = (agent: ChatAgent, blocks: readonly ReplyBlock[]): ReplyBlock[] => {
  const calls = blocks.filter((block) => block.type === "tool_use");
  if (calls.length > 0) {
    return calls;
  }
  return blocks.flatMap((block): ReplyBlock[] => {
    const text =
      block.type === "text" ? block.text.trim().slice(0, agent.input.maxReplyChars).trim() : "";
    return text === "" ? [] : [{ type: "text", text }];
  });
};

const isSendable = (turn: ChatTurn, call: ToolUseBlock): boolean =>
  turn.contract.tools.some((tool) => tool.name === call.name) &&
  JSON.stringify(call.input).length <= turn.agent.input.maxToolInputChars &&
  TOOL_ID.test(call.id);

const problemWith = (
  turn: ChatTurn,
  reply: ModelReply,
  content: readonly ReplyBlock[],
): string | null => {
  const calls = content.filter((block) => block.type === "tool_use");
  const askedForTools = reply.stopReason === "tool_use" || calls.length > 0;
  if (askedForTools && reply.stopReason === "max_tokens") {
    return "unreadable";
  }
  const sendable =
    content.length <= turn.agent.input.maxBlocks && calls.every((call) => isSendable(turn, call));
  if (askedForTools && (calls.length === 0 || !sendable)) {
    return "unknown_tool";
  }
  return content.length === 0 ? "unreadable" : null;
};

type Measured = Pick<RoundResult, "model" | "attempts" | "usage" | "costNanoEur" | "promptChars">;

const unreadable = (code: string): FailureReport => ({
  status: 502,
  outcome: code,
  body: { error: code },
});

const failure = (report: FailureReport, measured: Measured): RoundResult => ({
  ...report,
  content: [],
  calls: [],
  allCalls: [],
  serverResults: [],
  quota: null,
  ...measured,
});

const success = (
  turn: ChatTurn,
  reply: ModelReply,
  grant: QuotaGrant,
): Omit<RoundResult, keyof Measured> | null => {
  const quota = { used: grant.used, limit: grant.limit };
  if (reply.stopReason === "refusal") {
    const text = refusalFor(turn.agent, latestQuestion(turn.messages), turn.context);
    const content: ReplyBlock[] = [{ type: "text", text }];
    return {
      status: 200,
      outcome: "refusal",
      body: { stopReason: "end_turn", content, quota },
      content,
      calls: [],
      allCalls: [],
      serverResults: [],
      quota,
    };
  }
  const content = publicBlocks(turn.agent, reply.blocks);
  if (problemWith(turn, reply, content) !== null) {
    return null;
  }
  const calls = content.filter((block) => block.type === "tool_use");
  const stopReason = calls.length > 0 ? "tool_use" : "end_turn";
  const outcome = calls.length > 0 ? "tool_round" : "answered";
  return {
    status: 200,
    outcome,
    body: { stopReason, content, quota },
    content,
    calls,
    allCalls: calls,
    serverResults: [],
    quota,
  };
};

export const chatRound = async (turn: ChatTurn, listeners: Listeners): Promise<RoundResult> => {
  const { agent, spend } = turn;
  const tail = systemTail(agent, turn.messages, turn.context);
  const chars = promptChars(turn, tail);
  const reservation = await reservePool(spend, chars, agent.maxOutputTokens);
  const grant = await beginQuota(turn).catch(async (error: unknown) => {
    await releasePool(spend, reservation);
    throw error;
  });
  const refund = async (): Promise<void> =>
    turn.quota.refund({ now: Date.now(), spent: grant.spent, usedFreeRound: grant.usedFreeRound });
  const outcome = await callModel({
    spend,
    reservation,
    listeners,
    request: {
      maxOutputTokens: agent.maxOutputTokens,
      effort: spend.effortOverride ?? agent.effort,
      system: systemFor(turn),
      systemTail: tail,
      messages: turn.messages,
      trailingReminder: undefined,
      replySchema: undefined,
      tools: toolSpecs(turn.contract),
      thinking: agent.thinking,
    },
  }).catch(async (error: unknown) => {
    await refund().catch(() => undefined);
    throw error;
  });
  const measured = {
    model: outcome.model,
    attempts: outcome.attempts,
    usage: outcome.usage,
    costNanoEur: outcome.costNanoEur,
    promptChars: chars,
  };
  if (!outcome.ok) {
    await refund();
    return failure(failureReport(outcome), measured);
  }
  const result = success(turn, outcome.reply, grant);
  if (result === null) {
    await refund();
    const code =
      problemWith(turn, outcome.reply, publicBlocks(agent, outcome.reply.blocks)) ?? "unreadable";
    return failure(unreadable(code), measured);
  }
  return {
    ...result,
    spentGrant: { spent: grant.spent, usedFreeRound: grant.usedFreeRound },
    ...measured,
  };
};
