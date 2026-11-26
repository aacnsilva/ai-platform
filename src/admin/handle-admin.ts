import { limitsOf } from "../agent/spend";
import type { Env } from "../env";
import { json, Rejection } from "../http/respond";
import type { Window } from "../observability/aggregate";
import { summarize } from "../observability/aggregate";
import { listTenants } from "../tenants/registry";
import type { Tenant } from "../tenants/schema";
import { assertAdmin } from "./auth";
import { handleDocuments, isDocumentPath } from "./handle-documents";
import { handleTenants } from "./handle-tenants";

const HOUR_MS = 60 * 60 * 1000;
const MAX_HOURS = 24 * 31;
const TARGET_BUCKETS = 48;
const BUCKET_STEPS_MS = [60_000, 300_000, 900_000, HOUR_MS, 6 * HOUR_MS, 24 * HOUR_MS];

const windowFor = (url: URL, now: number): Window => {
  const requested = Number(url.searchParams.get("hours") ?? "24");
  const hours = Number.isFinite(requested) ? Math.min(MAX_HOURS, Math.max(1, requested)) : 24;
  const span = hours * HOUR_MS;
  const bucketMs = BUCKET_STEPS_MS.find((step) => span / step <= TARGET_BUCKETS) ?? 24 * HOUR_MS;
  return { since: now - span, until: now, bucketMs };
};

const poolOf = async (env: Env, tenant: Tenant, now: number): Promise<Record<string, unknown>> => {
  const ledger = env.LEDGER.get(env.LEDGER.idFromName(`pool:${tenant.id}`));
  const pool = await ledger.status({ now, limits: limitsOf(tenant) });
  return { id: tenant.id, name: tenant.name, tier: tenant.agent.tier, pool };
};

const metrics = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  const now = Date.now();
  const window = windowFor(url, now);
  const tenantFilter = url.searchParams.get("tenant");
  const traffic = url.searchParams.get("traffic");
  const store = env.METRICS.get(env.METRICS.idFromName("global"));
  const [selected, tenants] = await Promise.all([
    store.since({ since: window.since, tenant: tenantFilter, traffic }),
    listTenants(env),
  ]);
  const pools = await Promise.all(tenants.map((tenant) => poolOf(env, tenant, now)));
  return json({ ...summarize(selected, window), tenants: pools }, 200);
};

export const handleAdminApi = async (request: Request, env: Env): Promise<Response> => {
  await assertAdmin(request, env);
  const { pathname } = new URL(request.url);
  if (isDocumentPath(pathname)) {
    return handleDocuments(request, env);
  }
  if (pathname === "/admin/api/metrics" && request.method === "GET") {
    return metrics(request, env);
  }
  const response = await handleTenants(request, env);
  if (response === null) {
    throw new Rejection(404, "not_found");
  }
  return response;
};
