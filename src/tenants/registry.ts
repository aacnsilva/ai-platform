import type { Env } from "../env";
import { logEvent } from "../observability/log";
import type { Registry } from "./registry-object";
import type { Tenant } from "./schema";
import { tenantSchema } from "./schema";

const FRESH_MS = 30_000;
const MISSING_FRESH_MS = 5000;
const MAX_CACHE_ENTRIES = 500;

interface Cached {
  at: number;
  tenant: Tenant | null;
}

const cache = new Map<string, Cached>();

const registryOf = (env: Env): DurableObjectStub<Registry> =>
  env.REGISTRY.get(env.REGISTRY.idFromName("global"));

const isFresh = (cached: Cached, now: number): boolean =>
  now - cached.at < (cached.tenant === null ? MISSING_FRESH_MS : FRESH_MS);

const remember = (id: string, entry: Cached): void => {
  if (cache.has(id)) {
    cache.delete(id);
  } else if (cache.size >= MAX_CACHE_ENTRIES) {
    for (const [key, existing] of cache) {
      if (!isFresh(existing, entry.at)) {
        cache.delete(key);
      }
    }
    while (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
  }
  cache.set(id, entry);
};

const parseTenant = (id: string, serialized: string): Tenant | null => {
  try {
    const parsed = tenantSchema.safeParse(JSON.parse(serialized));
    if (parsed.success) {
      return parsed.data;
    }
    logEvent("tenant_corrupt", { tenant: id, issues: parsed.error.issues.length });
    return null;
  } catch (error) {
    logEvent("tenant_corrupt", {
      tenant: id,
      message: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }
};

export const loadTenant = async (env: Env, id: string): Promise<Tenant | null> => {
  const now = Date.now();
  const cached = cache.get(id);
  if (cached !== undefined && isFresh(cached, now)) {
    return cached.tenant;
  }
  const serialized = await registryOf(env).get(id);
  const tenant = serialized === null ? null : parseTenant(id, serialized);
  remember(id, { at: now, tenant });
  return tenant;
};

export const saveTenant = async (env: Env, tenant: Tenant): Promise<void> => {
  await registryOf(env).put(tenant.id, JSON.stringify(tenant));
  remember(tenant.id, { at: Date.now(), tenant });
};

export const listTenants = async (env: Env): Promise<Tenant[]> => {
  const stored = await registryOf(env).list();
  return stored.flatMap((serialized) => {
    const tenant = parseTenant("list", serialized);
    return tenant === null ? [] : [tenant];
  });
};

export const loadStoredTenant = async (env: Env, id: string): Promise<Tenant | null> => {
  const serialized = await registryOf(env).get(id);
  return serialized === null ? null : parseTenant(id, serialized);
};

export const deleteTenant = async (env: Env, id: string): Promise<boolean> => {
  const removed = await registryOf(env).remove(id);
  remember(id, { at: Date.now(), tenant: null });
  return removed;
};
