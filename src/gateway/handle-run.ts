import type { ChatTurn, QuotaPort } from "../agent/chat";
import { chatRound } from "../agent/chat";
import { createChatStream } from "../agent/chat-stream";
import { GateStream } from "../agent/gate-stream";
import type { RunInput } from "../agent/run";
import { answer, reserve } from "../agent/run";
import type { PreparedTurn, SessionTurn } from "../agent/session-run";
import { finishSessionTurn, prepareSessionTurn } from "../agent/session-run";
import type { Spend } from "../agent/spend";
import { assertOrigin, authenticate, clientIp } from "../authn/authenticate";
import type { Principal } from "../authn/principal";
import { corsHeaders, withHeaders } from "../http/cors";
import { readBoundedBytes } from "../http/read-body";
import { INTERNAL_BODY, json, Rejection, rejectionResponse } from "../http/respond";
import { createAnthropicProvider } from "../llm/anthropic";
import type { Listeners } from "../llm/provider";
import { breakerFor } from "../llm/shared-breaker";
import { logEvent } from "../observability/log";
import { fingerprintOf, readIdempotencyKey, sessionIdFor } from "../sessions/idempotency";
import { sessionPort, sessionStub } from "../sessions/session-port";
import { loadTenant } from "../tenants/registry";
import type { ChatAgent, Contract, GatedAgent, Tenant } from "../tenants/schema";
import { contractHash } from "../tools/contract-hash";
import { toolRuntimeFor } from "../tools/runtime";
import type { StoredTurn } from "./chat-body";
import { parseChat, parseStoredTurn } from "./chat-body";
import type { RequestContext } from "./context";
import { parseConversation } from "./conversation";
import type { Delivery, Finished } from "./measure";
import { recordFinished, recordRejected } from "./measure";
import type { Emit, StreamEvent } from "./stream";
import { streamResponse, wantsStream } from "./stream";

const UNCONFIGURED_MESSAGE = "The answer service is not configured yet.";

interface Call {
  context: RequestContext;
  tenant: Tenant;
  principal: Principal;
  spend: Spend;
  body: string;
}

const spendFor = async (
  context: RequestContext,
  tenant: Tenant,
  principal: Principal,
): Promise<Spend> => {
  const { env } = context;
  if (env.ANTHROPIC_API_KEY === undefined || env.ANTHROPIC_API_KEY === "") {
    throw new Rejection(503, "unconfigured", { message: UNCONFIGURED_MESSAGE });
  }
  return {
    tenant,
    tier: principal.tier,
    effortOverride: principal.effortOverride,
    ip: clientIp(context.request),
    skipNetworkLimit: principal.authenticated,
    provider: createAnthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      baseURL: env.ANTHROPIC_BASE_URL,
      signal: context.abort.signal,
    }),
    breaker: await breakerFor(env, context.ctx),
    ledger: env.LEDGER.get(env.LEDGER.idFromName(`pool:${tenant.id}`)),
  };
};

const withTenantMessage = (
  tenant: Tenant,
  body: Record<string, unknown>,
): Record<string, unknown> => {
  const code = body["error"];
  const message = typeof code === "string" ? tenant.messages[code] : undefined;
  return message === undefined ? body : { ...body, message };
};

const traceOf = (run: Finished): Record<string, unknown> => {
  const calls = (run.allCalls ?? []).map((call) => ({ name: call.name, input: call.input }));
  return {
    model: run.model,
    modelCalls: run.attempts,
    tools: calls.map((call) => call.name),
    calls,
    toolResults: run.serverResults ?? [],
    usage: run.usage,
    costNanoEur: run.costNanoEur,
  };
};

const traced = (call: Call, run: Finished): Finished => {
  const body = withTenantMessage(call.tenant, run.body);
  return { ...run, body: call.principal.evaluated ? { ...body, eval: traceOf(run) } : body };
};

const finalEvent = (run: Finished): StreamEvent => ({
  type: run.status === 200 ? "done" : "error",
  ...run.body,
  ...(run.replayed === true ? { replayed: true } : {}),
});

type Work = (emit: Emit | undefined, delivery: Delivery) => Promise<Finished>;

const replayHeaders = (run: Pick<Finished, "replayed">): Headers => {
  const headers = new Headers();
  if (run.replayed === true) {
    headers.set("idempotent-replay", "true");
  }
  return headers;
};

