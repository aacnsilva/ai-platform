import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import { tokenize } from "./rank";
import type { Hit, SearchInput, StoredChunk } from "./search";
import { searchChunks } from "./search";

export interface DocumentInput {
  id: string;
  title: string;
  hash: string;
  plans: string[] | null;
  model: string | null;
  chunks: { text: string; vector: number[] | null }[];
}

export interface DocumentSummary {
  id: string;
  title: string;
  hash: string;
  plans: string[] | null;
  chunks: number;
  embedded: boolean;
  updatedAt: number;
}

export interface StoredDocument extends DocumentSummary {
  texts: string[];
}

type Row = Record<string, SqlStorageValue>;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, hash TEXT NOT NULL, plans TEXT,
    model TEXT, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS chunks (
    document_id TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL, vector BLOB,
    PRIMARY KEY (document_id, seq))`,
];
const SELECT_CHUNKS = `SELECT c.document_id, c.text, c.vector, d.title, d.plans, d.model
  FROM chunks c JOIN documents d ON d.id = c.document_id ORDER BY c.document_id, c.seq`;
const SELECT_DOCUMENTS = `SELECT d.id, d.title, d.hash, d.plans, d.model, d.updated_at,
  (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id) AS chunk_count
  FROM documents d ORDER BY d.id`;
const SELECT_ONE = `SELECT d.id, d.title, d.hash, d.plans, d.model, d.updated_at,
  (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id) AS chunk_count
  FROM documents d WHERE d.id = ?`;

const textOf = (value: SqlStorageValue | undefined): string =>
  typeof value === "string" ? value : "";

const plansOf = (value: SqlStorageValue | undefined): string[] | null => {
  if (typeof value !== "string") {
    return null;
  }
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((plan) => typeof plan === "string") : null;
};

const chunkOf = (row: Row): StoredChunk => {
  const title = textOf(row["title"]);
  const text = textOf(row["text"]);
  return {
    documentId: textOf(row["document_id"]),
    title,
    text,
    plans: plansOf(row["plans"]),
    model: typeof row["model"] === "string" ? row["model"] : null,
    vector: row["vector"] instanceof ArrayBuffer ? new Float32Array(row["vector"]) : null,
    tokens: tokenize(`${title} ${text}`),
  };
};

const summaryOf = (row: Row): DocumentSummary => ({
  id: textOf(row["id"]),
  title: textOf(row["title"]),
  hash: textOf(row["hash"]),
  plans: plansOf(row["plans"]),
  chunks: typeof row["chunk_count"] === "number" ? row["chunk_count"] : 0,
  embedded: typeof row["model"] === "string",
  updatedAt: typeof row["updated_at"] === "number" ? row["updated_at"] : 0,
});

export class Knowledge extends DurableObject<Env> {
  private cache: StoredChunk[] | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const statement of SCHEMA) {
      ctx.storage.sql.exec(statement);
    }
  }

  hashOf(id: string): string | null {
    const rows = this.ctx.storage.sql
      .exec<Row>("SELECT hash FROM documents WHERE id = ?", id)
      .toArray();
    const hash = rows[0]?.["hash"];
    return typeof hash === "string" ? hash : null;
  }

  get(id: string): StoredDocument | null {
    const { sql } = this.ctx.storage;
    const row = sql.exec<Row>(SELECT_ONE, id).toArray()[0];
    if (row === undefined) {
      return null;
    }
    const texts = sql
      .exec<Row>("SELECT text FROM chunks WHERE document_id = ? ORDER BY seq", id)
      .toArray()
      .map((entry) => textOf(entry["text"]));
    return { ...summaryOf(row), texts };
  }

  put(document: DocumentInput): void {
    const { sql } = this.ctx.storage;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM chunks WHERE document_id = ?", document.id);
      sql.exec(
        "INSERT OR REPLACE INTO documents VALUES (?, ?, ?, ?, ?, ?)",
        document.id,
        document.title,
        document.hash,
        document.plans === null ? null : JSON.stringify(document.plans),
        document.model,
        Date.now(),
      );
      document.chunks.forEach((chunk, seq) => {
        const vector = chunk.vector === null ? null : new Float32Array(chunk.vector).buffer;
        sql.exec("INSERT INTO chunks VALUES (?, ?, ?, ?)", document.id, seq, chunk.text, vector);
      });
    });
    this.cache = undefined;
  }

  remove(id: string): boolean {
    const { sql } = this.ctx.storage;
    let existed = false;
    this.ctx.storage.transactionSync(() => {
      existed = this.hashOf(id) !== null;
      sql.exec("DELETE FROM chunks WHERE document_id = ?", id);
      sql.exec("DELETE FROM documents WHERE id = ?", id);
    });
    this.cache = undefined;
    return existed;
  }

  clear(): void {
    const { sql } = this.ctx.storage;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM chunks");
      sql.exec("DELETE FROM documents");
    });
    this.cache = undefined;
  }

  list(): DocumentSummary[] {
    return this.ctx.storage.sql.exec<Row>(SELECT_DOCUMENTS).toArray().map(summaryOf);
  }

  search(input: SearchInput): Hit[] {
    this.cache ??= this.ctx.storage.sql.exec<Row>(SELECT_CHUNKS).toArray().map(chunkOf);
    return searchChunks(this.cache, input);
  }
}
