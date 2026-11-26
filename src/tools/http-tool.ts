export interface ToolOutput {
  content: string;
  isError: boolean;
}

export interface HttpToolOptions {
  allowedHosts: readonly string[];
  maxChars: number;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;
const SAFE_VALUE = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_QUERY_VALUE_CHARS = 200;
const AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;
const ENCODED_DOT = /%2e/gi;
const TIMEOUT_MS = 5000;
const BYTES_PER_CHAR = 4;

const failed = (content: string): ToolOutput => ({ content, isError: true });

const safeText = (value: unknown): string | null => {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && SAFE_VALUE.test(text) && !text.includes("..") ? text : null;
};

const hasControls = (text: string): boolean =>
  Array.from(text).some((char) => char.charCodeAt(0) <= 0x1f || char.charCodeAt(0) === 0x7f);

const safeQueryText = (value: unknown): string | null => {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== "string") {
    return null;
  }
  const trimmed = text.trim();
  return trimmed !== "" && trimmed.length <= MAX_QUERY_VALUE_CHARS && !hasControls(trimmed)
    ? trimmed
    : null;
};

const fillPart = (
  part: string,
  input: Record<string, unknown>,
  reader: (value: unknown) => string | null,
): string | null => {
  const names = Array.from(part.matchAll(PLACEHOLDER), (match) => match[1] ?? "");
  if (names.some((name) => reader(input[name]) === null)) {
    return null;
  }
  return part.replaceAll(PLACEHOLDER, (_match, name: string) =>
    encodeURIComponent(reader(input[name]) ?? ""),
  );
};

const fill = (template: string, input: Record<string, unknown>): string | null => {
  const queryAt = template.indexOf("?");
  if (queryAt === -1) {
    return fillPart(template, input, safeText);
  }
  const base = fillPart(template.slice(0, queryAt), input, safeText);
  const query = fillPart(template.slice(queryAt + 1), input, safeQueryText);
  return base === null || query === null ? null : `${base}?${query}`;
};

const hasDotSegment = (filled: string): boolean => {
  const [path = ""] = filled.replace(AUTHORITY, "").split(/[?#]/);
  const segments = path.replaceAll(ENCODED_DOT, ".").split("/");
  return segments.some((segment) => segment === "." || segment === "..");
};

export const resolveUrl = (
  template: string,
  input: Record<string, unknown>,
  allowedHosts: readonly string[],
): URL | null => {
  const filled = fill(template, input);
  if (filled === null || hasDotSegment(filled) || !URL.canParse(filled)) {
    return null;
  }
  const url = new URL(filled);
  return allowedHosts.includes(url.hostname) ? url : null;
};

const readCapped = async (response: Response, maxBytes: number): Promise<string> => {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  try {
    while (received < maxBytes) {
      const chunk: ReadableStreamReadResult<unknown> = await reader.read();
      if (chunk.done || !(chunk.value instanceof Uint8Array)) {
        break;
      }
      const remaining = maxBytes - received;
      const slice =
        chunk.value.byteLength > remaining ? chunk.value.subarray(0, remaining) : chunk.value;
      received += slice.byteLength;
      text += decoder.decode(slice, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text + decoder.decode();
};

const fetchSignal = (caller: AbortSignal | undefined): AbortSignal => {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return caller === undefined ? timeout : AbortSignal.any([caller, timeout]);
};

export const runHttpTool = async (
  template: string,
  input: Record<string, unknown>,
  options: HttpToolOptions,
): Promise<ToolOutput> => {
  const url = resolveUrl(template, input, options.allowedHosts);
  if (url === null) {
    return failed("The arguments do not name something this tool can fetch.");
  }
  try {
    const response = await options.fetcher(url, {
      redirect: "manual",
      signal: fetchSignal(options.signal),
      headers: { accept: "application/json, text/plain" },
    });
    if (!response.ok) {
      return failed(`The source answered ${String(response.status)}.`);
    }
    const text = (await readCapped(response, options.maxChars * BYTES_PER_CHAR)).trim();
    return text === ""
      ? failed("The source returned nothing.")
      : { content: text.slice(0, options.maxChars), isError: false };
  } catch {
    return failed("The source could not be reached.");
  }
};
