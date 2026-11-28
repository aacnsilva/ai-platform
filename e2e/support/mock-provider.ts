import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

export interface RecordedCall {
  model: string;
  stream: boolean;
  question: string;
  systemChars: number;
  systemTail: string[];
  cacheMarked: boolean;
  hasSchema: boolean;
  lastRole: string;
  messageCount: number;
  toolNames: string[];
  thinking: string | null;
  cancelled: boolean;
  tookMs: number;
}

export interface MockProvider {
  url: string;
  calls: RecordedCall[];
  close: () => Promise<void>;
}

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

interface Scenario {
  status: number;
  text: string;
  stopReason: string;
  breakMidStream: boolean;
  chunkDelayMs: number;
  tool: ToolCall | null;
}

type Content = string | { type: string; text?: string; content?: string }[];

interface ProviderRequest {
  model: string;
  stream?: boolean;
  system?: { text: string; cache_control?: unknown }[];
  messages: { role: string; content: Content }[];
  output_config?: { format?: unknown };
  tools?: { name: string }[];
  thinking?: { type: string };
}

const USAGE = { input_tokens: 40, output_tokens: 25, cache_read_input_tokens: 5000 };
const CHUNK_CHARS = 9;
const FIRST_TOKEN_DELAY_MS = 30;
const CHUNK_DELAY_MS = 2;
const SLOW_CHUNK_DELAY_MS = 60;
const TOOL_PATTERN = /(?:TOOLCALL|LOOP|TWOSTEP) (\w+)(?: (\w+)=(.+))?/;
const VECTOR_SIZE = 48;
const GUIDES: Record<string, unknown> = {
  intro: {
    slug: "intro",
    title: "Fixing a flat",
    body: "Take the wheel off before the tyre. MARKER-GUIDE-INTRO",
  },
};

const gated = (onTopic: boolean, answer: string): string =>
  JSON.stringify({ on_topic: onTopic, answer });

const textOf = (content: Content): string =>
  typeof content === "string" ? content : content.map((block) => block.text ?? "").join("");

const isToolResults = (content: Content): boolean =>
  typeof content !== "string" && content.some((block) => block.type === "tool_result");

const lastQuestion = (body: ProviderRequest): string =>
  body.messages
    .filter((message) => message.role === "user" && !isToolResults(message.content))
    .at(-1)?.content === undefined
    ? ""
    : textOf(
        body.messages
          .filter((message) => message.role === "user" && !isToolResults(message.content))
          .at(-1)?.content ?? "",
      );

const roundsSinceQuestion = (body: ProviderRequest): number => {
  let rounds = 0;
  for (const message of body.messages) {
    if (message.role !== "user") {
      continue;
    }
    rounds = isToolResults(message.content) ? rounds + 1 : 0;
  }
  return rounds;
};

const latestToolResult = (body: ProviderRequest): string => {
  const last = body.messages.at(-1)?.content;
  if (last === undefined || typeof last === "string") {
    return "";
  }
  return last.map((block) => block.content ?? "").join(" | ");
};

const toolCallFor = (question: string, rounds: number): ToolCall | null => {
  const match = TOOL_PATTERN.exec(question);
  if (match?.[1] === undefined) {
    return null;
  }
  const allowedRounds = question.includes("LOOP") ? Infinity : question.includes("TWOSTEP") ? 2 : 1;
  if (rounds >= allowedRounds) {
    return null;
  }
  const input =
    match[2] === undefined || match[3] === undefined
      ? {}
      : match[2] === "json"
        ? (JSON.parse(match[3].trim()) as Record<string, unknown>)
        : { [match[2]]: match[3].trim() };
  return { name: match[1], input };
};

const base: Scenario = {
  status: 200,
  text: "",
  stopReason: "end_turn",
  breakMidStream: false,
  chunkDelayMs: CHUNK_DELAY_MS,
  tool: null,
};

const chatScenario = (body: ProviderRequest, question: string): Scenario => {
  const rounds = roundsSinceQuestion(body);
  const tool = toolCallFor(question, rounds);
  if (tool !== null) {
    return { ...base, text: "Let me look that up.", stopReason: "tool_use", tool };
  }
  if (rounds > 0) {
    return { ...base, text: `The tool said: ${latestToolResult(body).slice(0, 600)}` };
  }
  return {
    ...base,
    chunkDelayMs: question.includes("SLOW") ? SLOW_CHUNK_DELAY_MS : CHUNK_DELAY_MS,
    text: `Answer to: ${question}. ${"This sentence pads the answer so it streams. ".repeat(4)}`,
  };
};

const scenarioFor = (body: ProviderRequest): Scenario => {
  const question = lastQuestion(body);
  if (question.includes("UPSTREAM500")) {
    return { ...base, status: 500 };
  }
  if (question.includes("REFUSAL")) {
    return { ...base, stopReason: "refusal" };
  }
  if (body.output_config?.format === undefined) {
    return chatScenario(body, question);
  }
  if (question.includes("OFFTOPIC")) {
    return { ...base, text: gated(false, "I cannot help with that.") };
  }
  if (question.includes("GARBAGE")) {
    return { ...base, text: "this is not the reply shape" };
  }
  if (question.includes("BREAK")) {
    return { ...base, text: gated(true, "This answer breaks half way."), breakMidStream: true };
  }
  return { ...base, text: gated(true, `Answer to: ${question} — with "quotes" and\na newline.`) };
};

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const describe = (body: ProviderRequest): RecordedCall => {
  const system = body.system ?? [];
  return {
    model: body.model,
    stream: body.stream === true,
    question: lastQuestion(body),
    systemChars: system[0]?.text.length ?? 0,
    systemTail: system.slice(1).map((block) => block.text),
    cacheMarked: system.some((block) => block.cache_control !== undefined),
    hasSchema: body.output_config?.format !== undefined,
    lastRole: body.messages.at(-1)?.role ?? "",
    messageCount: body.messages.length,
    toolNames: (body.tools ?? []).map((tool) => tool.name),
    thinking: body.thinking?.type ?? null,
    cancelled: false,
    tookMs: 0,
  };
};

