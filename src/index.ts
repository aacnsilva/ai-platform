import { DASHBOARD_HTML, TENANTS_HTML } from "./admin/dashboard";
import { handleAdminApi } from "./admin/handle-admin";
import type { Env } from "./env";
import type { RequestContext } from "./gateway/context";
import { handleAttest } from "./gateway/handle-attest";
import { handleRun } from "./gateway/handle-run";
import { handleSession } from "./gateway/handle-session";
import { handlePreflight, handleStatus } from "./gateway/handle-status";
import { INTERNAL_BODY, json, Rejection, rejectionResponse } from "./http/respond";
import { logEvent } from "./observability/log";

export { Knowledge } from "./knowledge/knowledge-object";
export { ModelHealth } from "./llm/health-object";
export { Metrics } from "./observability/metrics-object";
export { Ledger } from "./quota/ledger-object";
export { Subject } from "./quota/subject-object";
export { Session } from "./sessions/session-object";
export { Registry } from "./tenants/registry-object";

const TENANT_PATH =
  /^\/v1\/tenants\/([a-z0-9-]+)\/(runs|status|sessions|attest)(?:\/([A-Za-z0-9-]{3,64}))?$/;

const html = (body: string): Response =>
  new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    },
  });

const MIN_SESSION_ID_CHARS = 8;

interface TenantRoute {
  tenantId: string;
  resource: string;
  detail: string;
}

const routeDetail = (context: RequestContext, target: TenantRoute): Promise<Response> | null => {
  const { tenantId, resource, detail } = target;
  const { method } = context.request;
  if (resource === "attest") {
    return detail === "challenge" || detail === "key"
      ? handleAttest(context, tenantId, detail)
      : Promise.resolve(json({ error: "not_found" }, 404));
  }
  if (resource !== "sessions") {
    return null;
  }
  if (detail.length < MIN_SESSION_ID_CHARS) {
    return Promise.resolve(json({ error: "not_found" }, 404));
  }
  return method === "GET" || method === "DELETE"
    ? handleSession(context, tenantId, detail)
    : Promise.resolve(json({ error: "method_not_allowed" }, 405));
};

const routeTenant = async (context: RequestContext, target: TenantRoute): Promise<Response> => {
  const { tenantId, resource, detail } = target;
  const { method } = context.request;
  if (method === "OPTIONS") {
    return handlePreflight(context, tenantId);
  }
  const detailed = routeDetail(context, target);
  if (detailed !== null) {
    return detailed;
  }
  if (detail !== "") {
    return json({ error: "not_found" }, 404);
  }
  if (resource === "runs" && method === "POST") {
    return handleRun(context, tenantId);
  }
  if (resource === "status" && method === "GET") {
    return handleStatus(context, tenantId);
  }
  return json({ error: "method_not_allowed" }, 405);
};

const route = async (context: RequestContext): Promise<Response> => {
  const { pathname } = new URL(context.request.url);
  const tenantMatch = TENANT_PATH.exec(pathname);
  if (tenantMatch !== null) {
    const [, tenantId = "", resource = "", detail = ""] = tenantMatch;
    return routeTenant(context, { tenantId, resource, detail });
  }
  if (pathname === "/health") {
    return json({ ok: true }, 200);
  }
  if (pathname === "/admin" || pathname === "/admin/") {
    return html(DASHBOARD_HTML);
  }
  if (pathname === "/admin/tenants") {
    return html(TENANTS_HTML);
  }
  if (pathname.startsWith("/admin/api/")) {
    return handleAdminApi(context.request, context.env);
  }
  return json({ error: "not_found" }, 404);
};

const respond = async (context: RequestContext): Promise<Response> => {
  try {
    return await route(context);
  } catch (error) {
    if (error instanceof Rejection) {
      return rejectionResponse(error);
    }
    logEvent("unhandled", {
      requestId: context.requestId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return json(INTERNAL_BODY, 500);
  }
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startedAt = Date.now();
    const abort = new AbortController();
    if (request.signal.aborted) {
      abort.abort();
    } else {
      request.signal.addEventListener("abort", () => {
        abort.abort();
      });
    }
    const context = { request, env, ctx, abort, requestId: crypto.randomUUID(), startedAt };
    const response = await respond(context);
    const tagged = new Response(response.body, response);
    tagged.headers.set("x-request-id", context.requestId);
    tagged.headers.set("server-timing", `gateway;dur=${String(Date.now() - startedAt)}`);
    return tagged;
  },
} satisfies ExportedHandler<Env>;
