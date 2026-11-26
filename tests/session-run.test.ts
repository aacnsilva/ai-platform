import { describe, expect, it } from "vitest";

import course from "../examples/tenants/course.tenant.json" with { type: "json" };
import type { Begun, SessionPort, SessionTurn, TurnCommit } from "../src/agent/session-run";
import { runSessionTurn } from "../src/agent/session-run";
import { Rejection } from "../src/http/respond";
import { createBreaker } from "../src/llm/breaker";
import type { ModelMessage, ModelReply, ModelRequest, ReplyBlock } from "../src/llm/provider";
import type { Pending } from "../src/sessions/session";
import type { SessionRecord } from "../src/sessions/turn";
import { beginTurn, commitTurn, releaseTurn, renewTurn } from "../src/sessions/turn";
import type { ChatAgent } from "../src/tenants/schema";
import { tenantSchema } from "../src/tenants/schema";

const JPEG = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5));
const USAGE = { input: 1000, output: 50, cacheWrite: 0, cacheRead: 0 };

interface Stored {
  record: SessionRecord | null;
  log: ModelMessage[];
  pending: Pending | null;
  commits: TurnCommit[];
  releases: number;
}

const emptyStore = (): Stored => ({
  record: null,
  log: [],
  pending: null,
  commits: [],
  releases: 0,
});

interface Caller {
  leaseId: string;
  key?: string;
  fingerprint?: string;
}

const beginOn = (stored: Stored, caller: Caller): Begun => {
  const decision = beginTurn(stored.record, {
    owner: "ana",
    leaseId: caller.leaseId,
    now: Date.now(),
    key: caller.key ?? null,
    fingerprint: caller.fingerprint ?? "f",
  });
  if (decision.kind === "refused") {
    return { kind: "refused", status: 409, code: decision.code };
  }
  if (decision.kind === "replay") {
    return { kind: "replay", body: JSON.parse(decision.body) as Record<string, unknown> };
  }
  stored.record = decision.record;
  return {
    kind: "started",
    history: [...stored.log],
    pending: stored.pending,
    tokensPerChar: decision.record.tokensPerChar,
  };
};

const commitOn = (stored: Stored, caller: Caller, turn: TurnCommit): boolean => {
  const { key, leaseId } = caller;
  const next = commitTurn(stored.record, {
    leaseId,
    now: Date.now(),
    appended: turn.append.length,
    pending: turn.pending === null ? null : "pending",
    replay:
      key === undefined
        ? null
        : { key, fingerprint: caller.fingerprint ?? "f", body: JSON.stringify(turn.body) },
    tokensPerChar: turn.tokensPerChar,
  });
  if (next === null) {
    return false;
  }
  stored.record = next;
  stored.log.push(...turn.append);
  stored.pending = turn.pending;
  stored.commits.push(turn);
  return true;
};

const portOn = (stored: Stored, caller: Caller): SessionPort => ({
  begin: () => Promise.resolve(beginOn(stored, caller)),
  renew: () => {
    const renewed = renewTurn(stored.record, caller.leaseId, Date.now());
    stored.record = renewed ?? stored.record;
    return Promise.resolve(renewed !== null);
  },
  commit: (turn) => Promise.resolve(commitOn(stored, caller, turn)),
  release: () => {
    const released = releaseTurn(stored.record, caller.leaseId);
    stored.releases += 1;
    if (released.kind !== "untouched") {
      stored.record = released.kind === "kept" ? released.record : null;
    }
    return Promise.resolve();
  },
});

type Script = (request: ModelRequest) => ReplyBlock[] | Promise<ReplyBlock[]>;

const tenantWith = (input: Record<string, unknown>): ReturnType<typeof tenantSchema.parse> =>
  tenantSchema.parse({ ...course, agent: { ...course.agent, input } });

interface Scene {
  stored: Stored;
  requests: ModelRequest[];
  run: (content: SessionTurn["input"], caller?: Caller) => Promise<unknown>;
}