const deliver = async (call: Call, work: Work, extraHeaders?: Headers): Promise<Response> => {
  const { context, tenant } = call;
  const { evaluated } = call.principal;
  if (!wantsStream(context.request)) {
    const delivery = { streamed: false, ttftMs: null, evaluated };
    const working = work(undefined, delivery);
    context.ctx.waitUntil(working.catch(() => undefined));
    const run = traced(call, await working);
    recordFinished({ context, tenantId: tenant.id, run, delivery });
    return json(run.body, run.status, replayHeaders(run));
  }
  const delivery: Delivery = { streamed: true, ttftMs: null, evaluated };
  return streamResponse(
    context,
    async (emit) => {
      const finished = await work(emit, delivery).catch((error: unknown) =>
        failedMidStream(context, error),
      );
      const run = traced(call, finished);
      recordFinished({ context, tenantId: tenant.id, run, delivery });
      return finalEvent(run);
    },
    extraHeaders,
  );
};

const UNMEASURED = {
  model: null,
  attempts: 0,
  usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  costNanoEur: 0,
};

const failedMidStream = (context: RequestContext, error: unknown): Finished => {
  if (!(error instanceof Rejection)) {
    logEvent("unhandled", {
      requestId: context.requestId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { status: 500, outcome: "internal", body: INTERNAL_BODY, ...UNMEASURED };
  }
  return {
    status: error.status,
    outcome: error.code,
    body: {
      error: error.code,
      ...(error.publicMessage === undefined ? {} : { message: error.publicMessage }),
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
    },
    ...UNMEASURED,
  };
};

const deltaEmitter = (
  call: Call,
  emit: Emit | undefined,
  delivery: Delivery,
): ((text: string) => void) | undefined =>
  emit === undefined
    ? undefined
    : (text) => {
        if (text === "") {
          return;
        }
        delivery.ttftMs ??= Date.now() - call.context.startedAt;
        emit({ type: "delta", text });
      };

const gatedResponse = async (call: Call, agent: GatedAgent): Promise<Response> => {
  const input: RunInput = {
    spend: call.spend,
    agent,
    messages: parseConversation(call.body, agent.input),
  };
  const reservation = await reserve(input);
  return deliver(call, async (emit, delivery) => {
    const gate = new GateStream();
    const send = deltaEmitter(call, emit, delivery);
    return answer(
      input,
      reservation,
      send === undefined
        ? undefined
        : (text) => {
            send(gate.push(text));
          },
    );
  });
};

const quotaFor = (call: Call): QuotaPort => {
  const { env } = call.context;
  const name = `quota:${call.tenant.id}:${call.principal.subjectId}`;
  return env.SUBJECT.get(env.SUBJECT.idFromName(name));
};

const assertPinned = async (contract: Contract, claimed: string | undefined): Promise<void> => {
  if (claimed !== undefined && claimed !== (await contractHash(contract))) {
    throw new Rejection(409, "contract_changed", {
      message: "This app's tools are out of date. Update the app.",
    });
  }
};

const heldListeners = (agent: ChatAgent, send: ((text: string) => void) | undefined): Listeners => {
  if (send === undefined) {
    return {};
  }
  const held = createChatStream({
    holdChars: agent.streamHoldChars,
    maxChars: agent.input.maxReplyChars,
  });
  return {
    onText: (text) => {
      send(held.push(text));
    },
    onTool: () => {
      held.tool();
    },
  };
};

const statelessResponse = async (call: Call, agent: ChatAgent): Promise<Response> => {
  const parsed = parseChat(call.body, agent);
  await assertPinned(parsed.contract, parsed.contractHash);
  const turn: ChatTurn = {
    spend: call.spend,
    agent,
    principal: call.principal,
    contract: parsed.contract,
    quota: quotaFor(call),
    messages: parsed.messages,
    context: parsed.context,
    toolRounds: parsed.toolRounds,
  };
  return deliver(call, async (emit, delivery) =>
    chatRound(turn, heldListeners(agent, deltaEmitter(call, emit, delivery))),
  );
};

const BAD_KEY_MESSAGE = "Idempotency-Key must be 1 to 128 visible ASCII characters.";

const idempotencyKeyOf = (request: Request): string | null => {
  const reading = readIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!reading.ok) {
    throw new Rejection(400, "bad_idempotency_key", { message: BAD_KEY_MESSAGE });
  }
  return reading.key;
};

const sessionIdOf = async (
  call: Call,
  given: string | undefined,
  key: string | null,
): Promise<string> => {
  if (given !== undefined) {
    return given;
  }
  return key === null ? crypto.randomUUID() : sessionIdFor(call.principal.subjectId, key);
};

interface StoredSessionTarget {
  parsed: StoredTurn;
  sessionId: string;
  key: string | null;
  fingerprint: string;
}

const buildSessionTurn = async (
  call: Call,
  agent: ChatAgent,
  target: StoredSessionTarget,
): Promise<{ turn: SessionTurn; prepared: PreparedTurn }> => {
  const { parsed, sessionId, key, fingerprint } = target;
  await assertPinned(parsed.contract, parsed.contractHash);
  const store = sessionPort(sessionStub(call.context.env, call.tenant.id, sessionId), {
    owner: call.principal.subjectId,
    key,
    fingerprint,
    tail: agent.input.maxMessages,
  });
  const turn: SessionTurn = {
    base: {
      spend: call.spend,
      agent,
      principal: call.principal,
      contract: parsed.contract,
      quota: quotaFor(call),
      context: parsed.context,
    },
    store,
    input: parsed.input,
    tools: toolRuntimeFor(call.context, call.tenant, call.principal),
    listenersForRound: () => ({}),
  };
  return { turn, prepared: await prepareSessionTurn(turn) };
};

const storedResponse = async (call: Call, agent: ChatAgent): Promise<Response> => {
  const key = idempotencyKeyOf(call.context.request);
  const parsed = parseStoredTurn(call.body, agent);
  const sessionId = await sessionIdOf(call, parsed.sessionId, key);
  const fingerprint = await fingerprintOf(call.body);
  const { turn, prepared } = await buildSessionTurn(call, agent, {
    parsed,
    sessionId,
    key,
    fingerprint,
  });
  const extra = prepared.kind === "replay" ? replayHeaders({ replayed: true }) : undefined;
  return deliver(
    call,
    async (emit, delivery) => {
      const send = deltaEmitter(call, emit, delivery);
      const run = await finishSessionTurn(
        { ...turn, listenersForRound: () => heldListeners(agent, send) },
        prepared,
      );
      return { ...run, body: { sessionId, ...run.body } };
    },
    extra,
  );
};

const respond = async (context: RequestContext, tenant: Tenant): Promise<Response> => {
  assertOrigin(context.request, tenant);
  const rawBody = await readBoundedBytes(context.request, tenant.agent.input.maxBodyBytes);
  const principal = await authenticate(context, tenant, rawBody);
  const call: Call = {
    context,
    tenant,
    principal,
    spend: await spendFor(context, tenant, principal),
    body: new TextDecoder().decode(rawBody),
  };
  const { agent } = tenant;
  if (agent.kind === "gated") {
    return gatedResponse(call, agent);
  }
  return agent.state === "stored" ? storedResponse(call, agent) : statelessResponse(call, agent);
};

const messageOf = (tenant: Tenant, rejection: Rejection): { message?: string } => {
  const message = tenant.messages[rejection.code] ?? rejection.publicMessage;
  return message === undefined ? {} : { message };
};

export const rejected = (
  context: RequestContext,
  tenant: Tenant,
  rejection: Rejection,
): Response => {
  recordRejected(context, tenant.id, rejection);
  const response = rejectionResponse(
    new Rejection(rejection.status, rejection.code, {
      ...(rejection.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: rejection.retryAfterSeconds }),
      ...messageOf(tenant, rejection),
    }),
  );
  return rejection.code === "origin"
    ? response
    : withHeaders(response, corsHeaders(context.request, tenant.authn.allowedOrigins));
};

export const handleRun = async (context: RequestContext, tenantId: string): Promise<Response> => {
  const tenant = await loadTenant(context.env, tenantId);
  if (tenant === null) {
    return json({ error: "not_found" }, 404);
  }
  try {
    const response = await respond(context, tenant);
    return withHeaders(response, corsHeaders(context.request, tenant.authn.allowedOrigins));
  } catch (error) {
    if (error instanceof Rejection) {
      return rejected(context, tenant, error);
    }
    throw error;
  }
};
