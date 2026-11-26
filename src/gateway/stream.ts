import { INTERNAL_BODY } from "../http/respond";
import { logEvent } from "../observability/log";
import type { RequestContext } from "./context";

export type StreamEvent = Record<string, unknown>;
export type Emit = (event: StreamEvent) => void;

const sseHeaders = (extra?: Headers): Headers => {
  const headers = new Headers(extra);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-store");
  return headers;
};

export const streamResponse = (
  context: RequestContext,
  run: (emit: Emit) => Promise<StreamEvent>,
  extra?: Headers,
): Response => {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const clientLeft = (): void => {
    context.abort.abort();
  };
  const send = async (event: StreamEvent): Promise<void> => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)).catch(clientLeft);
  };
  const lastEvent = async (): Promise<StreamEvent> => {
    try {
      return await run((event) => void send(event));
    } catch (error) {
      logEvent("stream_failed", {
        requestId: context.requestId,
        message: error instanceof Error ? error.message : "unknown",
      });
      return { type: "error", ...INTERNAL_BODY };
    }
  };
  const work = async (): Promise<void> => {
    try {
      await send(await lastEvent());
    } finally {
      await writer.close().catch(() => undefined);
    }
  };
  writer.closed.catch(clientLeft);
  context.ctx.waitUntil(work());
  return new Response(readable, { status: 200, headers: sseHeaders(extra) });
};

export const wantsStream = (request: Request): boolean =>
  (request.headers.get("Accept") ?? "").includes("text/event-stream");
