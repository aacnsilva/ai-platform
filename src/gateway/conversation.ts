import { utf8ByteLength } from "../http/read-body";
import { Rejection } from "../http/respond";
import type { ChatMessage } from "../llm/provider";
import type { InputLimits } from "../tenants/schema";

const KEPT_CONTROL_CODES = new Set([0x09, 0x0a, 0x0d]);

const isPrintable = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return code > 0x1f || KEPT_CONTROL_CODES.has(code);
};

const clean = (text: string): string => Array.from(text).filter(isPrintable).join("").trim();

const reject = (code: string): never => {
  throw new Rejection(400, code);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readMessages = (body: unknown, limits: InputLimits): unknown[] => {
  if (!isRecord(body) || !Array.isArray(body["messages"])) {
    return reject("missing_messages");
  }
  const messages: unknown[] = body["messages"];
  return messages.length === 0 || messages.length > limits.maxMessages
    ? reject("bad_length")
    : messages;
};

const readRole = (message: unknown): ChatMessage["role"] => {
  const role = isRecord(message) ? message["role"] : undefined;
  return role === "user" || role === "assistant" ? role : reject("bad_role");
};

const readContent = (message: unknown): string => {
  const content = isRecord(message) ? message["content"] : undefined;
  return typeof content === "string" ? clean(content) : reject("bad_content");
};

const cleanMessage = (message: unknown, limits: InputLimits): ChatMessage => {
  const role = readRole(message);
  const content = readContent(message);
  if (role === "assistant") {
    return { role, content: content.slice(0, limits.maxAssistantChars) };
  }
  return content.length > limits.maxUserChars ? reject("question_too_long") : { role, content };
};

const fromFirstQuestion = (messages: ChatMessage[]): ChatMessage[] => {
  const first = messages.findIndex((message) => message.role === "user");
  return first === -1 ? [] : messages.slice(first);
};

export const parseConversation = (raw: string, limits: InputLimits): ChatMessage[] => {
  if (utf8ByteLength(raw) > limits.maxBodyBytes) {
    return reject("too_large");
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reject("bad_json");
  }
  const cleaned = readMessages(body, limits)
    .map((message) => cleanMessage(message, limits))
    .filter((message) => message.content !== "");
  const messages = fromFirstQuestion(cleaned);
  return messages.at(-1)?.role === "user" ? messages : reject("missing_question");
};

export const conversationChars = (messages: readonly ChatMessage[]): number =>
  messages.reduce((total, message) => total + message.content.length, 0);

export const latestQuestion = (messages: readonly ChatMessage[]): string =>
  messages.at(-1)?.content ?? "";
