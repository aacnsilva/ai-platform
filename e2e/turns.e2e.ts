import { beforeAll, describe, expect, it } from "vitest";

import type { CreatedTenant, Reply } from "./support/chat.ts";
import { createChatTenant, post, postWith, serverTools, tokenFor, turn } from "./support/chat.ts";
import { ALLOWED_ORIGIN, eventually, providerCalls, runtimeUrl } from "./support/client.ts";
import type { RecordedCall } from "./support/mock-provider.ts";

interface Transcript {
  messages: { role: string; text: string }[];
  nextBefore?: number;
}

const transcriptOf = async (
  tenant: CreatedTenant,
  token: string,
  sessionPath: string,
): Promise<Transcript> =>
  (await (
    await fetch(`${runtimeUrl()}/v1/tenants/${tenant.id}/sessions/${sessionPath}`, {
      headers: { authorization: `Bearer ${token}`, origin: ALLOWED_ORIGIN },
    })
  ).json()) as Transcript;

const callsAbout = async (marker: string): Promise<RecordedCall[]> =>
  (await providerCalls()).filter((call) => call.question.includes(marker));

describe("turns on a stored session", () => {
  let tenant: CreatedTenant;
  let frugal: CreatedTenant;

  const keyed = async (token: string, body: unknown, key: string): Promise<Reply> =>
    postWith({ tenantId: tenant.id, token, body, headers: { "idempotency-key": key } });

  beforeAll(async () => {
    tenant = await createChatTenant({ state: "stored", tools: serverTools() });
    frugal = await createChatTenant({
      state: "stored",
      tools: serverTools(),
      agent: { input: { maxConversationTokens: 250 } },
    });
  });

  it("locks the session for the turn: of two at once, one answers and one model call is paid", async () => {
    const token = await tokenFor(tenant, "t-race", "pro");
    const sessionId = (await post(tenant.id, token, turn("RACE opening question"))).body.sessionId;
    const replies = await Promise.all([
      post(tenant.id, token, turn("RACE-A SLOW question", sessionId)),
      post(tenant.id, token, turn("RACE-B SLOW question", sessionId)),
    ]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    const refused = replies.find((reply) => reply.status === 409);
    expect(refused?.body.error).toBe("session_busy");
    expect(refused?.headers.get("retry-after")).toBe("1");
    expect(await callsAbout("SLOW question")).toHaveLength(1);
    const after = await post(tenant.id, token, turn("RACE closing question", sessionId));
    expect(after.status).toBe(200);
    expect((await transcriptOf(tenant, token, sessionId ?? "")).messages).toHaveLength(6);
  });

  it("answers a retried turn once: same reply, one model call, one message counted and stored", async () => {
    const token = await tokenFor(tenant, "t-retry", "pro");
    const sessionId = (await post(tenant.id, token, turn("IDEM opening"))).body.sessionId ?? "";
    const first = await keyed(token, turn("IDEM-RETRIED question", sessionId), "retry-1");
    const again = await keyed(token, turn("IDEM-RETRIED question", sessionId), "retry-1");
    expect(first.status).toBe(200);
    expect(first.headers.get("idempotent-replay")).toBeNull();
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replay")).toBe("true");
    expect(again.body).toEqual(first.body);
    expect(first.body.quota).toEqual({ used: 2, limit: 50 });
    expect(await callsAbout("IDEM-RETRIED")).toHaveLength(1);
    expect((await transcriptOf(tenant, token, sessionId)).messages).toHaveLength(4);
    const next = await post(tenant.id, token, turn("IDEM after the retry", sessionId));
    expect(next.body.quota).toEqual({ used: 3, limit: 50 });
  });

  it("gives the retry of a first turn the same session instead of opening a second one", async () => {
    const token = await tokenFor(tenant, "t-first", "pro");
    const first = await keyed(token, turn("IDEM-FIRST question"), "first-1");
    const again = await keyed(token, turn("IDEM-FIRST question"), "first-1");
    expect(first.body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(again.body).toEqual(first.body);
    expect(await callsAbout("IDEM-FIRST")).toHaveLength(1);
  });

  it("refuses a key that returns with another request, or that is not a key", async () => {
    const token = await tokenFor(tenant, "t-misuse", "pro");
    const first = await keyed(token, turn("IDEM-MISUSE one"), "misuse-1");
    const sessionId = first.body.sessionId ?? "";
    const other = await keyed(token, turn("IDEM-MISUSE two", sessionId), "misuse-1");
    expect(other.status).toBe(422);
    expect(other.body.error).toBe("idempotency_key_reused");
    const malformed = await keyed(token, turn("IDEM-MISUSE three", sessionId), "two words");
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe("bad_idempotency_key");
    expect(await callsAbout("IDEM-MISUSE")).toHaveLength(1);
  });

  it("keeps every turn in the transcript while the model is sent only what fits the token budget", async () => {
    const token = await tokenFor(frugal, "t-budget", "pro");
    const sessionId = (await post(frugal.id, token, turn("BUDGET first"))).body.sessionId ?? "";
    await post(frugal.id, token, turn("BUDGET second", sessionId));
    await post(frugal.id, token, turn("BUDGET third", sessionId));
    const calls = await callsAbout("BUDGET");
    expect(calls.map((call) => call.messageCount)).toEqual([1, 1, 1]);
    const transcript = await transcriptOf(frugal, token, sessionId);
    expect(transcript.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(transcript.messages[0]?.text).toBe("BUDGET first");
  });

  it("stops the model call when the client hangs up mid-stream, and frees the session", async () => {
    const token = await tokenFor(tenant, "t-hangup", "pro");
    const sessionId = (await post(tenant.id, token, turn("HANGUP opening"))).body.sessionId ?? "";
    const abort = new AbortController();
    const response = await fetch(`${runtimeUrl()}/v1/tenants/${tenant.id}/runs`, {
      method: "POST",
      signal: abort.signal,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        origin: ALLOWED_ORIGIN,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(turn("HANGUP-SLOW question", sessionId)),
    });
    await response.body?.getReader().read();
    abort.abort();
    const calls = await eventually(
      async () => callsAbout("HANGUP-SLOW"),
      (found) => found[0]?.cancelled === true,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cancelled).toBe(true);
    const next = await eventually(
      async () => post(tenant.id, token, turn("HANGUP after", sessionId)),
      (reply) => reply.status === 200,
    );
    expect(next.status).toBe(200);
    expect((await transcriptOf(tenant, token, sessionId)).messages).toHaveLength(4);
  });

  it("retires an idempotency key after an unkeyed turn commits", async () => {
    const token = await tokenFor(tenant, "t-retire", "pro");
    const first = await keyed(token, turn("RETIRE one"), "retire-1");
    const sessionId = first.body.sessionId ?? "";
    expect((await post(tenant.id, token, turn("RETIRE two", sessionId))).status).toBe(200);
    const stale = await keyed(token, turn("RETIRE one", sessionId), "retire-1");
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("idempotency_key_spent");
  });

  it("returns HTTP 409 on SSE session_busy and marks streamed replays", async () => {
    const token = await tokenFor(tenant, "t-sse", "pro");
    const opening = await keyed(token, turn("SSE-REPLAY first"), "sse-1");
    const sessionId = opening.body.sessionId ?? "";
    const replayRes = await fetch(`${runtimeUrl()}/v1/tenants/${tenant.id}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        origin: ALLOWED_ORIGIN,
        authorization: `Bearer ${token}`,
        "idempotency-key": "sse-1",
      },
      body: JSON.stringify(turn("SSE-REPLAY first")),
    });
    expect(replayRes.status).toBe(200);
    expect(replayRes.headers.get("idempotent-replay")).toBe("true");
    expect(await replayRes.text()).toContain('"replayed":true');
    const [first, second] = await Promise.all([
      post(tenant.id, token, turn("SSE-BUSY-A SLOW", sessionId)),
      fetch(`${runtimeUrl()}/v1/tenants/${tenant.id}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          origin: ALLOWED_ORIGIN,
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(turn("SSE-BUSY-B SLOW", sessionId)),
      }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    if (second.status === 409) {
      expect(second.headers.get("retry-after")).toBe("1");
      expect(await second.json()).toMatchObject({ error: "session_busy", retryAfterSeconds: 1 });
    }
  });

  it("paginates a session transcript with limit and before", async () => {
    const token = await tokenFor(tenant, "t-page", "pro");
    const sessionId = (await post(tenant.id, token, turn("PAGE one"))).body.sessionId ?? "";
    await post(tenant.id, token, turn("PAGE two", sessionId));
    await post(tenant.id, token, turn("PAGE three", sessionId));
    const latest = await transcriptOf(tenant, token, `${sessionId}?limit=2`);
    expect(latest.messages.map((message) => message.text)).toEqual([
      "PAGE three",
      expect.any(String),
    ]);
    expect(latest.nextBefore).toBe(4);
    const middle = await transcriptOf(tenant, token, `${sessionId}?limit=2&before=4`);
    expect(middle.messages[0]?.text).toBe("PAGE two");
    expect(middle.nextBefore).toBe(2);
    const oldest = await transcriptOf(tenant, token, `${sessionId}?limit=2&before=2`);
    expect(oldest.messages[0]?.text).toBe("PAGE one");
    expect(oldest.nextBefore).toBeUndefined();
  });
});
