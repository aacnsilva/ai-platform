import type { Principal } from "../authn/principal";
import type { RequestContext } from "../gateway/context";
import { embedderFor } from "../knowledge/embeddings";
import type { Tenant } from "../tenants/schema";
import type { ToolRuntime } from "./execute";

const DEFAULT_TOP_K = 5;

export const toolRuntimeFor = (
  context: RequestContext,
  tenant: Tenant,
  principal: Principal,
): ToolRuntime => {
  const { env } = context;
  const knowledge = env.KNOWLEDGE.get(env.KNOWLEDGE.idFromName(`knowledge:${tenant.id}`));
  const embedder = embedderFor(env, tenant.knowledge?.embeddingModel);
  const queryVector = async (query: string): Promise<number[] | null> => {
    if (embedder === null) {
      return null;
    }
    const vectors = await embedder.embed([query], context.abort.signal).catch(() => []);
    return vectors[0] ?? null;
  };
  return {
    allowedHosts: tenant.egress.allowedHosts,
    maxChars: tenant.agent.kind === "chat" ? tenant.agent.input.maxToolResultChars : 0,
    fetcher: async (input, init) => fetch(input, init),
    signal: context.abort.signal,
    searchKnowledge: async (query) =>
      knowledge.search({
        query,
        plan: principal.planId,
        topK: tenant.knowledge?.topK ?? DEFAULT_TOP_K,
        embeddingModel: embedder?.model ?? null,
        queryVector: await queryVector(query),
      }),
  };
};
