import { bm25, cosine, fuse, rankedIndexes, tokenize } from "./rank";

export interface StoredChunk {
  documentId: string;
  title: string;
  text: string;
  plans: string[] | null;
  model: string | null;
  vector: Float32Array | null;
  tokens?: readonly string[];
}

export interface SearchInput {
  query: string;
  plan: string | null;
  topK: number;
  embeddingModel: string | null;
  queryVector: number[] | null;
}

export interface Hit {
  documentId: string;
  title: string;
  text: string;
}

const MIN_SIMILARITY = 0.2;

const isVisible = (chunk: StoredChunk, plan: string | null): boolean =>
  chunk.plans === null || (plan !== null && chunk.plans.includes(plan));

const vectorScores = (chunks: readonly StoredChunk[], input: SearchInput): number[] =>
  chunks.map((chunk) => {
    const comparable =
      input.queryVector !== null && chunk.vector !== null && chunk.model === input.embeddingModel;
    const similarity = comparable ? cosine(input.queryVector ?? [], chunk.vector ?? []) : 0;
    return similarity >= MIN_SIMILARITY ? similarity : 0;
  });

export const searchChunks = (chunks: readonly StoredChunk[], input: SearchInput): Hit[] => {
  const visible = chunks.filter((chunk) => isVisible(chunk, input.plan));
  const keyword = bm25(
    tokenize(input.query),
    visible.map((chunk) => chunk.tokens ?? tokenize(`${chunk.title} ${chunk.text}`)),
  );
  const order = fuse([rankedIndexes(keyword), rankedIndexes(vectorScores(visible, input))]);
  return order.slice(0, input.topK).flatMap((index) => {
    const chunk = visible[index];
    return chunk === undefined
      ? []
      : [{ documentId: chunk.documentId, title: chunk.title, text: chunk.text }];
  });
};