const contentOf = (scenario: Scenario): Record<string, unknown>[] => [
  ...(scenario.text === "" ? [] : [{ type: "text", text: scenario.text }]),
  ...(scenario.tool === null
    ? []
    : [
        {
          type: "tool_use",
          id: `toolu_${String(Date.now())}${String(Math.floor(Math.random() * 1e6))}`,
          ...scenario.tool,
        },
      ]),
];

const messageOf = (model: string, scenario: Scenario): Record<string, unknown> => ({
  id: "msg_mock",
  type: "message",
  role: "assistant",
  model,
  content: contentOf(scenario),
  stop_reason: scenario.stopReason,
  stop_sequence: null,
  usage: USAGE,
});

const chunksOf = (text: string): string[] =>
  Array.from({ length: Math.ceil(text.length / CHUNK_CHARS) }, (_, index) =>
    text.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS),
  );

const writeEvent = (
  response: ServerResponse,
  type: string,
  data: Record<string, unknown>,
): void => {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
};

const streamText = async (response: ServerResponse, scenario: Scenario): Promise<boolean> => {
  writeEvent(response, "content_block_start", {
    index: 0,
    content_block: { type: "text", text: "" },
  });
  await sleep(FIRST_TOKEN_DELAY_MS);
  const chunks = chunksOf(scenario.text);
  for (const [index, chunk] of chunks.entries()) {
    if (scenario.breakMidStream && index === Math.floor(chunks.length / 2)) {
      response.destroy();
      return false;
    }
    writeEvent(response, "content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: chunk },
    });
    await sleep(scenario.chunkDelayMs);
    if (response.destroyed) {
      return false;
    }
  }
  writeEvent(response, "content_block_stop", { index: 0 });
  return true;
};

const streamTool = (response: ServerResponse, tool: ToolCall, index: number): void => {
  writeEvent(response, "content_block_start", {
    index,
    content_block: {
      type: "tool_use",
      id: `toolu_${String(Date.now())}`,
      name: tool.name,
      input: {},
    },
  });
  writeEvent(response, "content_block_delta", {
    index,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) },
  });
  writeEvent(response, "content_block_stop", { index });
};

const streamReply = async (
  response: ServerResponse,
  model: string,
  scenario: Scenario,
): Promise<void> => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  writeEvent(response, "message_start", {
    message: { ...messageOf(model, scenario), content: [], stop_reason: null },
  });
  if (scenario.text !== "" && !(await streamText(response, scenario))) {
    return;
  }
  if (scenario.tool !== null) {
    streamTool(response, scenario.tool, scenario.text === "" ? 0 : 1);
  }
  writeEvent(response, "message_delta", {
    delta: { stop_reason: scenario.stopReason, stop_sequence: null },
    usage: { output_tokens: USAGE.output_tokens },
  });
  writeEvent(response, "message_stop", {});
  response.end();
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json", "x-should-retry": "false" });
  response.end(JSON.stringify(body));
};

const vectorOf = (text: string): number[] => {
  const vector = new Array<number>(VECTOR_SIZE).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 0;
    for (const char of word) {
      hash = (hash * 31 + char.charCodeAt(0)) % VECTOR_SIZE;
    }
    vector[hash] = (vector[hash] ?? 0) + 1;
  }
  return vector;
};

const handleEmbeddings = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const body = JSON.parse(await readBody(request)) as { input: string[] };
  sendJson(response, 200, { data: body.input.map((text) => ({ embedding: vectorOf(text) })) });
};

const handleGuide = (url: string, response: ServerResponse): void => {
  const slug = /^\/guides\/([a-z0-9-]+)\.json$/.exec(url)?.[1] ?? "";
  const guide = GUIDES[slug];
  sendJson(response, guide === undefined ? 404 : 200, guide ?? { error: "not_found" });
};

const handleMessages = async (
  request: IncomingMessage,
  response: ServerResponse,
  calls: RecordedCall[],
): Promise<void> => {
  const body = JSON.parse(await readBody(request)) as ProviderRequest;
  const call = describe(body);
  calls.push(call);
  const startedAt = performance.now();
  response.on("close", () => {
    call.cancelled = !response.writableEnded;
    call.tookMs = performance.now() - startedAt;
  });
  const scenario = scenarioFor(body);
  if (scenario.status !== 200) {
    sendJson(response, scenario.status, {
      type: "error",
      error: { type: "api_error", message: "mock" },
    });
    return;
  }
  if (call.stream) {
    await streamReply(response, body.model, scenario);
    return;
  }
  sendJson(response, 200, messageOf(body.model, scenario));
};

const handle = async (
  request: IncomingMessage,
  response: ServerResponse,
  calls: RecordedCall[],
): Promise<void> => {
  const url = request.url ?? "";
  if (url === "/__calls") {
    sendJson(response, 200, calls);
    return;
  }
  if (url === "/embeddings") {
    await handleEmbeddings(request, response);
    return;
  }
  if (url.startsWith("/guides/")) {
    handleGuide(url, response);
    return;
  }
  await handleMessages(request, response, calls);
};

const listen = async (server: Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

export const startMockProvider = async (): Promise<MockProvider> => {
  const calls: RecordedCall[] = [];
  const server = createServer((request, response) => {
    handle(request, response, calls).catch(() => {
      response.destroy();
    });
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${String(port)}`,
    calls,
    close: async () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
};
