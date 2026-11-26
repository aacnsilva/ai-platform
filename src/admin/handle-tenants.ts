import { z } from "zod";

import type { Env } from "../env";
import { readBoundedText } from "../http/read-body";
import { json, Rejection } from "../http/respond";
import { deleteTenant, listTenants, loadStoredTenant, saveTenant } from "../tenants/registry";
import type { Tenant } from "../tenants/schema";
import { tenantSchema } from "../tenants/schema";
import { contractHash } from "../tools/contract-hash";
import { TEMPLATES } from "./templates";

const MAX_TENANT_BYTES = 600_000;
const TENANT_PATH = /^\/admin\/api\/tenants\/([a-z0-9-]+)$/;

interface ContractSummary {
  version: number;
  hash: string;
  tools: number;
}

const contractSummaries = async (tenant: Tenant): Promise<ContractSummary[]> => {
  const contracts = tenant.agent.kind === "chat" ? tenant.agent.contracts : [];
  return Promise.all(
    contracts.map(async (contract) => ({
      version: contract.version,
      hash: await contractHash(contract),
      tools: contract.tools.length,
    })),
  );
};

const readTenant = async (request: Request): Promise<Tenant> => {
  const raw = await readBoundedText(request, MAX_TENANT_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Rejection(400, "bad_json");
  }
  const parsed = tenantSchema.safeParse(body);
  if (!parsed.success) {
    throw new Rejection(400, "bad_tenant", { message: z.prettifyError(parsed.error) });
  }
  return parsed.data;
};

const summaryOf = (tenant: Tenant): Record<string, unknown> => ({
  id: tenant.id,
  name: tenant.name,
  tier: tenant.agent.tier,
  agent: tenant.agent.kind === "chat" ? `chat, ${tenant.agent.state}` : "gated",
  authn: tenant.authn.kind,
  plans: Object.keys(tenant.plans).length,
  evals: tenant.evals !== undefined,
});

const list = async (env: Env): Promise<Response> =>
  json((await listTenants(env)).map(summaryOf), 200);

const get = async (env: Env, id: string): Promise<Response> => {
  const tenant = await loadStoredTenant(env, id);
  if (tenant === null) {
    throw new Rejection(404, "not_found");
  }
  return json({ tenant, contracts: await contractSummaries(tenant) }, 200);
};

const put = async (request: Request, env: Env, id: string): Promise<Response> => {
  const tenant = await readTenant(request);
  if (tenant.id !== id) {
    throw new Rejection(400, "id_mismatch", {
      message: "The id in the document must match the address it is saved to.",
    });
  }
  await saveTenant(env, tenant);
  return json({ ok: true, id, tenant, contracts: await contractSummaries(tenant) }, 200);
};

const validate = async (request: Request): Promise<Response> => {
  const tenant = await readTenant(request);
  return json({ ok: true, tenant, contracts: await contractSummaries(tenant) }, 200);
};

const remove = async (env: Env, id: string): Promise<Response> => {
  const removed = await deleteTenant(env, id);
  if (removed) {
    await env.KNOWLEDGE.get(env.KNOWLEDGE.idFromName(`knowledge:${id}`)).clear();
  }
  return json({ ok: true, removed }, 200);
};

const byId = async (request: Request, env: Env, id: string): Promise<Response> => {
  switch (request.method) {
    case "GET":
      return get(env, id);
    case "PUT":
      return put(request, env, id);
    case "DELETE":
      return remove(env, id);
    default:
      return json({ error: "method_not_allowed" }, 405);
  }
};

export const handleTenants = async (request: Request, env: Env): Promise<Response | null> => {
  const { pathname } = new URL(request.url);
  const { method } = request;
  if (pathname === "/admin/api/tenants" && method === "GET") {
    return list(env);
  }
  if (pathname === "/admin/api/templates" && method === "GET") {
    return json(TEMPLATES, 200);
  }
  if (pathname === "/admin/api/validate-tenant" && method === "POST") {
    return validate(request);
  }
  const id = TENANT_PATH.exec(pathname)?.[1];
  return id === undefined ? null : byId(request, env, id);
};
