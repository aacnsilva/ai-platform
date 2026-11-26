import type { RequestContext } from "../gateway/context";
import { Rejection } from "../http/respond";
import type { Tenant } from "../tenants/schema";
import { verifyAccountToken } from "./account-token";
import { authenticateDevice } from "./device-authn";
import { evalPrincipal } from "./eval-pass";
import { normalizeIp } from "./ip";
import type { Principal } from "./principal";

const BEARER = "Bearer ";

export const clientIp = (request: Request): string =>
  normalizeIp(request.headers.get("CF-Connecting-IP"));

export const assertOrigin = (request: Request, tenant: Tenant): void => {
  const origin = request.headers.get("Origin");
  if (origin !== null && !tenant.authn.allowedOrigins.includes(origin)) {
    throw new Rejection(403, "origin");
  }
};

export const principalFor = (tenant: Tenant, subjectId: string, planId: string): Principal => {
  const plan = tenant.plans[planId];
  if (plan === undefined) {
    throw new Rejection(403, "entitlement_inactive");
  }
  return {
    subjectId,
    planId,
    messagesPerMonth: plan.messagesPerMonth,
    tier: plan.tier ?? tenant.agent.tier,
    authenticated: true,
    evaluated: false,
    effortOverride: null,
  };
};

const bearerToken = (request: Request): string => {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith(BEARER)) {
    throw new Rejection(401, "missing_token");
  }
  return header.slice(BEARER.length);
};

export const authenticate = async (
  context: RequestContext,
  tenant: Tenant,
  rawBody: Uint8Array,
): Promise<Principal> => {
  const { request } = context;
  const { authn } = tenant;
  assertOrigin(request, tenant);
  const evaluator = await evalPrincipal(request, tenant);
  if (evaluator !== null) {
    return evaluator;
  }
  switch (authn.kind) {
    case "anonymous":
      return {
        subjectId: clientIp(request),
        planId: null,
        messagesPerMonth: null,
        tier: tenant.agent.tier,
        authenticated: false,
        evaluated: false,
        effortOverride: null,
      };
    case "account_token": {
      const claims = await verifyAccountToken(bearerToken(request), authn, Date.now());
      return principalFor(tenant, claims.subject, claims.plan);
    }
    case "app_attest":
      return authenticateDevice(context, { tenant, authn, rawBody });
  }
};
