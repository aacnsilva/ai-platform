import { Buffer } from "./buffer";
import { AppleFormatError } from "./errors";

export type CborValue = number | string | Uint8Array | CborValue[] | Map<CborValue, CborValue>;

export interface CborItem {
  readonly value: CborValue;
  readonly offset: number;
}

const MAX_DEPTH = 16;

interface CborHeader {
  readonly length: number;
  readonly offset: number;
}

const requireBytes = (buf: Buffer, end: number): void => {
  if (end > buf.length) {
    throw new AppleFormatError("cbor_truncated");
  }
};

const readLength = (buf: Buffer, offset: number, additional: number): CborHeader => {
  if (additional < 24) {
    return { length: additional, offset };
  }
  if (additional === 24) {
    requireBytes(buf, offset + 1);
    return { length: buf.readUInt8(offset), offset: offset + 1 };
  }
  if (additional === 25) {
    requireBytes(buf, offset + 2);
    return { length: buf.readUInt16BE(offset), offset: offset + 2 };
  }
  if (additional === 26) {
    requireBytes(buf, offset + 4);
    return { length: buf.readUInt32BE(offset), offset: offset + 4 };
  }
  throw new AppleFormatError("cbor_unsupported");
};

const readString = (buf: Buffer, header: CborHeader, major: number): CborItem => {
  const end = header.offset + header.length;
  requireBytes(buf, end);
  const slice = buf.subarray(header.offset, end);
  return { value: major === 2 ? Buffer.from(slice) : slice.toString("utf8"), offset: end };
};

const readArray = (buf: Buffer, header: CborHeader, depth: number): CborItem => {
  const items: CborValue[] = [];
  let cursor = header.offset;
  let remaining = header.length;
  while (remaining > 0) {
    const item = readNested(buf, cursor, depth);
    items.push(item.value);
    cursor = item.offset;
    remaining -= 1;
  }
  return { value: items, offset: cursor };
};

const readMap = (buf: Buffer, header: CborHeader, depth: number): CborItem => {
  const map = new Map<CborValue, CborValue>();
  let cursor = header.offset;
  let remaining = header.length;
  while (remaining > 0) {
    const key = readNested(buf, cursor, depth);
    const value = readNested(buf, key.offset, depth);
    map.set(key.value, value.value);
    cursor = value.offset;
    remaining -= 1;
  }
  return { value: map, offset: cursor };
};

interface Container {
  header: CborHeader;
  major: number;
  depth: number;
}

const readContainer = (buf: Buffer, container: Container): CborItem => {
  const { header, major, depth } = container;
  if (major === 4) {
    return readArray(buf, header, depth);
  }
  if (major === 5) {
    return readMap(buf, header, depth);
  }
  throw new AppleFormatError("cbor_unsupported");
};

function readNested(buf: Buffer, offset: number, depth: number): CborItem {
  if (depth > MAX_DEPTH) {
    throw new AppleFormatError("cbor_depth");
  }
  requireBytes(buf, offset + 1);
  const initial = buf.readUInt8(offset);
  const major = initial >> 5;
  const header = readLength(buf, offset + 1, initial & 0x1f);
  if (major === 0) {
    return { value: header.length, offset: header.offset };
  }
  if (major === 1) {
    return { value: -1 - header.length, offset: header.offset };
  }
  if (major === 2 || major === 3) {
    return readString(buf, header, major);
  }
  return readContainer(buf, { header, major, depth: depth + 1 });
}

export const readCbor = (buf: Buffer, offset: number): CborItem => readNested(buf, offset, 0);

export const decodeCbor = (bytes: Uint8Array): CborValue => {
  const buf = Buffer.from(bytes);
  const item = readCbor(buf, 0);
  if (item.offset !== buf.length) {
    throw new AppleFormatError("cbor_trailing");
  }
  return item.value;
};

const wideHeader = (major: number, value: number): Buffer => {
  if (value <= 0xffff) {
    const header = Buffer.alloc(3);
    header.writeUInt8((major << 5) | 25, 0);
    header.writeUInt16BE(value, 1);
    return header;
  }
  if (value <= 0xffffffff) {
    const header = Buffer.alloc(5);
    header.writeUInt8((major << 5) | 26, 0);
    header.writeUInt32BE(value, 1);
    return header;
  }
  throw new AppleFormatError("cbor_int");
};

const encodeArgument = (major: number, value: number): Buffer => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppleFormatError("cbor_int");
  }
  if (value < 24) {
    return Buffer.from([(major << 5) | value]);
  }
  if (value <= 0xff) {
    return Buffer.from([(major << 5) | 24, value]);
  }
  return wideHeader(major, value);
};

const encodeNumber = (value: number): Buffer => {
  if (!Number.isInteger(value)) {
    throw new AppleFormatError("cbor_int");
  }
  return value >= 0 ? encodeArgument(0, value) : encodeArgument(1, -1 - value);
};

const encodeMap = (map: ReadonlyMap<CborValue, CborValue>): Buffer => {
  const parts = [encodeArgument(5, map.size)];
  for (const [key, item] of map) {
    parts.push(encodeCbor(key), encodeCbor(item));
  }
  return Buffer.concat(parts);
};

export function encodeCbor(value: CborValue): Buffer {
  if (typeof value === "number") {
    return encodeNumber(value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([encodeArgument(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([encodeArgument(2, value.length), value]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([encodeArgument(4, value.length), ...value.map(encodeCbor)]);
  }
  return encodeMap(value);
}

export const cborTextMap = (map: ReadonlyMap<CborValue, CborValue>): Record<string, CborValue> => {
  const object: Record<string, CborValue> = {};
  for (const [key, value] of map) {
    if (typeof key !== "string") {
      throw new AppleFormatError("cbor_key");
    }
    object[key] = value;
  }
  return object;
};