const sceneWith = (script: Script, input: Record<string, unknown> = {}): Scene => {
  const tenant = tenantWith(input);
  const agent = tenant.agent as ChatAgent;
  const contract = agent.contracts[0];
  if (contract === undefined) {
    throw new Error("the course example has a contract");
  }
  const stored = emptyStore();
  const requests: ModelRequest[] = [];
  const complete = async (_model: string, request: ModelRequest): Promise<ModelReply> => {
    requests.push(request);
    const blocks = await script(request);
    const stopReason = blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
    return { text: "", blocks, stopReason, usage: USAGE };
  };
  const turnFor = (content: SessionTurn["input"], caller: Caller): SessionTurn => ({
    base: {
      spend: {
        tenant,
        tier: "fast",
        effortOverride: null,
        ip: "1.1.1.1",
        skipNetworkLimit: true,
        provider: { complete, failureKind: () => "unavailable" },
        breaker: createBreaker(),
        ledger: {
          begin: () => Promise.resolve({ ok: true }),
          settle: () => Promise.resolve(),
          release: () => Promise.resolve(),
        },
      },
      agent,
      principal: {
        subjectId: "ana",
        planId: "basic",
        messagesPerMonth: 100,
        tier: "fast",
        authenticated: true,
        evaluated: false,
        effortOverride: null,
      },
      contract,
      quota: {
        begin: () =>
          Promise.resolve({ ok: true, used: 1, limit: 100, spent: 1, usedFreeRound: false }),
        refund: () => Promise.resolve(),
      },
      context: {},
    },
    store: portOn(stored, caller),
    input: content,
    tools: {
      allowedHosts: [],
      maxChars: 1000,
      fetcher: () => Promise.reject(new Error("no network in unit tests")),
      searchKnowledge: () => Promise.resolve([]),
    },
    listenersForRound: () => ({}),
  });
  return {
    stored,
    requests,
    run: async (content, caller = { leaseId: crypto.randomUUID() }) =>
      runSessionTurn(turnFor(content, caller)).catch((error: unknown) => error),
  };
};

const say = (text: string): ReplyBlock[] => [{ type: "text", text }];
const ask = (text: string): SessionTurn["input"] => ({ kind: "message", content: text });
const showCard = (id: string): ReplyBlock[] => [
  { type: "tool_use", id, name: "show_card", input: { title: "Hello" } },
];

