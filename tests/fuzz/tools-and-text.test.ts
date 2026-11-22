import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { GateStream } from "../../src/agent/gate-stream";
import { chunkText } from "../../src/knowledge/chunk";
import { resolveUrl, runHttpTool } from "../../src/tools/http-tool";

const ALLOWED = ["api.example.test", "eu.example.test"];
const TEMPLATES = [
  "https://api.example.test/v1/guides/{id}",
  "https://api.example.test/v1/guides/{id}/parts/{part}?lang={lang}",
  "https://{region}.example.test/v1/items",
  "https://api.example.test{path}",
  "https://api.example.test/v1/{id}.json",
] as const;

const hostile = fc.oneof(
  fc.constantFrom(
    "..",
    "../admin",
    "a/b",
    "a%2Fb",
    "evil.test",
    ".evil.test",
    "@evil.test",
    "x@evil.test",
    ":8080",
    "eu",
    "api",
    "a?b=c",
    "a#b",
    "\\\\evil.test",
    "eu.example.test.evil.test",
    "%2e%2e",
    " ",
    "",
  ),
  fc.string({ maxLength: 20 }),
  fc.string({ unit: "binary", maxLength: 20 }),
  fc.stringMatching(/^[A-Za-z0-9._-]{1,12}$/),
  fc.integer(),
  fc.double(),
  fc.anything({ maxDepth: 1 }),
);
const inputs = fc.record(
  { id: hostile, part: hostile, lang: hostile, region: hostile, path: hostile },
  { requiredKeys: [] },
);

const staticPath = (template: string): string => {
  const path = new URL(template.replaceAll(/\{[a-z]+\}/g, "x")).pathname;
  const upTo = template.includes("{") ? path.indexOf("x") : path.length;
  return template.includes("{region}") ? path : path.slice(0, upTo === -1 ? path.length : upTo);
};

describe("fetch tool under hostile arguments", () => {
  it("only ever resolves to an allowed host, over https, under the template's own path", () => {
    let resolved = 0;
    fc.assert(
      fc.property(fc.constantFrom(...TEMPLATES), inputs, (template, input) => {
        const url = resolveUrl(template, input, ALLOWED);
        if (url === null) {
          return;
        }
        resolved += 1;
        expect(ALLOWED).toContain(url.hostname);
        expect(url.protocol).toBe("https:");
        expect(url.port).toBe("");
        expect(url.username + url.password + url.hash).toBe("");
        expect(url.pathname.startsWith(staticPath(template))).toBe(true);
        expect(url.pathname.split("/")).not.toContain("..");
        expect(url.pathname.split("/").length).toBe(new URL(template).pathname.split("/").length);
      }),
      { numRuns: 8000 },
    );
    expect(resolved).toBeGreaterThan(0);
  });

  it("refuses an argument that would drop or climb a path segment", () => {
    const template = "https://api.example.test/v1/guides/{id}/parts/{part}";
    expect(resolveUrl(template, { id: ".", part: "1" }, ALLOWED)).toBeNull();
    expect(resolveUrl(template, { id: "..", part: "1" }, ALLOWED)).toBeNull();
    expect(resolveUrl("https://api.example.test/v1/.{id}/x", { id: "." }, ALLOWED)).toBeNull();
    expect(resolveUrl(template, { id: "a.b", part: "1" }, ALLOWED)?.pathname).toBe(
      "/v1/guides/a.b/parts/1",
    );
  });

  it("stops reading a source that keeps sending, and hands back no more than its cap", async () => {
    const sizes = fc.record({
      maxChars: fc.integer({ min: 1, max: 500 }),
      chunkBytes: fc.integer({ min: 1, max: 4096 }),
      unit: fc.constantFrom("a", "é", "€", "😀"),
    });
    await fc.assert(
      fc.asyncProperty(sizes, async ({ maxChars, chunkBytes, unit }) => {
        const chunk = new TextEncoder().encode(unit.repeat(chunkBytes));
        let sent = 0;
        const endless = new ReadableStream<Uint8Array>({
          pull: (controller) => {
            sent += chunk.byteLength;
            controller.enqueue(chunk);
          },
        });
        const fetcher: typeof fetch = () => Promise.resolve(new Response(endless));
        const output = await runHttpTool(
          "https://api.example.test/v1/guides/{id}",
          { id: "a" },
          {
            allowedHosts: ALLOWED,
            maxChars,
            fetcher,
          },
        );
        expect(output.isError).toBe(false);
        expect(output.content.length).toBeLessThanOrEqual(maxChars);
        expect(sent).toBeLessThanOrEqual(maxChars * 4 + 3 * chunk.byteLength);
      }),
      { numRuns: 200 },
    );
  });
});

