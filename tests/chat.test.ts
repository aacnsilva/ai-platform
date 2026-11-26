import { describe, expect, it } from "vitest";

import course from "../examples/tenants/course.tenant.json" with { type: "json" };
import { languageInstruction, refusalFor, systemFor, systemTail } from "../src/agent/chat-prompt";
import { createChatStream } from "../src/agent/chat-stream";
import { parseChat, parseStoredTurn } from "../src/gateway/chat-body";
import { parseConversation } from "../src/gateway/conversation";
import { Rejection } from "../src/http/respond";
import type { ModelMessage } from "../src/llm/provider";
import {
  historyLimits,
  measuredTokensPerChar,
  orderedResults,
  transcript,
  trimHistory,
  withoutImages,
} from "../src/sessions/session";
import type { ChatAgent } from "../src/tenants/schema";
import { tenantSchema } from "../src/tenants/schema";
import { canonical, contractHash } from "../src/tools/contract-hash";
import { resolveUrl } from "../src/tools/http-tool";

const agentOf = (overrides: Record<string, unknown> = {}): ChatAgent => {
  const tenant = tenantSchema.parse({ ...course, agent: { ...course.agent, ...overrides } });
  if (tenant.agent.kind !== "chat") {
    throw new Error("the course example is a chat tenant");
  }
  return tenant.agent;
};

const JPEG = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5));
const body = (overrides: Record<string, unknown>): string =>
  JSON.stringify({ contractVersion: 1, context: { locale: "en" }, ...overrides });
const codeOf = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    return error instanceof Rejection ? error.code : "threw something else";
  }
  return "accepted";
};
const round = (id: string, result: string): unknown[] => [
  {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "show_card", input: { title: "x" } }],
  },
  { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] },
];

