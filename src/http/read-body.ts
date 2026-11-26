import { Rejection } from "./respond";

const tooLarge = (): never => {
  throw new Rejection(400, "too_large");
};

const contentLengthOver = (request: Request, maxBytes: number): boolean => {
  const header = request.headers.get("content-length");
  if (header === null || !/^\d+$/.test(header.trim())) {
    return false;
  }
  return Number(header.trim()) > maxBytes;
};

const joinChunks = (chunks: readonly Uint8Array[], total: number): Uint8Array => {
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
};

export const utf8ByteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

export const readBoundedBytes = async (request: Request, maxBytes: number): Promise<Uint8Array> => {
  if (contentLengthOver(request, maxBytes)) {
    await request.body?.cancel().catch(() => undefined);
    return tooLarge();
  }
  if (request.body === null) {
    return new Uint8Array(0);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next: ReadableStreamReadResult<Uint8Array> = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return tooLarge();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return joinChunks(chunks, total);
};

export const readBoundedText = async (request: Request, maxBytes: number): Promise<string> =>
  new TextDecoder().decode(await readBoundedBytes(request, maxBytes));
