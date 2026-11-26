import type { Breaker } from "./breaker";
import type { Candidates, ModelId } from "./catalog";
import type { FailureKind, ModelReply } from "./provider";

export interface Routed {
  reply: ModelReply;
  model: ModelId;
  attempts: number;
}

export interface RoutingFailureDetail {
  model: ModelId;
  attempts: number;
  billable: boolean;
  aborted: boolean;
}

export class RoutingFailure extends Error {
  readonly detail: RoutingFailureDetail;

  constructor(detail: RoutingFailureDetail) {
    super("routing_failed");
    this.detail = detail;
  }
}

export interface RouteOptions {
  candidates: Candidates;
  breaker: Breaker;
  call: (model: ModelId) => Promise<ModelReply>;
  failureKind: (error: unknown) => FailureKind;
  hasStarted: () => boolean;
}

const COUNTS_AGAINST_MODEL: Record<FailureKind, boolean> = {
  unavailable: true,
  timeout: true,
  rejected: false,
  aborted: false,
};

export const routeWithFallback = async (options: RouteOptions): Promise<Routed> => {
  const { breaker } = options;
  const ordered = breaker.order(options.candidates, Date.now());
  let attempts = 0;
  let last: RoutingFailureDetail = {
    model: ordered[0],
    attempts,
    billable: false,
    aborted: false,
  };
  for (const model of ordered) {
    attempts += 1;
    try {
      const reply = await options.call(model);
      breaker.succeeded(model);
      return { reply, model, attempts };
    } catch (cause) {
      const kind = options.failureKind(cause);
      if (COUNTS_AGAINST_MODEL[kind]) {
        breaker.failed(model, Date.now());
      }
      const billable = options.hasStarted() || kind === "timeout";
      last = { model, attempts, billable, aborted: kind === "aborted" };
      if (billable || last.aborted || kind === "rejected") {
        break;
      }
    }
  }
  throw new RoutingFailure(last);
};
