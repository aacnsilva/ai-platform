const HEAD = /^\s*\{\s*"on_topic"\s*:\s*(true|false)\s*,\s*"answer"\s*:\s*"/;
const MAX_HEAD_CHARS = 200;
const UNICODE_ESCAPE_CHARS = 6;
const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

type Phase = "head" | "answer" | "done";

type Token =
  | { kind: "wait" }
  | { kind: "end" }
  | { kind: "text"; text: string; next: number }
  | { kind: "unit"; code: number; next: number };

const readEscape = (buffer: string, position: number): Token => {
  const kind = buffer[position + 1];
  if (kind === undefined) {
    return { kind: "wait" };
  }
  if (kind !== "u") {
    return { kind: "text", text: SIMPLE_ESCAPES[kind] ?? "", next: position + 2 };
  }
  if (position + UNICODE_ESCAPE_CHARS > buffer.length) {
    return { kind: "wait" };
  }
  const code = Number.parseInt(buffer.slice(position + 2, position + UNICODE_ESCAPE_CHARS), 16);
  return { kind: "unit", code, next: position + UNICODE_ESCAPE_CHARS };
};

const readToken = (buffer: string, position: number): Token => {
  const char = buffer[position];
  if (char === undefined) {
    return { kind: "wait" };
  }
  if (char === '"') {
    return { kind: "end" };
  }
  return char === "\\"
    ? readEscape(buffer, position)
    : { kind: "text", text: char, next: position + 1 };
};

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

export class GateStream {
  private buffer = "";
  private phase: Phase = "head";
  private position = 0;
  private pendingHigh = "";
  private hasOutput = false;

  push(delta: string): string {
    if (this.phase === "done" || delta === "") {
      return "";
    }
    this.buffer += delta;
    if (this.phase === "head") {
      this.readHead();
    }
    return this.phase === "answer" ? this.withoutLeadingSpace(this.readAnswer()) : "";
  }

  private readHead(): void {
    const match = HEAD.exec(this.buffer);
    if (match === null || match[0].length > MAX_HEAD_CHARS) {
      this.phase = this.buffer.length > MAX_HEAD_CHARS ? "done" : "head";
      return;
    }
    this.phase = match[1] === "true" ? "answer" : "done";
    this.position = match[0].length;
  }

  private readAnswer(): string {
    let out = "";
    for (;;) {
      const token = readToken(this.buffer, this.position);
      if (token.kind === "wait") {
        return out;
      }
      if (token.kind === "end") {
        this.phase = "done";
        return out;
      }
      out += token.kind === "text" ? token.text : this.decodeUnit(token.code);
      this.position = token.next;
    }
  }

  private decodeUnit(code: number): string {
    if (Number.isNaN(code)) {
      return "";
    }
    const unit = String.fromCharCode(code);
    if (isHighSurrogate(code)) {
      this.pendingHigh = unit;
      return "";
    }
    if (!isLowSurrogate(code)) {
      return unit;
    }
    const pair = this.pendingHigh === "" ? "" : this.pendingHigh + unit;
    this.pendingHigh = "";
    return pair;
  }

  private withoutLeadingSpace(text: string): string {
    if (this.hasOutput) {
      return text;
    }
    const trimmed = text.trimStart();
    this.hasOutput = trimmed !== "";
    return trimmed;
  }
}
