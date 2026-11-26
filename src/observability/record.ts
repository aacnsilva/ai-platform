import type { Env } from "../env";
import type { RunEvent } from "./events";
import { logEvent } from "./log";

export const recordRun = (env: Env, ctx: ExecutionContext, event: RunEvent): void => {
  logEvent("run", { ...event });
  const metrics = env.METRICS.get(env.METRICS.idFromName("global"));
  ctx.waitUntil(
    metrics.record(event).catch((error: unknown) => {
      logEvent("metrics_failed", {
        requestId: event.requestId,
        message: error instanceof Error ? error.message : "unknown",
      });
    }),
  );
};