describe("chat request", () => {
  const stateless = agentOf({
    state: "stateless",
    contracts: [{ version: 1, allowsImages: true, tools: [course.agent.contracts[0]?.tools[2]] }],
    input: { maxImageBytes: 1000 },
  });

  it("counts the tool rounds since the person's latest question", () => {
    const question = { role: "user", content: "show me" };
    expect(parseChat(body({ messages: [question] }), stateless).toolRounds).toBe(0);
    const twoRounds = [question, ...round("a", "one"), ...round("b", "two")];
    expect(parseChat(body({ messages: twoRounds }), stateless).toolRounds).toBe(2);
    const newQuestion = [...twoRounds, { role: "assistant", content: "done" }, question];
    expect(parseChat(body({ messages: newQuestion }), stateless).toolRounds).toBe(0);
  });

  it("accepts one photo on the latest question and rebuilds the block itself", () => {
    const photo = [
      { type: "image", media_type: "image/jpeg", data: JPEG, smuggled: "x" },
      { type: "text", text: "what is this" },
    ];
    const parsed = parseChat(body({ messages: [{ role: "user", content: photo }] }), stateless);
    expect(parsed.hasImage).toBe(true);
    expect(parsed.messages[0]?.content).toEqual([
      { type: "image", mediaType: "image/jpeg", data: JPEG },
      { type: "text", text: "what is this" },
    ]);
  });

  it.each([
    [
      "bad_image",
      [
        { type: "image", media_type: "image/png", data: JPEG },
        { type: "text", text: "q" },
      ],
    ],
    [
      "bad_image",
      [
        { type: "image", media_type: "image/jpeg", data: btoa("not a jpeg at all") },
        { type: "text", text: "q" },
      ],
    ],
    [
      "image_too_large",
      [
        { type: "image", media_type: "image/jpeg", data: btoa(`\xff\xd8\xff${"x".repeat(1200)}`) },
        { type: "text", text: "q" },
      ],
    ],
    ["bad_content", [{ type: "text", text: "q" }]],
  ])("refuses a photo question with %s", (code, content) => {
    expect(
      codeOf(() => parseChat(body({ messages: [{ role: "user", content }] }), stateless)),
    ).toBe(code);
  });

  it("refuses a photo on an earlier question, a reused tool id, and an unanswered tool call", () => {
    const photo = [
      { type: "image", media_type: "image/jpeg", data: JPEG },
      { type: "text", text: "old" },
    ];
    const earlier = [
      { role: "user", content: photo },
      { role: "assistant", content: "ok" },
      { role: "user", content: "new" },
    ];
    expect(codeOf(() => parseChat(body({ messages: earlier }), stateless))).toBe("bad_image");
    const reused = [{ role: "user", content: "q" }, ...round("a", "one"), ...round("a", "two")];
    expect(codeOf(() => parseChat(body({ messages: reused }), stateless))).toBe("bad_tool_id");
    const unanswered = [{ role: "user", content: "q" }, round("a", "one")[0]];
    expect(codeOf(() => parseChat(body({ messages: unanswered }), stateless))).toBe(
      "bad_tool_result",
    );
  });

  it("refuses a conversation over the tenant's total size", () => {
    const small = agentOf({
      state: "stateless",
      contracts: [{ version: 1, tools: [] }],
      input: { maxConversationChars: 1000 },
    });
    const messages = [
      { role: "user", content: "x".repeat(600) },
      { role: "assistant", content: "y".repeat(600) },
      { role: "user", content: "q" },
    ];
    expect(codeOf(() => parseChat(body({ messages }), small))).toBe("too_long");
  });

  it("measures body size in UTF-8 bytes and rejects ambiguous stored turns", () => {
    const stored = agentOf({ state: "stored", input: { maxBodyBytes: 260 } });
    expect(
      codeOf(() =>
        parseStoredTurn(
          body({
            message: "hi",
            toolResults: [{ type: "tool_result", tool_use_id: "a", content: "ok" }],
          }),
          stored,
        ),
      ),
    ).toBe("bad_content");
    const multibyte = body({ messages: [{ role: "user", content: "€".repeat(100) }] });
    expect(multibyte.length).toBeLessThan(260);
    expect(
      codeOf(() =>
        parseConversation(multibyte, {
          maxMessages: 6,
          maxUserChars: 800,
          maxAssistantChars: 800,
          maxBodyBytes: 260,
        }),
      ),
    ).toBe("too_large");
  });
});

describe("chat prompt", () => {
  const agent = agentOf();

  it("names the language the question is written in, and falls back to the locale on a tie", () => {
    expect(languageInstruction(agent, "what is the sprocket", { locale: "es" })).toBe(
      "Answer in English.",
    );
    expect(languageInstruction(agent, "¿qué es el piñón?", { locale: "en" })).toBe(
      "Responde en español.",
    );
    expect(languageInstruction(agent, "chain-oil", { locale: "es" })).toBe("Responde en español.");
    expect(languageInstruction(agent, "chain-oil", {})).toBe("Answer in English.");
  });

  it("puts the context, then the reminder with the language, after the cached prompt", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "what is the sprocket" }];
    expect(systemTail(agent, messages, { locale: "en", topics: ["brakes"] })).toEqual([
      "Locale: en\nTopics: brakes",
      `${agent.reminder ?? ""} Answer in English.`,
    ]);
  });
});

