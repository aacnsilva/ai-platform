export interface ToolOutput {
  content: string;
  isError: boolean;
}

export interface HttpToolOptions {
  allowedHosts: readonly string[];
  maxChars: number;
  fetcher: typeof fetch;
}

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;
const SAFE_VALUE = /^[A-Za-z0-9._-]{1,100}$/;
const AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;
const ENCODED_DOT = /%2e/gi;
const TIMEOUT_MS = 5000;
const BYTES_PER_CHAR = 4;

const failed = (content: string): ToolOutput => ({ content, isError: true });

const safeText = (value: unknown): string | null => {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && SAFE_VALUE.test(text) && !text.includes("..") ? text : null;
};

const fill = (template: string, input: Record<string, unknown>): string | null => {
  const names = Array.from(template.matchAll(PLACEHOLDER), (match) => match[1] ?? "");
  if (names.some((name) => safeText(input[name]) === null)) {
    return null;
  }
  return template.replaceAll(PLACEHOLDER, (_match, name: string) =>
    encodeURIComponent(safeText(input[name]) ?? ""),
  );
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
  while (received < maxBytes) {
    const chunk: ReadableStreamReadResult<unknown> = await reader.read();
    if (chunk.done || !(chunk.value instanceof Uint8Array)) {
      break;
    }
    received += chunk.value.byteLength;
    text += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel();
  return text + decoder.decode();
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
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
