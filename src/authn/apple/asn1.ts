import { Buffer } from "./buffer";
import { AppleFormatError } from "./errors";

const TAG_BOOLEAN = 0x01;
const TAG_OCTET_STRING = 0x04;
const TAG_OID = 0x06;
const TAG_SEQUENCE = 0x30;
const TAG_CONTEXT_1 = 0xa1;
const TAG_CONTEXT_3 = 0xa3;

export interface DerElement {
  readonly tag: number;
  readonly value: Buffer;
  readonly offset: number;
}

interface DerLength {
  readonly length: number;
  readonly cursor: number;
}

const readLongLength = (buf: Buffer, cursor: number, count: number): DerLength => {
  if (count === 0 || count > 3 || cursor + count > buf.length) {
    throw new AppleFormatError("der_length");
  }
  return { length: buf.readUIntBE(cursor, count), cursor: cursor + count };
};

const readLength = (buf: Buffer, cursor: number): DerLength => {
  if (cursor >= buf.length) {
    throw new AppleFormatError("der_truncated");
  }
  const first = buf.readUInt8(cursor);
  if ((first & 0x80) === 0) {
    return { length: first, cursor: cursor + 1 };
  }
  return readLongLength(buf, cursor + 1, first & 0x7f);
};

export const readDer = (buf: Buffer, offset: number): DerElement => {
  if (offset >= buf.length) {
    throw new AppleFormatError("der_truncated");
  }
  const tag = buf.readUInt8(offset);
  const { length, cursor } = readLength(buf, offset + 1);
  const end = cursor + length;
  if (end > buf.length) {
    throw new AppleFormatError("der_truncated");
  }
  return { tag, value: buf.subarray(cursor, end), offset: end };
};

const oidHeader = (oid: Uint8Array): Buffer =>
  Buffer.concat([Buffer.from([TAG_OID, oid.length]), oid]);

export const derContainsOid = (der: Uint8Array, oid: Uint8Array): boolean =>
  Buffer.from(der).includes(oidHeader(oid));

const octetStringAfterOid = (buf: Buffer, afterOid: number): Buffer | null => {
  const cursor = buf[afterOid] === TAG_BOOLEAN ? readDer(buf, afterOid).offset : afterOid;
  if (buf[cursor] !== TAG_OCTET_STRING) {
    return null;
  }
  return Buffer.from(readDer(buf, cursor).value);
};

export const extensionValue = (der: Uint8Array, oid: Uint8Array): Buffer | null => {
  const buf = Buffer.from(der);
  const needle = oidHeader(oid);
  let from = 0;
  while (from < buf.length) {
    const found = buf.indexOf(needle, from);
    if (found === -1) {
      return null;
    }
    const value = octetStringAfterOid(buf, found + needle.length);
    if (value !== null) {
      return value;
    }
    from = found + 1;
  }
  return null;
};

export const octetStringInsideSequence = (der: Buffer): Buffer | null => {
  const sequence = readDer(der, 0);
  if (sequence.tag !== TAG_SEQUENCE) {
    return null;
  }
  const first = readDer(sequence.value, 0);
  const inner = first.tag === TAG_CONTEXT_1 ? readDer(first.value, 0) : first;
  if (inner.tag !== TAG_OCTET_STRING) {
    return null;
  }
  return Buffer.from(inner.value);
};

const tbsExtensionsBlock = (der: Uint8Array): Buffer | null => {
  const cert = readDer(Buffer.from(der), 0);
  if (cert.tag !== TAG_SEQUENCE) {
    return null;
  }
  const tbs = readDer(cert.value, 0);
  if (tbs.tag !== TAG_SEQUENCE) {
    return null;
  }
  let cursor = 0;
  while (cursor < tbs.value.length) {
    const field = readDer(tbs.value, cursor);
    if (field.tag === TAG_CONTEXT_3) {
      const seq = readDer(field.value, 0);
      return seq.tag === TAG_SEQUENCE ? seq.value : null;
    }
    cursor = field.offset;
  }
  return null;
};

const matchExtension = (entry: Buffer, oid: Buffer): Buffer | null => {
  const id = readDer(entry, 0);
  if (id.tag !== TAG_OID || !id.value.equals(oid)) {
    return null;
  }
  let next = readDer(entry, id.offset);
  if (next.tag === TAG_BOOLEAN) {
    next = readDer(entry, next.offset);
  }
  return next.tag === TAG_OCTET_STRING ? Buffer.from(next.value) : null;
};

const scanExtensions = (block: Buffer, target: Buffer): Buffer | null => {
  let cursor = 0;
  while (cursor < block.length) {
    const ext = readDer(block, cursor);
    const matched = ext.tag === TAG_SEQUENCE ? matchExtension(ext.value, target) : null;
    if (matched !== null) {
      return matched;
    }
    cursor = ext.offset;
  }
  return null;
};

export const certExtensionValue = (der: Uint8Array, oid: Uint8Array): Buffer | null => {
  try {
    const block = tbsExtensionsBlock(der);
    return block === null ? null : scanExtensions(block, Buffer.from(oid));
  } catch {
    return null;
  }
};

export const certHasExtensionOid = (der: Uint8Array, oid: Uint8Array): boolean =>
  certExtensionValue(der, oid) !== null;
