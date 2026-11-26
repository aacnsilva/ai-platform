import { createPublicKey, verify as verifySignature } from "node:crypto";

import { Buffer } from "./buffer";
import type { CertificateInput, VerifiedChain } from "./chain";
import { verifyChain } from "./chain";

export const STOREKIT_LEAF_OID: Buffer = Buffer.from([
  0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x06, 0x0b, 0x01,
]);
export const STOREKIT_INTERMEDIATE_OID: Buffer = Buffer.from([
  0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x06, 0x02, 0x01,
]);

const SUBSCRIPTION = "Auto-Renewable Subscription";
const SIGNED_SKEW_MS = 5 * 60 * 1000;
const MIN_JWS_LENGTH = 20;
const MAX_JWS_LENGTH = 20_000;
const RAW_SIGNATURE_LENGTH = 64;
const IDENTIFIER = /^[0-9A-Za-z]{1,64}$/;

export type StoreKitErrorCode = "unconfigured" | "bad_transaction" | "entitlement_inactive";

export type StoreKitFailureReason =
  | StoreKitErrorCode
  | "jws_shape"
  | "jws_parts"
  | "jws_header"
  | "signature_length"
  | "signed_date"
  | "chain"
  | "signature_key"
  | "signature"
  | "bundle_id"
  | "receipt_type"
  | "app_transaction_id";

export interface StoreKitFailure {
  readonly ok: false;
  readonly error: StoreKitErrorCode;
  readonly reason: StoreKitFailureReason;
}

export interface TransactionSuccess {
  readonly ok: true;
  readonly originalTransactionId: string;
  readonly productId: string;
  readonly environment: string;
  readonly expiresDate: number;
}

export type TransactionResult = TransactionSuccess | StoreKitFailure;

export interface AppTransactionSuccess {
  readonly ok: true;
  readonly appTransactionId: string | null;
  readonly environment: string;
}

export type AppTransactionResult = AppTransactionSuccess | StoreKitFailure;

type StringSet = ReadonlySet<string> | readonly string[];

export interface AppTransactionInput {
  readonly jws: unknown;
  readonly bundleId: string;
  readonly environments: StringSet;
  readonly roots: readonly CertificateInput[] | null | undefined;
  readonly now?: number | undefined;
}

export interface TransactionInput extends AppTransactionInput {
  readonly productIds: StringSet;
}

type Payload = Record<string, unknown>;

interface SignedInput {
  readonly jws: unknown;
  readonly roots: readonly CertificateInput[] | null | undefined;
  readonly now: number;
  readonly signedAt: (payload: Payload) => unknown;
}

interface JwsParts {
  readonly header: Payload;
  readonly payload: Payload;
  readonly signingInput: string;
  readonly signature: Buffer;
}

interface SignedPayload {
  readonly ok: true;
  readonly payload: Payload;
}

const fail = (
  error: StoreKitErrorCode,
  reason: StoreKitFailureReason = error,
): StoreKitFailure => ({ ok: false, error, reason });

const derInteger = (bytes: Buffer): Buffer => {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start += 1;
  }
  const trimmed = bytes.subarray(start);
  const negative = ((trimmed[0] ?? 0) & 0x80) !== 0;
  const body = negative ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed;
  return Buffer.concat([Buffer.from([0x02, body.length]), body]);
};

