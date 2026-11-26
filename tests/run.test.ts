import { describe, expect, it } from "vitest";

import demo from "../examples/tenants/demo.tenant.json" with { type: "json" };
import type { RunInput } from "../src/agent/run";
import { answer, reserve } from "../src/agent/run";
import type { LedgerPort } from "../src/agent/spend";
import { limitsOf } from "../src/agent/spend";
import { Rejection } from "../src/http/respond";
import type { BreakerState } from "../src/llm/breaker";
import { createBreaker, FAILURE_WINDOW_MS, OPEN_MS } from "../src/llm/breaker";
import type { ModelId, Tier } from "../src/llm/catalog";
import type { HealthReport } from "../src/llm/health-object";
import type { FailureKind, ModelReply, Provider } from "../src/llm/provider";
import { routeWithFallback, RoutingFailure } from "../src/llm/router";
import type { HealthPort } from "../src/llm/shared-breaker";
import { forgetSharedBreaker, sharedBreaker } from "../src/llm/shared-breaker";
import type { LedgerState } from "../src/quota/ledger";
import { begin, emptyState, release, reservedNanoEur, settle } from "../src/quota/ledger";
import type { GatedAgent, Tenant } from "../src/tenants/schema";
import { tenantSchema } from "../src/tenants/schema";

const tenant: Tenant = tenantSchema.parse(demo);

const gatedAgent = (): GatedAgent => {
  if (tenant.agent.kind !== "gated") {
    throw new Error("the example tenant is gated");
  }
  return tenant.agent;
};

interface Book {
  state: LedgerState;
  port: LedgerPort;
}

const createBook = (): Book => {
  const book: Book = {
    state: emptyState(Date.now()),
    port: {
      begin: (input) => {
        const step = begin(book.state, input);
        book.state = step.state;
        return Promise.resolve(step.result);
      },
      settle: (input) => {
        book.state = settle(book.state, input).state;
        return Promise.resolve();
      },
      release: (input) => {
        book.state = release(book.state, input).state;
        return Promise.resolve();
      },
    },
  };
  return book;
};

const TIMEOUT = new Error("timeout");
const ABORTED = new Error("aborted");
const REJECTED = new Error("rejected");
const USAGE = { input: 1000, output: 100, cacheWrite: 0, cacheRead: 0 };
const GOOD: ModelReply = {
  text: '{"on_topic": true, "answer": "Yes."}',
  blocks: [],
  stopReason: "end_turn",
  usage: USAGE,
};

type Behaviour = (model: ModelId, onText: ((text: string) => void) | undefined) => ModelReply;

const providerThat = (behaviour: Behaviour): Provider & { models: ModelId[] } => {
  const models: ModelId[] = [];
  return {
    models,
    failureKind: (error) => {
      if (error === TIMEOUT) {
        return "timeout";
      }
      if (error === ABORTED) {
        return "aborted";
      }
      return error === REJECTED ? "rejected" : "unavailable";
    },
    complete: (model, _request, listeners) => {
      models.push(model);
      try {
        return Promise.resolve(behaviour(model, listeners.onText));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error("failed"));
      }
    },
  };
};

const inputFor = (tier: Tier, provider: Provider, book: Book): RunInput => ({
  spend: {
    tenant,
    tier,
    effortOverride: null,
    ip: "1.1.1.1",
    skipNetworkLimit: false,
    provider,
    breaker: createBreaker(),
    ledger: book.port,
  },
  agent: gatedAgent(),
  messages: [{ role: "user", content: "Does Lumen sync?" }],
});

