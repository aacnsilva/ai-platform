import { authenticate } from "../authn/authenticate";
import { corsHeaders, withHeaders } from "../http/cors";
import { readBoundedBytes } from "../http/read-body";
import { json, Rejection } from "../http/respond";
import { transcript } from "../sessions/session";
import type { ReadOptions } from "../sessions/session-object";
import { readSession, sessionStub } from "../sessions/session-port";
import { loadTenant } from "../tenants/registry";
import type { Tenant } from "../tenants/schema";
import type { RequestContext } from "./context";
import { rejected } from "./handle-run";

const MAX_SESSION_BODY_BYTES = 1024;
const MAX_LIMIT = 500;
const NON_NEGATIVE_INT = /^\d+$/;

const parseQueryInt = (raw: string | null, min: number, max: number): number | undefined => {
  if (raw === null) {
    return undefined;
  }
  if (!NON_NEGATIVE_INT.test(raw)) {
    throw new Rejection(400, "bad_query");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Rejection(400, "bad_query");
  }
  return value;
};

const readOptionsOf = (request: Request): ReadOptions => {
  const { searchParams } = new URL(request.url);
  const limit = parseQueryInt(searchParams.get("limit"), 1, MAX_LIMIT);
  const before = parseQueryInt(searchParams.get("before"), 0, Number.MAX_SAFE_INTEGER);
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(before === undefined ? {} : { before }),
  };
};

const respond = async (
  context: RequestContext,
  tenant: Tenant,
  sessionId: string,
): Promise<Response> => {
  const { env, request } = context;
  const rawBody = await readBoundedBytes(request, MAX_SESSION_BODY_BYTES);
  const principal = await authenticate(context, tenant, rawBody);
  const store = sessionStub(env, tenant.id, sessionId);
  const options = request.method === "GET" ? readOptionsOf(request) : undefined;
  const state = await readSession(store, options);
  if (state?.owner !== principal.subjectId) {
    throw new Rejection(404, "not_found");
  }
  if (request.method === "DELETE") {
    await store.clear();
    return json({ ok: true }, 200);
  }
  return json(
    {
      sessionId,
      updatedAt: state.updatedAt,
      awaitingToolResults: state.awaitingToolResults,
      messages: transcript(state.messages),
      ...(state.nextBefore === null ? {} : { nextBefore: state.nextBefore }),
    },
    200,
  );
};

export const handleSession = async (
  context: RequestContext,
  tenantId: string,
  sessionId: string,
): Promise<Response> => {
  const tenant = await loadTenant(context.env, tenantId);
  if (tenant === null) {
    return json({ error: "not_found" }, 404);
  }
  try {
    const response = await respond(context, tenant, sessionId);
    return withHeaders(response, corsHeaders(context.request, tenant.authn.allowedOrigins));
  } catch (error) {
    if (error instanceof Rejection) {
      return rejected(context, tenant, error);
    }
    throw error;
  }
};
