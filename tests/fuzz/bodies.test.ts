import fc from "fast-check";
import { describe, expect, it } from "vitest";

import course from "../../examples/tenants/course.tenant.json" with { type: "json" };
import { conversationChars, parseChat, parseStoredTurn } from "../../src/gateway/chat-body";
import { parseConversation } from "../../src/gateway/conversation";
import { Rejection } from "../../src/http/respond";
import type { ChatAgent } from "../../src/tenants/schema";
import { tenantSchema } from "../../src/tenants/schema";

const LIMITS = { maxMessages: 4, maxUserChars: 20, maxAssistantChars: 10, maxBodyBytes: 2000 };
const KEPT_CONTROLS = new Set([0x09, 0x0a, 0x0d]);
const hasControls = (text: string): boolean =>
  Array.from(text).some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f && !KEPT_CONTROLS.has(code);
  });
const JPEG = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5));

const agentOf = (state: "stored" | "stateless"): ChatAgent => {
  const tenant = tenantSchema.parse({
    ...course,
    agent: {
      ...course.agent,
      state,
      contracts: [
        {
          version: 1,
          allowsImages: true,
          tools: course.agent.contracts[0]?.tools.slice(state === "stored" ? 0 : 2),
        },
      ],
    },
  });
  if (tenant.agent.kind !== "chat") {
    throw new Error("the course example is a chat tenant");
  }
  return tenant.agent;
};

const rejectedOr = <T>(work: () => T): T | null => {
  try {
    return work();
  } catch (error) {
    if (error instanceof Rejection && error.status === 400) {
      return null;
    }
    throw error;
  }
};

const texts = fc.oneof(
  fc.string({ maxLength: 30 }),
  fc.string({ unit: "binary", maxLength: 30 }),
  fc.constantFrom("", " ", "\u0000", "a\u0007b", "x".repeat(5000)),
);
const junk = fc.anything({ maxDepth: 3 });
const roles = fc.oneof(fc.constantFrom("user", "assistant", "system"), junk);
const toolIds = fc.constantFrom("a", "b", "c", "a b", "");
const toolNames = fc.constantFrom("get_guide", "search_knowledge", "show_card", "run_shell");
const blocks = fc.oneof(
  fc.record({ type: fc.constant("text"), text: texts }),
  fc.record({ type: fc.constant("tool_use"), id: toolIds, name: toolNames, input: junk }),
  fc.record(
    { type: fc.constant("tool_result"), tool_use_id: toolIds, content: texts, is_error: junk },
    { requiredKeys: ["type", "tool_use_id", "content"] },
  ),
  fc.record({
    type: fc.constant("image"),
    media_type: fc.constantFrom("image/jpeg", "image/png"),
    data: fc.oneof(fc.constant(JPEG), fc.base64String({ maxLength: 40 }), texts),
  }),
  junk,
);
const contents = fc.oneof(texts, fc.array(blocks, { maxLength: 4 }), junk);
const messages = fc.array(fc.oneof(fc.record({ role: roles, content: contents }), junk), {
  maxLength: 8,
});
const contexts = fc.oneof(
  fc.constant(undefined),
  fc.record(
    { locale: fc.oneof(fc.constantFrom("en", "es", "EN!"), junk), topics: junk },
    { requiredKeys: [] },
  ),
  junk,
);
const chatBodies = fc.oneof(
  fc.record(
    {
      contractVersion: fc.oneof(fc.constant(1), junk),
      contractHash: fc.oneof(fc.constant(undefined), fc.string(), junk),
      context: contexts,
      messages: fc.oneof(messages, junk),
      message: contents,
      toolResults: fc.oneof(fc.constant(undefined), fc.array(blocks, { maxLength: 3 }), junk),
      sessionId: fc.oneof(fc.constant(undefined), fc.uuid(), junk),
    },
    { requiredKeys: [] },
  ),
  junk,
);
const words = fc.stringMatching(/^[a-z]{1,10}( [a-z]{1,10}){0,3}$/);
const round = (id: string, result: string): unknown[] => [
  {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "show_card", input: { title: result } }],
  },
  { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] },
];
const damages = fc.record({
  at: fc.integer({ min: 0, max: 6 }),
  with: fc.option(fc.oneof(fc.record({ role: roles, content: contents }), junk), {
    nil: undefined,
  }),
});
const sound = fc
  .record({
    question: words,
    results: fc.array(words, { maxLength: 3 }),
    locale: fc.constantFrom("en", "es"),
    damage: fc.option(damages, { nil: undefined }),
  })
  .map(({ question, results, locale, damage }) => {
    const turns: unknown[] = [
      { role: "user", content: question },
      ...results.flatMap((result, index) => round(`call-${String(index)}`, result)),
    ];
    if (damage !== undefined && damage.at < turns.length) {
      turns[damage.at] = damage.with;
    }
    return { contractVersion: 1, context: { locale }, messages: turns, message: question };
  });
