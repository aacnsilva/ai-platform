import Anthropic from "@anthropic-ai/sdk";

import type { ModelId } from "./catalog";
import { MODELS } from "./catalog";
import type { Usage } from "./cost";
import type {
  FailureKind,
  Listeners,
  MessageBlock,
  ModelMessage,
  ModelReply,
  ModelRequest,
  Provider,
  ReplyBlock,
} from "./provider";

const FIRST_BYTE_TIMEOUT_MS = 20_000;
const STREAM_IDLE_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 0;
const RETRYABLE_STATUSES = new Set([408, 409, 429]);
const CACHED = { type: "ephemeral" } as const;

export interface AnthropicSettings {
  apiKey: string;
  baseURL: string | undefined;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  firstByteTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
}

export class StreamStalled extends Error {
  constructor() {
    super("stream_stalled");
  }
}

type Params = Anthropic.MessageCreateParamsNonStreaming;

const blockParam = (block: MessageBlock): Anthropic.ContentBlockParam => {
  if (block.type === "image") {
    return {
      type: "image",
      source: { type: "base64", media_type: block.mediaType, data: block.data },
    };
  }
  return block;
};

const messageParam = (message: ModelMessage): Anthropic.MessageParam => ({
  role: message.role,
  content: typeof message.content === "string" ? message.content : message.content.map(blockParam),
});

const messagesFor = (request: ModelRequest): Anthropic.MessageParam[] => [
  ...request.messages.map(messageParam),
  ...(request.trailingReminder === undefined
    ? []
    : [{ role: "system" as const, content: request.trailingReminder }]),
];

const systemFor = (request: ModelRequest): Anthropic.TextBlockParam[] => [
  { type: "text", text: request.system, cache_control: CACHED },
  ...request.systemTail.map((text) => ({ type: "text" as const, text })),
];

const toolsFor = (request: ModelRequest): Pick<Params, "tools" | "tool_choice"> =>
  request.tools.length === 0
    ? {}
    : {
        tools: request.tools.map((tool, index) => ({
          name: tool.name,
          description: tool.description,
          input_schema: { type: "object" as const, ...tool.input_schema },
          ...(index === request.tools.length - 1 ? { cache_control: CACHED } : {}),
        })),
        tool_choice: { type: "auto" },
      };

const paramsFor = (model: ModelId, request: ModelRequest): Params => ({
  model,
  max_tokens: request.maxOutputTokens,
  system: systemFor(request),
  messages: messagesFor(request),
  ...toolsFor(request),
  ...(request.thinking === "off" ? { thinking: MODELS[model].thinkingOff } : {}),
  output_config: {
    effort: request.effort,
    ...(request.replySchema === undefined
      ? {}
      : { format: { type: "json_schema" as const, schema: request.replySchema } }),
  },
});

const usageOf = (usage: Anthropic.Usage): Usage => ({
  input: usage.input_tokens,
  output: usage.output_tokens,
  cacheWrite: usage.cache_creation_input_tokens ?? 0,
  cacheRead: usage.cache_read_input_tokens ?? 0,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const replyBlocks = (message: Anthropic.Message): ReplyBlock[] =>
  message.content.flatMap((block): ReplyBlock[] => {
    if (block.type === "text") {
      return block.text.trim() === "" ? [] : [{ type: "text", text: block.text }];
    }
    if (block.type === "tool_use") {
      const input = isRecord(block.input) ? block.input : {};
      return [{ type: "tool_use", id: block.id, name: block.name, input }];
    }
    return [];
  });

const replyOf = (message: Anthropic.Message): ModelReply => {
  const blocks = replyBlocks(message);
  return {
    blocks,
    text: blocks.map((block) => (block.type === "text" ? block.text : "")).join(""),
    stopReason: message.stop_reason,
    usage: usageOf(message.usage),
  };
};

const isToolStart = (event: Anthropic.MessageStreamEvent): boolean =>
  event.type === "content_block_start" && event.content_block.type === "tool_use";

const failureKindOf = (error: unknown): FailureKind => {
  if (error instanceof StreamStalled || error instanceof Anthropic.APIConnectionTimeoutError) {
    return "timeout";
  }
  if (error instanceof Anthropic.APIUserAbortError) {
    return "aborted";
  }
  if (!(error instanceof Anthropic.APIError) || typeof error.status !== "number") {
    return "unavailable";
  }
  const isClientError = error.status >= 400 && error.status < 500;
  return isClientError && !RETRYABLE_STATUSES.has(error.status) ? "rejected" : "unavailable";
};

interface Watch {
  touch: () => void;
  stop: () => void;
  hasStalled: () => boolean;
}

const watchForSilence = (idleMs: number, onSilence: () => void): Watch => {
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    clearTimeout(timer);
  };
  const touch = (): void => {
    stop();
    timer = setTimeout(() => {
      stalled = true;
      onSilence();
    }, idleMs);
  };
  return { touch, stop, hasStalled: () => stalled };
};

export const createAnthropicProvider = (settings: AnthropicSettings): Provider => {
  const client = new Anthropic({
    apiKey: settings.apiKey,
    timeout: settings.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    ...(settings.baseURL === undefined ? {} : { baseURL: settings.baseURL }),
    ...(settings.fetch === undefined ? {} : { fetch: settings.fetch }),
  });
  const idleMs = settings.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;

  const streamed = async (params: Params, listeners: Listeners): Promise<Anthropic.Message> => {
    const stream = client.messages.stream(
      params,
      settings.signal === undefined ? {} : { signal: settings.signal },
    );
    const watch = watchForSilence(idleMs, () => {
      stream.abort();
    });
    try {
      return await stream
        .on("connect", watch.touch)
        .on("text", (text) => listeners.onText?.(text))
        .on("streamEvent", (event) => {
          watch.touch();
          if (isToolStart(event)) {
            listeners.onTool?.();
          }
        })
        .finalMessage();
    } catch (error) {
      throw watch.hasStalled() ? new StreamStalled() : error;
    } finally {
      watch.stop();
    }
  };

  const complete = async (
    model: ModelId,
    request: ModelRequest,
    listeners: Listeners,
  ): Promise<ModelReply> => replyOf(await streamed(paramsFor(model, request), listeners));

  return {
    complete,
    failureKind: (error) => (settings.signal?.aborted === true ? "aborted" : failureKindOf(error)),
  };
};