describe("chunking under hostile text", () => {
  it("ends, loses no words, and keeps every chunk non-empty", () => {
    const words = fc.array(
      fc.oneof(
        fc.stringMatching(/^[a-z]{1,12}$/),
        fc.constantFrom(
          "\n",
          "\n\n",
          "\r\n\r\n",
          ". ",
          "# Title",
          "## Part",
          "   ",
          "x".repeat(300),
        ),
      ),
      { maxLength: 80 },
    );
    fc.assert(
      fc.property(words, fc.integer({ min: 1, max: 400 }), (parts, maxChars) => {
        const text = parts.join(" ");
        const chunks = chunkText(text, maxChars);
        const lettersOf = (value: string): number => value.replaceAll(/[^a-z]/g, "").length;
        expect(chunks.every((chunk) => chunk.trim() !== "")).toBe(true);
        expect(lettersOf(chunks.join(" "))).toBeGreaterThanOrEqual(lettersOf(text));
      }),
      { numRuns: 3000 },
    );
  });
});

const splitAt = (text: string, cuts: readonly number[]): string[] => {
  const points = [...new Set(cuts.map((cut) => Math.floor(cut * text.length)))].sort(
    (left, right) => left - right,
  );
  const pieces: string[] = [];
  let from = 0;
  for (const point of [...points, text.length]) {
    pieces.push(text.slice(from, point));
    from = point;
  }
  return pieces;
};

const streamed = (pieces: readonly string[]): string => {
  const gate = new GateStream();
  return pieces.map((piece) => gate.push(piece)).join("");
};

const escaped = (text: string): string =>
  Array.from(text)
    .flatMap((char) => char.split(""))
    .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .join("");

const cuts = fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 12 });

describe("gated stream under hostile model output", () => {
  it("releases exactly the answer of an on-topic reply, and nothing of an off-topic one", () => {
    const replies = fc.record({
      answer: fc.string({ unit: "binary", maxLength: 80 }),
      onTopic: fc.boolean(),
      escape: fc.boolean(),
    });
    fc.assert(
      fc.property(replies, cuts, ({ answer, onTopic, escape }, at) => {
        const plain = JSON.stringify({ on_topic: onTopic, answer });
        const reply = escape
          ? `{"on_topic":${String(onTopic)},"answer":"${escaped(answer)}","extra":"never shown"}`
          : plain;
        expect(streamed(splitAt(reply, at))).toBe(onTopic ? answer.trimStart() : "");
      }),
      { numRuns: 4000 },
    );
  });

  it("treats a reply padded past the head limit the same whole or in pieces", () => {
    const reply = `${" ".repeat(300)}{"on_topic":true,"answer":"shown"}`;
    expect(streamed([reply])).toBe(streamed(splitAt(reply, [0.5])));
  });

  it("releases the same text however the provider cuts the stream", () => {
    const fragments = fc.array(
      fc.oneof(
        fc.constantFrom(
          '{"on_topic":true,"answer":"',
          '{"on_topic":false,"answer":"',
          '"',
          "\\",
          "\\u",
          "\\ud83d",
          "\\ude00",
          " ".repeat(120),
          "}",
        ),
        fc.string({ unit: "binary", maxLength: 10 }),
      ),
      { maxLength: 12 },
    );
    fc.assert(
      fc.property(fragments, cuts, (parts, at) => {
        const reply = parts.join("");
        expect(streamed(splitAt(reply, at))).toBe(streamed([reply]));
      }),
      { numRuns: 6000 },
    );
  });
});