describe("run", () => {
  it("settles at the real cost of the model that answered", async () => {
    const book = createBook();
    const input = inputFor(
      "fast",
      providerThat(() => GOOD),
      book,
    );
    const run = await answer(input, await reserve(input), undefined);
    expect(run).toMatchObject({ status: 200, outcome: "answered", model: "claude-haiku-5-5" });
    expect(run.costNanoEur).toBe(Math.round((1000 * 100 + 100 * 500) / 1.08));
    expect(book.state.spentNanoEur).toBe(run.costNanoEur);
    expect(reservedNanoEur(book.state)).toBe(0);
  });

  it("falls back to the next model when the first fails before writing anything", async () => {
    const book = createBook();
    const provider = providerThat((model) => {
      if (model === "claude-sonnet-5-5") {
        throw new Error("overloaded");
      }
      return GOOD;
    });
    const input = inputFor("balanced", provider, book);
    const run = await answer(input, await reserve(input), undefined);
    expect(provider.models).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(run).toMatchObject({ status: 200, model: "claude-haiku-5-5", attempts: 2 });
  });

  it("gives the reservation back when every model fails before writing anything", async () => {
    const book = createBook();
    const provider = providerThat(() => {
      throw new Error("down");
    });
    const input = inputFor("balanced", provider, book);
    const run = await answer(input, await reserve(input), undefined);
    expect(run).toMatchObject({ status: 502, outcome: "upstream", costNanoEur: 0, attempts: 2 });
    expect(book.state.spentNanoEur).toBe(0);
    expect(reservedNanoEur(book.state)).toBe(0);
  });

  it("counts a timeout as spent and does not try another model", async () => {
    const book = createBook();
    const provider = providerThat(() => {
      throw TIMEOUT;
    });
    const input = inputFor("balanced", provider, book);
    const reservation = await reserve(input);
    const run = await answer(input, reservation, undefined);
    expect(provider.models).toEqual(["claude-sonnet-5-5"]);
    expect(run).toMatchObject({ status: 502, outcome: "upstream_billed" });
    expect(book.state.spentNanoEur).toBe(reservation.nanoEur);
  });

  it("counts a stream that broke after it began as spent, with no silent retry", async () => {
    const book = createBook();
    const provider = providerThat((_model, onText) => {
      onText?.('{"on_topic": true, "answer": "Par');
      throw new Error("connection lost");
    });
    const input = inputFor("balanced", provider, book);
    const reservation = await reserve(input);
    const heard: string[] = [];
    const run = await answer(input, reservation, (text) => heard.push(text));
    expect(provider.models).toHaveLength(1);
    expect(heard).toHaveLength(1);
    expect(run.outcome).toBe("upstream_billed");
    expect(book.state.spentNanoEur).toBe(reservation.nanoEur);
  });

  it("stops without trying another model when the caller has gone, and bills nothing unwritten", async () => {
    const book = createBook();
    const provider = providerThat(() => {
      throw ABORTED;
    });
    const input = inputFor("balanced", provider, book);
    const run = await answer(input, await reserve(input), undefined);
    expect(provider.models).toEqual(["claude-sonnet-5-5"]);
    expect(run).toMatchObject({ status: 499, outcome: "client_closed", costNanoEur: 0 });
    expect(reservedNanoEur(book.state)).toBe(0);
  });

  it("counts a reply that broke after it began as spent even when nobody was listening", async () => {
    const book = createBook();
    const provider = providerThat((_model, onText) => {
      onText?.("Par");
      throw new Error("connection lost");
    });
    const input = inputFor("balanced", provider, book);
    const run = await answer(input, await reserve(input), undefined);
    expect(provider.models).toHaveLength(1);
    expect(run.outcome).toBe("upstream_billed");
  });

  it("refuses with the limit's public message when the pool cannot cover the reservation", async () => {
    const book = createBook();
    const input = inputFor(
      "fast",
      providerThat(() => GOOD),
      book,
    );
    const poor = { ...tenant, limits: { ...tenant.limits, poolEurPerMonth: 0 } };
    const refusal = await reserve({ ...input, spend: { ...input.spend, tenant: poor } }).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(Rejection);
    expect(refusal).toMatchObject({ status: 429, code: "budget" });
    expect(limitsOf(poor).poolNanoEur).toBe(0);
  });
});