describe("prompt and refusal chosen by tenant rules", () => {
  const agent = agentOf({
    versionField: "appVersion",
    context: [
      { name: "locale", label: "Locale", kind: "text", required: false },
      { name: "appVersion", label: "App version", kind: "text", required: false },
    ],
    systems: [
      { contractVersion: 2, versionAtLeast: "2.0", system: "contract two on a new app" },
      { versionAtLeast: "1.5.0", system: "any contract from 1.5" },
      { contractVersion: 2, system: "contract two on an old app" },
    ],
    contracts: [
      { version: 1, tools: [] },
      { version: 2, tools: [] },
    ],
    refusal: { fallback: "No.", byLanguage: { es: "No, en español." } },
  });
  const [one, two] = agent.contracts;
  if (one === undefined || two === undefined) {
    throw new Error("two contracts expected");
  }
  const pick = (contract: typeof one, appVersion?: string): string =>
    systemFor({ agent, contract, context: appVersion === undefined ? {} : { appVersion } });

  it("uses the first rule whose contract and client version both fit, else the default prompt", () => {
    expect(pick(two, "2.1.0")).toBe("contract two on a new app");
    expect(pick(two, "1.9")).toBe("any contract from 1.5");
    expect(pick(two, "1.4.9")).toBe("contract two on an old app");
    expect(pick(two)).toBe("contract two on an old app");
    expect(pick(one, "1.5.0")).toBe("any contract from 1.5");
    expect(pick(one, "1.4")).toBe(agent.system);
    expect(pick(one, "not a version")).toBe(agent.system);
  });

  it("refuses in the language of the question, then of the locale, then in the fallback", () => {
    expect(refusalFor(agent, "¿qué es el piñón?", { locale: "en" })).toBe("No, en español.");
    expect(refusalFor(agent, "chain-oil", { locale: "es" })).toBe("No, en español.");
    expect(refusalFor(agent, "what is the sprocket", { locale: "es" })).toBe("No.");
  });
});

describe("held stream", () => {
  it("holds the opening back until it is long enough to be an answer", () => {
    const stream = createChatStream({ holdChars: 10, maxChars: 100 });
    expect(stream.push("  Short")).toBe("");
    expect(stream.push(" enough now")).toBe("Short enough now");
    expect(stream.push(" and on")).toBe(" and on");
  });

  it("shows nothing once a tool call begins, and never more than the reply cap", () => {
    const calling = createChatStream({ holdChars: 50, maxChars: 100 });
    expect(calling.push("Let me look")).toBe("");
    calling.tool();
    expect(calling.push(" that up for you, one moment please while I search")).toBe("");
    const capped = createChatStream({ holdChars: 0, maxChars: 5 });
    expect(capped.push("123456789")).toBe("12345");
    expect(capped.push("more")).toBe("");
  });
});

describe("session history", () => {
  const exchange = (label: string): ModelMessage[] => [
    { role: "user", content: `question ${label} ${"x".repeat(100)}` },
    { role: "assistant", content: [{ type: "tool_use", id: label, name: "t", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: label, content: "result" }] },
    { role: "assistant", content: `answer ${label}` },
  ];
  const limits = {
    maxChars: 300,
    maxMessages: 60,
    imageChars: 0,
    maxTokens: null,
    tokensPerChar: 1 / 3,
  };

  it("drops whole exchanges from the front, never leaving a tool result without its call", () => {
    const kept = trimHistory([...exchange("a"), ...exchange("b"), ...exchange("c")], limits);
    expect(kept).toHaveLength(8);
    expect(kept[0]?.content).toContain("question b");
    expect(trimHistory(exchange("a"), { ...limits, maxChars: 10 })).toHaveLength(4);
  });

  it("starts what the model sees at a question, even when the stored tail begins mid-exchange", () => {
    const tail = [...exchange("a").slice(2), ...exchange("b")];
    expect(trimHistory(tail, { ...limits, maxChars: 10_000 })[0]?.content).toContain("question b");
  });

  it("budgets in tokens at the rate the provider last measured for this conversation", () => {
    const all = [...exchange("a"), ...exchange("b")];
    const roomy = { ...limits, maxChars: 10_000, maxTokens: 100 };
    expect(trimHistory(all, roomy)).toHaveLength(8);
    expect(trimHistory(all, { ...roomy, tokensPerChar: 1 })).toHaveLength(4);
    const usage = { input: 300, output: 50, cacheWrite: 100, cacheRead: 600 };
    expect(measuredTokensPerChar(usage, 4000)).toBe(0.25);
    expect(measuredTokensPerChar(usage, 0)).toBeNull();
    expect(measuredTokensPerChar(usage, 10)).toBe(2);
    expect(historyLimits(agentOf().input, null)).toMatchObject({
      maxTokens: null,
      tokensPerChar: 1 / 3,
    });
    expect(
      historyLimits(agentOf({ input: { maxConversationTokens: 900 } }).input, 0.4),
    ).toMatchObject({ maxTokens: 900, tokensPerChar: 0.4 });
  });

  it("returns client results in the order the model asked, merged with the ones the runtime ran", () => {
    const pending = {
      orderedIds: ["one", "two", "three"],
      clientIds: ["two"],
      serverResults: [
        { type: "tool_result" as const, tool_use_id: "three", content: "c" },
        { type: "tool_result" as const, tool_use_id: "one", content: "a" },
      ],
      toolRounds: 1,
      messages: [],
    };
    const merged = orderedResults(pending, [
      { type: "tool_result", tool_use_id: "two", content: "b" },
    ]);
    expect(merged.map((result) => result.content)).toEqual(["a", "b", "c"]);
  });

  it("keeps the words and drops the photo and the tool traffic from a transcript", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", mediaType: "image/jpeg", data: JPEG },
          { type: "text", text: "what is this" },
        ],
      },
      ...exchange("a").slice(1),
    ];
    expect(withoutImages(messages)[0]?.content).toEqual([{ type: "text", text: "what is this" }]);
    expect(transcript(messages)).toEqual([
      { role: "user", text: "what is this" },
      { role: "assistant", text: "answer a" },
    ]);
  });
});

