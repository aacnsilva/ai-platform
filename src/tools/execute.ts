import type { ToolResultBlock, ToolUseBlock } from "../llm/provider";
import type { Contract, ToolDefinition } from "../tenants/schema";
import type { ToolOutput } from "./http-tool";
import { runHttpTool } from "./http-tool";

export interface KnowledgeHit {
  documentId: string;
  title: string;
  text: string;
}

export interface ToolRuntime {
  allowedHosts: readonly string[];
  maxChars: number;
  fetcher: typeof fetch;
  signal?: AbortSignal;
  searchKnowledge: (query: string) => Promise<KnowledgeHit[]>;
}

const MAX_QUERY_CHARS = 400;

export const definitionOf = (contract: Contract, call: ToolUseBlock): ToolDefinition | undefined =>
  contract.tools.find((tool) => tool.name === call.name);

export const runsOnClient = (contract: Contract, call: ToolUseBlock): boolean =>
  definitionOf(contract, call)?.run.kind === "client";

const packHits = (hits: readonly KnowledgeHit[], maxChars: number): string => {
  let packed = "";
  for (const [index, hit] of hits.entries()) {
    const entry = `[${String(index + 1)}] ${hit.title} (${hit.documentId})\n${hit.text}\n\n`;
    if (packed.length + entry.length > maxChars) {
      break;
    }
    packed += entry;
  }
  return packed.trim();
};

const searchKnowledge = async (runtime: ToolRuntime, call: ToolUseBlock): Promise<ToolOutput> => {
  const { query } = call.input;
  if (typeof query !== "string" || query.trim() === "") {
    return { content: "Give a query to search for.", isError: true };
  }
  const hits = await runtime.searchKnowledge(query.trim().slice(0, MAX_QUERY_CHARS));
  const packed = packHits(hits, runtime.maxChars);
  return {
    content: packed === "" ? "Nothing in the knowledge base matched." : packed,
    isError: false,
  };
};

const run = async (
  runtime: ToolRuntime,
  definition: ToolDefinition | undefined,
  call: ToolUseBlock,
): Promise<ToolOutput> => {
  if (definition === undefined || definition.run.kind === "client") {
    return { content: "This tool cannot run here.", isError: true };
  }
  if (definition.run.kind === "knowledge") {
    return searchKnowledge(runtime, call);
  }
  return runHttpTool(definition.run.url, call.input, runtime);
};

export const executeServerCall = async (
  runtime: ToolRuntime,
  contract: Contract,
  call: ToolUseBlock,
): Promise<ToolResultBlock> => {
  const output = await run(runtime, definitionOf(contract, call), call);
  return {
    type: "tool_result",
    tool_use_id: call.id,
    content: output.content,
    ...(output.isError ? { is_error: true } : {}),
  };
};
