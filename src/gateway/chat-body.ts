import { utf8ByteLength } from "../http/read-body";
import { Rejection } from "../http/respond";
import type {
  MessageBlock,
  ModelMessage,
  ReplyBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "../llm/provider";
import type { ChatAgent, ChatInputLimits, ContextField, Contract } from "../tenants/schema";

export type ChatContext = Record<string, string | string[]>;

export interface ParsedChat {
  messages: ModelMessage[];
  context: ChatContext;
  contract: Contract;
  contractHash: string | undefined;
  hasImage: boolean;
  toolRounds: number;
}

export interface ReadRules {
  limits: ChatInputLimits;
  toolNames: ReadonlySet<string>;
  allowsImage: boolean;
}

interface Question {
  content: string | MessageBlock[];
  hasImage: boolean;
}

const TOOL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const KEPT_CONTROL_CODES = new Set([0x09, 0x0a, 0x0d]);

export const reject = (code: string): never => {
  throw new Rejection(400, code);
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasControls = (text: string): boolean =>
  Array.from(text).some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f && !KEPT_CONTROL_CODES.has(code);
  });

const cleanText = (value: unknown, code: string): string =>
  typeof value === "string" && !hasControls(value) ? value.trim() : reject(code);

export const parseBody = (raw: string, maxBytes: number): Record<string, unknown> => {
  if (utf8ByteLength(raw) > maxBytes) {
    return reject("too_large");
  }
  try {
    const body: unknown = JSON.parse(raw);
    return isRecord(body) ? body : reject("bad_json");
  } catch (error) {
    return error instanceof Rejection ? reject(error.code) : reject("bad_json");
  }
};

export const contractOf = (agent: ChatAgent, version: unknown): Contract =>
  agent.contracts.find((contract) => contract.version === version) ?? reject("contract_version");

export const rulesFor = (agent: ChatAgent, contract: Contract): ReadRules => ({
  limits: agent.input,
  toolNames: new Set(contract.tools.map((tool) => tool.name)),
  allowsImage: contract.allowsImages && agent.input.maxImageBytes > 0,
});

const readToolUse = (
  block: Record<string, unknown>,
  seen: Set<string>,
  rules: ReadRules,
): ToolUseBlock => {
  const { id, name, input } = block;
  if (!isRecord(input)) {
    return reject("bad_tool_input");
  }
  if (JSON.stringify(input).length > rules.limits.maxToolInputChars) {
    return reject("tool_input_too_long");
  }
  if (typeof id !== "string" || !TOOL_ID.test(id) || seen.has(id)) {
    return reject("bad_tool_id");
  }
  if (typeof name !== "string" || !rules.toolNames.has(name)) {
    return reject("unknown_tool");
  }
  seen.add(id);
  return { type: "tool_use", id, name, input };
};

const readReplyText = (value: unknown, rules: ReadRules): string => {
  const text = cleanText(value, "bad_content");
  return text === "" || text.length > rules.limits.maxReplyChars ? reject("bad_content") : text;
};

const readReplyBlock = (block: unknown, seen: Set<string>, rules: ReadRules): ReplyBlock => {
  if (!isRecord(block)) {
    return reject("bad_content");
  }
  if (block["type"] === "text") {
    return { type: "text", text: readReplyText(block["text"], rules) };
  }
  return block["type"] === "tool_use" ? readToolUse(block, seen, rules) : reject("bad_content");
};

const readAssistant = (
  content: unknown,
  seen: Set<string>,
  rules: ReadRules,
): string | ReplyBlock[] => {
  if (typeof content === "string") {
    return readReplyText(content, rules);
  }
  if (!Array.isArray(content) || content.length === 0 || content.length > rules.limits.maxBlocks) {
    return reject("bad_content");
  }
  return content.map((block) => readReplyBlock(block, seen, rules));
};

const readToolResult = (
  block: unknown,
  expected: readonly string[],
  limits: ChatInputLimits,
): ToolResultBlock => {
  if (!isRecord(block) || block["type"] !== "tool_result") {
    return reject("bad_tool_result");
  }
  const id = block["tool_use_id"];
  const isError = block["is_error"];
  if (typeof id !== "string" || !expected.includes(id)) {
    return reject("bad_tool_result");
  }
  if (isError !== undefined && typeof isError !== "boolean") {
    return reject("bad_tool_result");
  }
  const content = cleanText(block["content"], "bad_tool_result");
  if (content === "" || content.length > limits.maxToolResultChars) {
    return reject("bad_tool_result");
  }
  return {
    type: "tool_result",
    tool_use_id: id,
    content,
    ...(isError === true ? { is_error: true } : {}),
  };
};