const derSignature = (signature: Buffer): Buffer => {
  const body = Buffer.concat([
    derInteger(signature.subarray(0, 32)),
    derInteger(signature.subarray(32)),
  ]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
};

const isObject = (value: unknown): value is Payload =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodePart = (part: string): Payload | null => {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return isObject(decoded) ? decoded : null;
  } catch {
    return null;
  }
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const hasChainHeader = (header: Payload | null): header is Payload => {
  if (header?.["alg"] !== "ES256") {
    return false;
  }
  const x5c = header["x5c"];
  return Array.isArray(x5c) && x5c.length >= 2;
};

const hasJwsShape = (jws: unknown): jws is string =>
  typeof jws === "string" &&
  jws.length >= MIN_JWS_LENGTH &&
  jws.length <= MAX_JWS_LENGTH &&
  !/\s/.test(jws);

const splitJws = (jws: unknown): JwsParts | StoreKitFailure => {
  if (!hasJwsShape(jws)) {
    return fail("bad_transaction", "jws_shape");
  }
  const [head, body, tail, ...extra] = jws.split(".");
  if (head === undefined || body === undefined || tail === undefined || extra.length > 0) {
    return fail("bad_transaction", "jws_parts");
  }
  const header = decodePart(head);
  const payload = decodePart(body);
  if (!hasChainHeader(header) || !payload) {
    return fail("bad_transaction", "jws_header");
  }
  const signature = Buffer.from(tail, "base64url");
  if (signature.length !== RAW_SIGNATURE_LENGTH) {
    return fail("bad_transaction", "signature_length");
  }
  return { header, payload, signingInput: `${head}.${body}`, signature };
};

const certificateBytes = (header: Payload, index: number): Buffer | null => {
  const x5c: unknown = header["x5c"];
  const entry: unknown = Array.isArray(x5c) ? x5c[index] : undefined;
  return typeof entry === "string" ? Buffer.from(entry, "base64") : null;
};

const signedByLeaf = (chain: VerifiedChain, parts: JwsParts): StoreKitFailure | null => {
  const signingInput = Buffer.from(parts.signingInput);
  try {
    const key = createPublicKey({
      key: chain.leaf.publicKey.export({ format: "jwk" }),
      format: "jwk",
    });
    const signed = verifySignature("sha256", signingInput, key, derSignature(parts.signature));
    return signed ? null : fail("bad_transaction", "signature");
  } catch {
    return fail("bad_transaction", "signature_key");
  }
};

const chainFailure = (parts: JwsParts, input: SignedInput): StoreKitFailure | null => {
  const leafDer = certificateBytes(parts.header, 0);
  const intermediateDer = certificateBytes(parts.header, 1);
  if (!leafDer || !intermediateDer) {
    return fail("bad_transaction");
  }
  const signedDate = input.signedAt(parts.payload);
  if (!isFiniteNumber(signedDate) || signedDate > input.now + SIGNED_SKEW_MS) {
    return fail("bad_transaction", "signed_date");
  }
  const chain = verifyChain({
    leafDer,
    intermediateDer,
    roots: input.roots,
    now: signedDate,
    leafOid: STOREKIT_LEAF_OID,
    intermediateOid: STOREKIT_INTERMEDIATE_OID,
  });
  return chain ? signedByLeaf(chain, parts) : fail("bad_transaction", "chain");
};

const verifySigned = (input: SignedInput): SignedPayload | StoreKitFailure => {
  if (!input.roots) {
    return fail("unconfigured");
  }
  const parts = splitJws(input.jws);
  if ("error" in parts) {
    return parts;
  }
  return chainFailure(parts, input) ?? { ok: true, payload: parts.payload };
};

const asSet = (values: StringSet): ReadonlySet<string> =>
  values instanceof Set ? values : new Set(Array.isArray(values) ? values : []);

const member = (values: StringSet, value: unknown): value is string =>
  typeof value === "string" && asSet(values).has(value);

const isIdentifier = (value: unknown): value is string =>
  typeof value === "string" && IDENTIFIER.test(value);

const entitlementActive = (payload: Payload, input: TransactionInput, now: number): boolean => {
  if (!member(input.productIds, payload["productId"]) || payload["type"] !== SUBSCRIPTION) {
    return false;
  }
  if (payload["revocationDate"] !== undefined && payload["revocationDate"] !== null) {
    return false;
  }
  const expiresDate = payload["expiresDate"];
  return isFiniteNumber(expiresDate) && expiresDate > now;
};

export const verifyTransaction = (input: TransactionInput): TransactionResult => {
  const now = input.now ?? Date.now();
  const signed = verifySigned({
    jws: input.jws,
    roots: input.roots,
    now,
    signedAt: (payload) => payload["signedDate"],
  });
  if (!signed.ok) {
    return signed;
  }
  const { originalTransactionId, productId, environment, expiresDate, bundleId } = signed.payload;
  if (bundleId !== input.bundleId || !isIdentifier(originalTransactionId)) {
    return fail("bad_transaction");
  }
  if (!member(input.environments, environment)) {
    return fail("bad_transaction");
  }
  if (
    !entitlementActive(signed.payload, input, now) ||
    !isFiniteNumber(expiresDate) ||
    typeof productId !== "string"
  ) {
    return fail("entitlement_inactive");
  }
  return { ok: true, originalTransactionId, productId, environment, expiresDate };
};

export const verifyAppTransaction = (input: AppTransactionInput): AppTransactionResult => {
  const signed = verifySigned({
    jws: input.jws,
    roots: input.roots,
    now: input.now ?? Date.now(),
    signedAt: (payload) => payload["receiptCreationDate"] ?? payload["signedDate"],
  });
  if (!signed.ok) {
    return signed;
  }
  const { bundleId, receiptType, appTransactionId } = signed.payload;
  if (bundleId !== input.bundleId) {
    return fail("bad_transaction", "bundle_id");
  }
  if (!member(input.environments, receiptType)) {
    return fail("bad_transaction", "receipt_type");
  }
  const named = isIdentifier(appTransactionId);
  if (appTransactionId !== undefined && appTransactionId !== null && !named) {
    return fail("bad_transaction", "app_transaction_id");
  }
  return { ok: true, appTransactionId: named ? appTransactionId : null, environment: receiptType };
};