describe("tools", () => {
  const hosts = ["guides.example"];

  it("fills an address only with plain identifiers and only for an allowed host", () => {
    const template = "https://guides.example/api/{course}/{slug}.json";
    expect(resolveUrl(template, { course: "bikes", slug: "guide-1" }, hosts)?.href).toBe(
      "https://guides.example/api/bikes/guide-1.json",
    );
    for (const slug of ["../admin", "a/b", "a?b=c", "", 5.5, null, "x".repeat(101), "a..b"]) {
      const resolved = resolveUrl(template, { course: "bikes", slug }, hosts);
      expect(slug === 5.5 ? resolved?.pathname : resolved).toBe(
        slug === 5.5 ? "/api/bikes/5.5.json" : null,
      );
    }
    expect(resolveUrl(template, { course: "bikes" }, hosts)).toBeNull();
    expect(resolveUrl("https://evil.example/{slug}", { slug: "x" }, hosts)).toBeNull();
    const queryUrl = resolveUrl(
      "https://guides.example/api/{course}?q={query}&since={since}",
      { course: "bikes", query: "brake pad wear", since: "2026-11-26T12:00:00Z" },
      hosts,
    );
    expect(queryUrl?.searchParams.get("q")).toBe("brake pad wear");
    expect(queryUrl?.searchParams.get("since")).toBe("2026-11-26T12:00:00Z");
    expect(
      resolveUrl("https://guides.example/api/bikes?q={query}", { query: "bad\u0000" }, hosts),
    ).toBeNull();
  });

  it("hashes a contract the same whatever the key order, and differently when a tool changes", async () => {
    const [contract] = agentOf().contracts;
    if (contract === undefined) {
      throw new Error("the course example has a contract");
    }
    expect(canonical({ b: [1, { d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[1,{"c":2,"d":1}]}');
    const reordered = {
      tools: contract.tools,
      allowsImages: contract.allowsImages,
      version: contract.version,
    };
    expect(await contractHash(reordered)).toBe(await contractHash(contract));
    const [first, ...rest] = contract.tools;
    const changed = { ...contract, tools: [{ ...first, description: "changed" }, ...rest] };
    expect(await contractHash(changed as typeof contract)).not.toBe(await contractHash(contract));
  });
});