const raws = fc.oneof(
  chatBodies.map((body) => JSON.stringify(body ?? null)),
  sound.map((body) => JSON.stringify(body)),
  fc.string({ unit: "binary", maxLength: 100 }),
  fc.integer({ min: 1, max: 20_000 }).map((depth) => "[".repeat(depth)),
);

const textsIn = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(textsIn);
  }
  return typeof value === "object" && value !== null ? Object.values(value).flatMap(textsIn) : [];
};

describe("plain conversation body under hostile text", () => {
  it("answers anything with a 400 or a conversation inside its limits", () => {
    const bodies = fc.oneof(
      fc.record({ messages: fc.oneof(messages, junk) }).map((body) => JSON.stringify(body)),
      raws,
    );
    fc.assert(
      fc.property(bodies, (raw) => {
        const parsed = rejectedOr(() => parseConversation(raw, LIMITS));
        if (parsed === null) {
          return;
        }
        expect(raw.length).toBeLessThanOrEqual(LIMITS.maxBodyBytes);
        expect(parsed.length).toBeLessThanOrEqual(LIMITS.maxMessages);
        expect(parsed[0]?.role).toBe("user");
        expect(parsed.at(-1)?.role).toBe("user");
        for (const message of parsed) {
          const cap = message.role === "user" ? LIMITS.maxUserChars : LIMITS.maxAssistantChars;
          expect(message.content.length).toBeLessThanOrEqual(cap);
          expect(message.content).not.toBe("");
          expect(hasControls(message.content)).toBe(false);
        }
      }),
      { numRuns: 4000 },
    );
  });
});

describe("chat body under hostile text", () => {
  const stateless = agentOf("stateless");
  const stored = agentOf("stored");
  const known = new Set(
    stateless.contracts.flatMap((contract) => contract.tools.map((tool) => tool.name)),
  );

  it("answers anything with a 400 or a conversation inside the agent's limits", () => {
    let accepted = 0;
    fc.assert(
      fc.property(raws, (raw) => {
        const parsed = rejectedOr(() => parseChat(raw, stateless));
        if (parsed === null) {
          return;
        }
        accepted += 1;
        const { input } = stateless;
        expect(conversationChars(parsed.messages, input.imageChars)).toBeLessThanOrEqual(
          input.maxConversationChars,
        );
        expect(Number.isInteger(parsed.toolRounds) && parsed.toolRounds >= 0).toBe(true);
        expect(parsed.messages.at(-1)?.role).toBe("user");
        expect(textsIn(parsed.messages).some((text) => hasControls(text))).toBe(false);
        for (const message of parsed.messages) {
          const used = typeof message.content === "string" ? [] : message.content;
          for (const block of used) {
            expect(block.type !== "tool_use" || known.has(block.name)).toBe(true);
          }
        }
      }),
      { numRuns: 6000 },
    );
    expect(accepted).toBeGreaterThan(0);
  });

  it("answers any stored turn with a 400 or one well-formed input", () => {
    fc.assert(
      fc.property(raws, (raw) => {
        const parsed = rejectedOr(() => parseStoredTurn(raw, stored));
        if (parsed === null) {
          return;
        }
        expect(parsed.sessionId ?? "00000000").toMatch(/^[A-Za-z0-9-]{8,64}$/);
        if (parsed.input.kind === "message") {
          expect(textsIn(parsed.input.content).some((text) => hasControls(text))).toBe(false);
        }
      }),
      { numRuns: 6000 },
    );
  });
});