export const readToolResults = (
  content: unknown,
  expected: readonly string[],
  limits: ChatInputLimits,
): ToolResultBlock[] => {
  if (!Array.isArray(content) || content.length !== expected.length) {
    return reject("bad_tool_result");
  }
  const results = content.map((block) => readToolResult(block, expected, limits));
  const answered = new Set(results.map((result) => result.tool_use_id));
  return answered.size === expected.length ? results : reject("bad_tool_result");
};

const readQuestionText = (content: unknown, limits: ChatInputLimits): string => {
  const text = cleanText(content, "bad_content");
  if (text === "") {
    return reject("missing_question");
  }
  return text.length > limits.maxQuestionChars ? reject("question_too_long") : text;
};

const decodedLength = (data: string): number => {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
};

const isJpeg = (data: string): boolean => {
  const head = atob(data.slice(0, 4));
  return head.charCodeAt(0) === 0xff && head.charCodeAt(1) === 0xd8 && head.charCodeAt(2) === 0xff;
};

const readImageData = (image: unknown, limits: ChatInputLimits): string => {
  if (!isRecord(image) || image["type"] !== "image" || image["media_type"] !== "image/jpeg") {
    return reject("bad_image");
  }
  const data = image["data"];
  if (typeof data !== "string" || data.length < 8 || data.length % 4 !== 0 || !BASE64.test(data)) {
    return reject("bad_image");
  }
  if (decodedLength(data) > limits.maxImageBytes) {
    return reject("image_too_large");
  }
  return isJpeg(data) ? data : reject("bad_image");
};

const readPhotoQuestion = (content: readonly unknown[], limits: ChatInputLimits): Question => {
  const [image, question, ...rest] = content;
  if (rest.length > 0 || !isRecord(question) || question["type"] !== "text") {
    return reject("bad_content");
  }
  const data = readImageData(image, limits);
  const text = readQuestionText(question["text"], limits);
  return {
    hasImage: true,
    content: [
      { type: "image", mediaType: "image/jpeg", data },
      { type: "text", text },
    ],
  };
};

export const readQuestion = (content: unknown, rules: ReadRules): Question => {
  if (Array.isArray(content)) {
    return rules.allowsImage ? readPhotoQuestion(content, rules.limits) : reject("bad_content");
  }
  return { hasImage: false, content: readQuestionText(content, rules.limits) };
};

const blockChars = (block: MessageBlock, imageChars: number): number => {
  switch (block.type) {
    case "text":
      return block.text.length;
    case "tool_result":
      return block.content.length;
    case "image":
      return imageChars;
    case "tool_use":
      return JSON.stringify(block.input).length + block.name.length;
  }
};

export const conversationChars = (messages: readonly ModelMessage[], imageChars: number): number =>
  messages.reduce((total, message) => {
    if (typeof message.content === "string") {
      return total + message.content.length;
    }
    return total + message.content.reduce((sum, block) => sum + blockChars(block, imageChars), 0);
  }, 0);

interface Fold {
  messages: ModelMessage[];
  seen: Set<string>;
  pending: string[] | null;
  askedAt: number;
  imageAt: number;
}

const toolIdsOf = (content: string | ReplyBlock[]): string[] =>
  typeof content === "string"
    ? []
    : content.flatMap((block) => (block.type === "tool_use" ? [block.id] : []));

const foldUser = (fold: Fold, content: unknown, rules: ReadRules): void => {
  const index = fold.messages.length;
  if (fold.pending !== null) {
    fold.messages.push({
      role: "user",
      content: readToolResults(content, fold.pending, rules.limits),
    });
    fold.pending = null;
    return;
  }
  const question = readQuestion(content, rules);
  if (question.hasImage && fold.imageAt >= 0) {
    reject("bad_image");
  }
  fold.askedAt = index;
  fold.imageAt = question.hasImage ? index : fold.imageAt;
  fold.messages.push({ role: "user", content: question.content });
};

const foldAssistant = (fold: Fold, content: unknown, rules: ReadRules): void => {
  if (fold.pending !== null) {
    reject("bad_tool_result");
  }
  const read = readAssistant(content, fold.seen, rules);
  const toolIds = toolIdsOf(read);
  fold.pending = toolIds.length > 0 ? toolIds : null;
  fold.messages.push({ role: "assistant", content: read });
};

