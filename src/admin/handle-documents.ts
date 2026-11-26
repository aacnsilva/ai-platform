import { z } from "zod";

import type { Env } from "../env";
import { readBoundedText } from "../http/read-body";
import { json, Rejection } from "../http/respond";
import { chunkText } from "../knowledge/chunk";
import { embedderFor } from "../knowledge/embeddings";
import { loadStoredTenant } from "../tenants/registry";
import type { Tenant } from "../tenants/schema";

const MAX_DOCUMENT_BYTES = 600_000;
const DEFAULT_CHUNK_CHARS = 1200;
const DOCUMENT_PATH =
  /^\/admin\/api\/tenants\/([a-z0-9-]+)\/documents(?:\/([a-z0-9][a-z0-9._-]{0,80}))?$/;

const documentSchema = z.object({
  title: z.string().min(1).max(200),
  text: z.string().min(1).max(500_000),
  plans: z
    .array(z.string().regex(/^[a-z][a-z0-9_-]{0,30}$/))
    .max(20)
    .optional(),
});

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

const hashOf = async (value: unknown): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))));

const readDocument = async (request: Request): Promise<z.infer<typeof documentSchema>> => {
  const raw = await readBoundedText(request, MAX_DOCUMENT_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Rejection(400, "bad_json");
  }
  const parsed = documentSchema.safeParse(body);
  if (!parsed.success) {
    throw new Rejection(400, "bad_document", { message: z.prettifyError(parsed.error) });
  }
  return parsed.data;
};

const assertKnownPlans = (tenant: Tenant, plans: readonly string[] | undefined): void => {
  const unknown = (plans ?? []).filter((plan) => !(plan in tenant.plans));
  if (unknown.length > 0) {
    throw new Rejection(400, "bad_document", {
      message: `Unknown plan(s): ${unknown.join(", ")}.`,
    });
  }
};

const vectorsFor = async (
  env: Env,
  tenant: Tenant,
  chunks: readonly string[],
): Promise<{ model: string | null; vectors: (number[] | null)[] }> => {
  const embedder = embedderFor(env, tenant.knowledge?.embeddingModel);
  if (embedder === null) {
    return { model: null, vectors: chunks.map(() => null) };
  }
  try {
    return { model: embedder.model, vectors: await embedder.embed(chunks) };
  } catch (error) {
    throw new Rejection(502, "embeddings_failed", {
      message: error instanceof Error ? error.message : "The embeddings service failed.",
    });
  }
};

interface Target {
  env: Env;
  tenant: Tenant;
  documentId: string;
}

const putDocument = async (request: Request, target: Target): Promise<Response> => {
  const { env, tenant, documentId } = target;
  const document = await readDocument(request);
  assertKnownPlans(tenant, document.plans);
  const store = env.KNOWLEDGE.get(env.KNOWLEDGE.idFromName(`knowledge:${tenant.id}`));
  const chunkChars = tenant.knowledge?.chunkChars ?? DEFAULT_CHUNK_CHARS;
  const effectiveModel = embedderFor(env, tenant.knowledge?.embeddingModel)?.model ?? null;
  const hash = await hashOf({ document, chunkChars, model: effectiveModel });
  if ((await store.hashOf(documentId)) === hash) {
    return json({ ok: true, id: documentId, unchanged: true }, 200);
  }
  const chunks = chunkText(document.text, chunkChars);
  const embedded = await vectorsFor(env, tenant, chunks);
  await store.put({
    id: documentId,
    title: document.title,
    hash,
    plans: document.plans ?? null,
    model: embedded.model,
    chunks: chunks.map((text, index) => ({ text, vector: embedded.vectors[index] ?? null })),
  });
  return json(
    { ok: true, id: documentId, chunks: chunks.length, embedded: embedded.model !== null },
    200,
  );
};

export const isDocumentPath = (pathname: string): boolean => DOCUMENT_PATH.test(pathname);

const handleDocumentById = async (request: Request, target: Target): Promise<Response> => {
  const { env, tenant, documentId } = target;
  const store = env.KNOWLEDGE.get(env.KNOWLEDGE.idFromName(`knowledge:${tenant.id}`));
  if (request.method === "GET") {
    const document = await store.get(documentId);
    if (document === null) {
      throw new Rejection(404, "not_found");
    }
    return json(document, 200);
  }
  if (request.method === "PUT") {
    return putDocument(request, target);
  }
  if (request.method === "DELETE") {
    return json({ ok: true, removed: await store.remove(documentId) }, 200);
  }
  return json({ error: "method_not_allowed" }, 405);
};

export const handleDocuments = async (request: Request, env: Env): Promise<Response> => {
  const match = DOCUMENT_PATH.exec(new URL(request.url).pathname);
  const tenant = match?.[1] === undefined ? null : await loadStoredTenant(env, match[1]);
  if (tenant === null) {
    throw new Rejection(404, "not_found");
  }
  const documentId = match?.[2];
  if (documentId === undefined) {
    const store = env.KNOWLEDGE.get(env.KNOWLEDGE.idFromName(`knowledge:${tenant.id}`));
    return request.method === "GET"
      ? json(await store.list(), 200)
      : json({ error: "method_not_allowed" }, 405);
  }
  return handleDocumentById(request, { env, tenant, documentId });
};
