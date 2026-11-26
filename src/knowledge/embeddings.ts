import type { Env } from "../env";

const BATCH = 64;
const TIMEOUT_MS = 15_000;

export interface Embedder {
  model: string;
  embed: (texts: readonly string[], signal?: AbortSignal) => Promise<number[][]>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isVector = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "number");

const vectorsOf = (body: unknown, expected: number): number[][] => {
  const data = isRecord(body) ? body["data"] : undefined;
  const vectors = Array.isArray(data)
    ? data.map((entry: unknown) => (isRecord(entry) ? entry["embedding"] : undefined))
    : [];
  if (vectors.length !== expected || !vectors.every(isVector)) {
    throw new Error("The embeddings service returned an unexpected reply.");
  }
  return vectors;
};

interface BatchCall {
  baseUrl: string;
  apiKey: string;
  model: string;
  input: readonly string[];
  signal: AbortSignal | undefined;
}

const fetchSignal = (caller: AbortSignal | undefined): AbortSignal => {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return caller === undefined ? timeout : AbortSignal.any([caller, timeout]);
};

const embedBatch = async (call: BatchCall): Promise<number[][]> => {
  const response = await fetch(`${call.baseUrl}/embeddings`, {
    method: "POST",
    signal: fetchSignal(call.signal),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${call.apiKey}`,
    },
    body: JSON.stringify({ model: call.model, input: call.input }),
  });
  if (!response.ok) {
    throw new Error(`The embeddings service answered ${String(response.status)}.`);
  }
  return vectorsOf(await response.json(), call.input.length);
};

export const embedderFor = (env: Env, model: string | undefined): Embedder | null => {
  const rawUrl = env.EMBEDDINGS_BASE_URL ?? "";
  if (model === undefined || rawUrl === "") {
    return null;
  }
  const baseUrl = rawUrl.replace(/\/+$/, "");
  const apiKey = env.EMBEDDINGS_API_KEY ?? "";
  return {
    model,
    embed: async (texts, signal) => {
      const vectors: number[][] = [];
      for (let start = 0; start < texts.length; start += BATCH) {
        vectors.push(
          ...(await embedBatch({
            baseUrl,
            apiKey,
            model,
            input: texts.slice(start, start + BATCH),
            signal,
          })),
        );
      }
      return vectors;
    },
  };
};