const foldMessage = (fold: Fold, message: unknown, rules: ReadRules): void => {
  const expected = fold.messages.at(-1)?.role === "user" ? "assistant" : "user";
  if (!isRecord(message) || message["role"] !== expected) {
    reject("bad_role");
    return;
  }
  if (expected === "user") {
    foldUser(fold, message["content"], rules);
  } else {
    foldAssistant(fold, message["content"], rules);
  }
};

const readMessages = (value: unknown, rules: ReadRules): Fold => {
  if (!Array.isArray(value) || value.length === 0 || value.length > rules.limits.maxMessages) {
    return reject("bad_length");
  }
  const fold: Fold = { messages: [], seen: new Set(), pending: null, askedAt: -1, imageAt: -1 };
  for (const message of value) {
    foldMessage(fold, message, rules);
  }
  if (fold.pending !== null) {
    return reject("bad_tool_result");
  }
  if (fold.messages.at(-1)?.role !== "user") {
    return reject("missing_question");
  }
  return fold.imageAt >= 0 && fold.imageAt !== fold.askedAt ? reject("bad_image") : fold;
};

const readItem = (value: unknown, field: ContextField): string => {
  const text = cleanText(value, "bad_context");
  const fits = text !== "" && text.length <= field.maxChars;
  const matches = field.pattern === undefined || new RegExp(field.pattern).test(text);
  const allowed = field.allowed === undefined || field.allowed.includes(text);
  return fits && matches && allowed ? text : reject("bad_context");
};

const readList = (value: unknown, field: ContextField): string[] => {
  if (!Array.isArray(value) || value.length > field.maxItems) {
    return reject("bad_context");
  }
  const items = value.map((item) => readItem(item, field));
  return new Set(items).size === items.length ? items : reject("bad_context");
};

export const readContext = (fields: readonly ContextField[], value: unknown): ChatContext => {
  const given = value === undefined ? {} : value;
  if (!isRecord(given)) {
    return reject("bad_context");
  }
  const context: ChatContext = {};
  for (const field of fields) {
    const raw = given[field.name];
    if (raw === undefined) {
      if (field.required) {
        reject("bad_context");
      }
      continue;
    }
    context[field.name] = field.kind === "list" ? readList(raw, field) : readItem(raw, field);
  }
  return context;
};

const readHash = (value: unknown): string | undefined =>
  value === undefined || typeof value === "string" ? value : reject("contract_hash");

export const parseChat = (raw: string, agent: ChatAgent): ParsedChat => {
  const body = parseBody(raw, agent.input.maxBodyBytes);
  const contract = contractOf(agent, body["contractVersion"]);
  const context = readContext(agent.context, body["context"]);
  const fold = readMessages(body["messages"], rulesFor(agent, contract));
  if (conversationChars(fold.messages, agent.input.imageChars) > agent.input.maxConversationChars) {
    return reject("too_long");
  }
  return {
    messages: fold.messages,
    context,
    contract,
    contractHash: readHash(body["contractHash"]),
    hasImage: fold.imageAt >= 0,
    toolRounds: (fold.messages.length - 1 - fold.askedAt) / 2,
  };
};

export type StoredInput =
  { kind: "message"; content: string | MessageBlock[] } | { kind: "tool_results"; raw: unknown };

export interface StoredTurn {
  sessionId: string | undefined;
  context: ChatContext;
  contract: Contract;
  contractHash: string | undefined;
  input: StoredInput;
}

const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

const readSessionId = (value: unknown): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" && SESSION_ID.test(value) ? value : reject("bad_session");
};

const readStoredInput = (body: Record<string, unknown>, rules: ReadRules): StoredInput => {
  if (body["toolResults"] !== undefined && body["message"] !== undefined) {
    return reject("bad_content");
  }
  if (body["toolResults"] !== undefined) {
    return { kind: "tool_results", raw: body["toolResults"] };
  }
  if (body["message"] === undefined) {
    return reject("missing_question");
  }
  return { kind: "message", content: readQuestion(body["message"], rules).content };
};

export const parseStoredTurn = (raw: string, agent: ChatAgent): StoredTurn => {
  const body = parseBody(raw, agent.input.maxBodyBytes);
  const contract = contractOf(agent, body["contractVersion"]);
  return {
    sessionId: readSessionId(body["sessionId"]),
    context: readContext(agent.context, body["context"]),
    contract,
    contractHash: readHash(body["contractHash"]),
    input: readStoredInput(body, rulesFor(agent, contract)),
  };
};