describe("circuit breaker", () => {
  const SONNET = "claude-sonnet-5-5";
  const HAIKU = "claude-haiku-5-5";
  const failingWith =
    (kind: FailureKind, breaker = createBreaker()) =>
    async (): Promise<unknown> =>
      routeWithFallback({
        candidates: [SONNET, HAIKU],
        breaker,
        failureKind: () => kind,
        hasStarted: () => false,
        call: (model) =>
          model === SONNET ? Promise.reject(new Error("no")) : Promise.resolve(GOOD),
      }).catch((error: unknown) => error);

  it("skips a model that failed three times in a row, then tries it again after a pause", async () => {
    const breaker = createBreaker();
    const route = failingWith("unavailable", breaker);
    await route();
    await route();
    expect(breaker.order([SONNET, HAIKU], Date.now())).toEqual([SONNET, HAIKU]);
    await route();
    expect(breaker.order([SONNET, HAIKU], Date.now())).toEqual([HAIKU]);
    expect(breaker.isOpen(SONNET, Date.now())).toBe(true);
    expect(breaker.isOpen(SONNET, Date.now() + OPEN_MS + 1000)).toBe(false);
  });

  it("still tries the only model there is when its circuit is open", () => {
    const breaker = createBreaker();
    const now = Date.now();
    breaker.failed(HAIKU, now);
    breaker.failed(HAIKU, now);
    breaker.failed(HAIKU, now);
    expect(breaker.order([HAIKU], now)).toEqual([HAIKU]);
  });

  it("closes a circuit as soon as the model answers", () => {
    const breaker = createBreaker();
    breaker.failed(HAIKU, 0);
    breaker.failed(HAIKU, 0);
    breaker.succeeded(HAIKU);
    breaker.failed(HAIKU, 0);
    expect(breaker.isOpen(HAIKU, 0)).toBe(false);
  });

  it("forgets failures older than the window, so scattered ones never add up", () => {
    const breaker = createBreaker();
    breaker.failed(HAIKU, 0);
    breaker.failed(HAIKU, 1000);
    breaker.failed(HAIKU, FAILURE_WINDOW_MS + 500);
    expect(breaker.isOpen(HAIKU, FAILURE_WINDOW_MS + 500)).toBe(false);
    breaker.failed(HAIKU, FAILURE_WINDOW_MS + 900);
    expect(breaker.isOpen(HAIKU, FAILURE_WINDOW_MS + 900)).toBe(true);
  });

  it("reopens at once when the first try after the pause fails", () => {
    const breaker = createBreaker();
    [0, 1, 2].forEach((at) => {
      breaker.failed(HAIKU, at);
    });
    const afterPause = FAILURE_WINDOW_MS + OPEN_MS - 1000;
    expect(breaker.isOpen(HAIKU, afterPause)).toBe(false);
    breaker.failed(HAIKU, afterPause);
    expect(breaker.isOpen(HAIKU, afterPause)).toBe(true);
  });

  it("does not hold a refused request or a caller who left against the model", async () => {
    const breaker = createBreaker();
    for (const kind of ["rejected", "rejected", "rejected", "aborted", "aborted"] as const) {
      await failingWith(kind, breaker)();
    }
    expect(breaker.isOpen(SONNET, Date.now())).toBe(false);
    const left = await failingWith("aborted", breaker)();
    expect(left).toBeInstanceOf(RoutingFailure);
    expect(left).toMatchObject({ detail: { aborted: true, attempts: 1 } });
    const rejected = await failingWith("rejected", breaker)();
    expect(rejected).toBeInstanceOf(RoutingFailure);
    expect(rejected).toMatchObject({ detail: { aborted: false, billable: false, attempts: 1 } });
  });

  it("shares what one worker copy learned with the next, without waiting on the request path", async () => {
    let stored: BreakerState = {};
    const reports: HealthReport[] = [];
    const health: HealthPort = {
      snapshot: () => Promise.resolve(stored),
      report: (input) => {
        reports.push(input);
        return Promise.resolve(stored);
      },
    };
    const deferred: Promise<unknown>[] = [];
    const options = { health, defer: (work: Promise<unknown>) => deferred.push(work), now: 0 };
    forgetSharedBreaker();
    const first = await sharedBreaker(options);
    first.succeeded(HAIKU);
    expect(reports).toHaveLength(0);
    first.failed(SONNET, 5);
    first.succeeded(SONNET);
    expect(reports.map((report) => report.ok)).toEqual([false, true]);
    await Promise.all(deferred);
    stored = { [SONNET]: { failures: [1, 2, 3], openedAt: 3 } };
    forgetSharedBreaker();
    const second = await sharedBreaker(options);
    expect(second.isOpen(SONNET, 10)).toBe(true);
    expect(second.order([SONNET, HAIKU], 10)).toEqual([HAIKU]);
    forgetSharedBreaker();
  });
});