describe("stored session turn", () => {
  it("refuses a second turn on a busy session before any model call is paid for", async () => {
    let letFirstFinish = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      letFirstFinish = resolve;
    });
    const scene = sceneWith(async () => {
      await gate;
      return say("the only answer");
    });
    const first = scene.run(ask("first"));
    const second = await scene.run(ask("second"));
    expect(second).toBeInstanceOf(Rejection);
    expect(second).toMatchObject({ status: 409, code: "session_busy", retryAfterSeconds: 1 });
    letFirstFinish();
    expect(await first).toMatchObject({ status: 200, outcome: "answered" });
    expect(scene.requests).toHaveLength(1);
    expect(scene.stored.log).toHaveLength(2);
  });

  it("lets go of the session when the turn fails, and leaves a new session empty", async () => {
    const scene = sceneWith(() => {
      throw new Error("the provider is down");
    });
    expect(await scene.run(ask("first"))).toMatchObject({ status: 502, outcome: "upstream" });
    expect(scene.stored).toMatchObject({ record: null, releases: 1, commits: [] });
    expect(await scene.run(ask("again"))).toMatchObject({ status: 502 });
  });

  it("answers a repeated key from the store: no model call, no second message", async () => {
    const scene = sceneWith(() => say("answer one"));
    const caller = { leaseId: "l1", key: "k1" };
    const first = await scene.run(ask("question"), caller);
    const again = await scene.run(ask("question"), { ...caller, leaseId: "l2" });
    expect(again).toMatchObject({ status: 200, outcome: "replayed", replayed: true, attempts: 0 });
    expect((again as { body: unknown }).body).toEqual((first as { body: unknown }).body);
    expect(scene.requests).toHaveLength(1);
    expect(scene.stored.log).toHaveLength(2);
    const changed = await scene.run(ask("other"), { ...caller, leaseId: "l3", fingerprint: "g" });
    expect(changed).toMatchObject({ code: "idempotency_key_reused" });
  });

  it("only ever appends: old turns stay in the log while the model sees a trimmed copy", async () => {
    const scene = sceneWith(() => say("a".repeat(600)), { maxConversationChars: 1000 });
    await scene.run(ask("first question"));
    await scene.run(ask("second question"));
    await scene.run(ask("third question"));
    expect(scene.stored.commits.map((commit) => commit.append.length)).toEqual([2, 2, 2]);
    const questions = scene.stored.log
      .map((message) => message.content)
      .filter((content) => typeof content === "string");
    expect(questions).toEqual(["first question", "second question", "third question"]);
    expect(scene.requests.map((request) => request.messages.length)).toEqual([1, 3, 3]);
    expect(scene.requests[2]?.messages[0]?.content).toBe("second question");
  });

  it("trims by tokens at the measured rate when the tenant sets a token budget", async () => {
    const scene = sceneWith(() => say("b".repeat(300)), { maxConversationTokens: 250 });
    await scene.run(ask("first question"));
    expect(scene.stored.record?.tokensPerChar).toBeGreaterThan(0.05);
    await scene.run(ask("second question"));
    await scene.run(ask("third question"));
    expect(scene.requests.at(-1)?.messages).toHaveLength(1);
    expect(scene.stored.log).toHaveLength(6);
  });

  it("holds a turn that waits on the client outside the log, photo included, until it ends", async () => {
    const scene = sceneWith((request) =>
      request.messages.length === 1 ? showCard("card1") : say("the card is up"),
    );
    const photo: SessionTurn["input"] = {
      kind: "message",
      content: [
        { type: "image", mediaType: "image/jpeg", data: JPEG },
        { type: "text", text: "what is this" },
      ],
    };
    expect(await scene.run(photo)).toMatchObject({ outcome: "tool_round" });
    expect(scene.stored.log).toHaveLength(0);
    expect(scene.stored.pending?.messages).toHaveLength(2);
    expect(await scene.run(ask("impatient"))).toMatchObject({ code: "awaiting_tool_results" });
    const results = [{ type: "tool_result", tool_use_id: "card1", content: "shown" }];
    expect(await scene.run({ kind: "tool_results", raw: results })).toMatchObject({
      outcome: "answered",
    });
    expect(JSON.stringify(scene.requests[1]?.messages)).toContain(JPEG);
    expect(scene.stored.log).toHaveLength(4);
    expect(JSON.stringify(scene.stored.log)).not.toContain(JPEG);
    expect(scene.stored.pending).toBeNull();
  });

  it("stops client-tool handbacks once total tool rounds reach maxRounds", async () => {
    let calls = 0;
    const tenant = tenantSchema.parse({
      ...course,
      agent: { ...course.agent, maxRounds: 2 },
    });
    const agent = tenant.agent as ChatAgent;
    const contract = agent.contracts[0];
    if (contract === undefined) {
      throw new Error("contract expected");
    }
    const stored = emptyStore();
    const refunds: number[] = [];
    const runWith = (input: SessionTurn["input"], leaseId: string): Promise<unknown> =>
      runSessionTurn({
        base: {
          spend: {
            tenant,
            tier: "fast",
            effortOverride: null,
            ip: "1.1.1.1",
            skipNetworkLimit: true,
            provider: {
              failureKind: () => "unavailable",
              complete: () => {
                calls += 1;
                return Promise.resolve({
                  text: "",
                  blocks: showCard(`c${String(calls)}`),
                  stopReason: "tool_use",
                  usage: USAGE,
                });
              },
            },
            breaker: createBreaker(),
            ledger: {
              begin: () => Promise.resolve({ ok: true }),
              settle: () => Promise.resolve(),
              release: () => Promise.resolve(),
            },
          },
          agent,
          principal: {
            subjectId: "ana",
            planId: "basic",
            messagesPerMonth: 100,
            tier: "fast",
            authenticated: true,
            evaluated: false,
            effortOverride: null,
          },
          contract,
          quota: {
            begin: () =>
              Promise.resolve({ ok: true, used: 1, limit: 100, spent: 1, usedFreeRound: false }),
            refund: (r) => {
              refunds.push(r.spent);
              return Promise.resolve();
            },
          },
          context: {},
        },
        store: portOn(stored, { leaseId }),
        input,
        tools: {
          allowedHosts: [],
          maxChars: 1000,
          fetcher: () => Promise.reject(new Error("no network")),
          searchKnowledge: () => Promise.resolve([]),
        },
        listenersForRound: () => ({}),
      });
    const r1 = await runWith(ask("loop"), "l1");
    expect(r1).toMatchObject({ status: 200, outcome: "tool_round" });
    const r2 = await runWith(
      { kind: "tool_results", raw: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] },
      "l2",
    );
    expect(r2).toMatchObject({ status: 200, outcome: "tool_round" });
    const r3 = await runWith(
      { kind: "tool_results", raw: [{ type: "tool_result", tool_use_id: "c2", content: "ok" }] },
      "l3",
    );
    expect(r3).toMatchObject({ status: 502, outcome: "too_many_rounds" });
    expect(refunds).toEqual([1]);
  });

  it("refunds earlier rounds when a later round in the same turn fails", async () => {
    const tenant = tenantSchema.parse({
      ...course,
      agent: { ...course.agent, maxRounds: 3, counting: "questions_only" },
    });
    const agent = tenant.agent as ChatAgent;
    const contract = agent.contracts[0];
    if (contract === undefined) {
      throw new Error("contract expected");
    }
    const stored = emptyStore();
    let round = 0;
    let used = 0;
    const run = await runSessionTurn({
      base: {
        spend: {
          tenant,
          tier: "fast",
          effortOverride: null,
          ip: "1.1.1.1",
          skipNetworkLimit: true,
          provider: {
            failureKind: () => "unavailable",
            complete: () => {
              round += 1;
              if (round === 1) {
                return Promise.resolve({
                  text: "",
                  blocks: [
                    { type: "tool_use", id: "k1", name: "search_knowledge", input: { query: "x" } },
                  ],
                  stopReason: "tool_use",
                  usage: USAGE,
                });
              }
              return Promise.reject(new Error("boom"));
            },
          },
          breaker: createBreaker(),
          ledger: {
            begin: () => Promise.resolve({ ok: true }),
            settle: () => Promise.resolve(),
            release: () => Promise.resolve(),
          },
        },
        agent,
        principal: {
          subjectId: "ana",
          planId: "basic",
          messagesPerMonth: 100,
          tier: "fast",
          authenticated: true,
          evaluated: false,
          effortOverride: null,
        },
        contract,
        quota: {
          begin: (input) => {
            const spent = input.toolRounds === 0 ? 1 : 0;
            used += spent;
            return Promise.resolve({ ok: true, used, limit: 100, spent, usedFreeRound: false });
          },
          refund: (input) => {
            used -= input.spent;
            return Promise.resolve();
          },
        },
        context: {},
      },
      store: portOn(stored, { leaseId: "l1" }),
      input: ask("search then fail"),
      tools: {
        allowedHosts: [],
        maxChars: 1000,
        fetcher: () => Promise.reject(new Error("no network")),
        searchKnowledge: () => Promise.resolve([]),
      },
      listenersForRound: () => ({}),
    });
    expect(run).toMatchObject({ status: 502, outcome: "upstream" });
    expect(used).toBe(0);
  });
});
