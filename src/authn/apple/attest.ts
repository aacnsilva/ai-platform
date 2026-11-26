import type { KeyObject } from "node:crypto";
import { createPublicKey, timingSafeEqual, verify as verifySignature } from "node:crypto";

import { certExtensionValue, octetStringInsideSequence } from "./asn1";
import { Buffer } from "./buffer";
import { bytesToBase64Url, sha256 } from "./bytes";
import type { CborValue } from "./cbor";
import { cborTextMap, decodeCbor, readCbor } from "./cbor";
import type { CertificateInput, VerifiedChain } from "./chain";
import { verifyChain } from "./chain";

export const APP_ATTEST_NONCE_OID: Buffer = Buffer.from([
  0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02,
]);

const PROD_AAGUID = Buffer.concat([Buffer.from("appattest"), Buffer.alloc(7)]);
const DEV_AAGUID = Buffer.from("appattestdevelop");
const ATTESTED_CREDENTIAL_FLAG = 0x40;
const COORDINATE_LENGTH = 32;

export type AttestationErrorCode =
  "unconfigured" | "bad_attestation" | "bad_app" | "bad_key" | "bad_challenge";

export type AssertionErrorCode =
  "bad_assertion" | "bad_app" | "replay" | "bad_key" | "bad_signature";

export type AppAttestEnvironment = "development" | "production";

export interface AppAttestFailure<Code extends string> {
  readonly ok: false;
  readonly error: Code;
}

export interface AppAttestPublicKey {
  readonly x: string;
  readonly y: string;
}

export interface AttestationSuccess {
  readonly ok: true;
  readonly publicKey: AppAttestPublicKey;
  readonly environment: AppAttestEnvironment;
  readonly counter: 0;
}

export type AttestationResult = AttestationSuccess | AppAttestFailure<AttestationErrorCode>;

export interface AssertionSuccess {
  readonly ok: true;
  readonly counter: number;
}

export type AssertionResult = AssertionSuccess | AppAttestFailure<AssertionErrorCode>;

export interface AttestationInput {
  readonly attestation: Uint8Array;
  readonly challenge: Uint8Array;
  readonly keyId: Uint8Array;
  readonly teamId: string;
  readonly bundleId: string;
  readonly roots: readonly CertificateInput[] | null | undefined;
  readonly now?: number | undefined;
}

interface AssertionCommon {
  readonly assertion: Uint8Array;
  readonly publicKey: AppAttestPublicKey;
  readonly counter: number;
  readonly teamId: string;
  readonly bundleId: string;
}

export type AssertionInput = AssertionCommon &
  (
    | { readonly clientData: Uint8Array; readonly clientDataHash?: undefined }
    | { readonly clientDataHash: Uint8Array; readonly clientData?: Uint8Array | undefined }
  );

export interface AuthenticatorData {
  readonly rpIdHash: Buffer;
  readonly flags: number;
  readonly counter: number;
  readonly aaguid?: Buffer;
  readonly credentialId?: Buffer;
  readonly cose?: Map<CborValue, CborValue>;
}

export interface AssertionSignatureInput {
  readonly authenticatorData: Uint8Array;
  readonly clientDataHash: Uint8Array;
  readonly key: KeyObject;
  readonly signature: Uint8Array;
}

interface Coords {
  readonly x: Buffer;
  readonly y: Buffer;
}

type Coordinate = Uint8Array | string;

const fail = <Code extends string>(error: Code): AppAttestFailure<Code> => ({ ok: false, error });

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const appIdHash = (teamId: string, bundleId: string): Buffer =>
  sha256(Buffer.from(`${teamId}.${bundleId}`, "utf8"));

const coordinateBytes = (value: Coordinate): Buffer =>
  typeof value === "string" ? Buffer.from(value, "base64url") : Buffer.from(value);

const coordsFrom = (x: Coordinate, y: Coordinate): Coords | null => {
  const xBytes = coordinateBytes(x);
  const yBytes = coordinateBytes(y);
  if (xBytes.length !== COORDINATE_LENGTH || yBytes.length !== COORDINATE_LENGTH) {
    return null;
  }
  return { x: xBytes, y: yBytes };
};

const pointOf = (coords: Coords): Buffer =>
  Buffer.concat([Buffer.from([0x04]), coords.x, coords.y]);

export const uncompressedPoint = (x: Coordinate, y: Coordinate): Buffer | null => {
  const coords = coordsFrom(x, y);
  return coords ? pointOf(coords) : null;
};

export const keyFromCoords = (x: Coordinate, y: Coordinate): KeyObject | null => {
  const coords = coordsFrom(x, y);
  if (!coords) {
    return null;
  }
  return createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: bytesToBase64Url(coords.x),
      y: bytesToBase64Url(coords.y),
    },
    format: "jwk",
  });
};

const coseAfter = (buf: Buffer, offset: number): Map<CborValue, CborValue> | null => {
  try {
    const { value } = readCbor(buf, offset);
    return value instanceof Map ? value : null;
  } catch {
    return null;
  }
};

const attestedCredential = (buf: Buffer, head: AuthenticatorData): AuthenticatorData | null => {
  if (buf.length < 55) {
    return null;
  }
  const credentialLength = buf.readUInt16BE(53);
  const credentialEnd = 55 + credentialLength;
  if (credentialLength !== 32 || credentialEnd > buf.length) {
    return null;
  }
  const cose = coseAfter(buf, credentialEnd);
  if (!cose) {
    return null;
  }
  return {
    ...head,
    aaguid: Buffer.from(buf.subarray(37, 53)),
    credentialId: Buffer.from(buf.subarray(55, credentialEnd)),
    cose,
  };
};

export const parseAuthenticatorData = (authData: Uint8Array): AuthenticatorData | null => {
  const buf = Buffer.from(authData);
  if (buf.length < 37) {
    return null;
  }
  const head = {
    rpIdHash: Buffer.from(buf.subarray(0, 32)),
    flags: buf.readUInt8(32),
    counter: buf.readUInt32BE(33),
  };
  if ((head.flags & ATTESTED_CREDENTIAL_FLAG) === 0) {
    return head;
  }
  return attestedCredential(buf, head);
};

const asCoordinate = (value: CborValue | undefined): Coordinate | null =>
  typeof value === "string" || value instanceof Uint8Array ? value : null;

const coseCoords = (cose: ReadonlyMap<CborValue, CborValue>): Coords | null => {
  if (cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) {
    return null;
  }
  const x = asCoordinate(cose.get(-2));
  const y = asCoordinate(cose.get(-3));
  return x !== null && y !== null ? coordsFrom(x, y) : null;
};

const knownAaguid = (aaguid: Uint8Array): boolean =>
  sameBytes(aaguid, PROD_AAGUID) || sameBytes(aaguid, DEV_AAGUID);

const environmentOf = (aaguid: Uint8Array): AppAttestEnvironment =>
  sameBytes(aaguid, DEV_AAGUID) ? "development" : "production";

interface AttestationObject {
  readonly authData: Buffer;
  readonly certificates: readonly CborValue[];
}

interface Credential {
  readonly aaguid: Buffer;
  readonly credentialId: Buffer;
  readonly cose: ReadonlyMap<CborValue, CborValue>;
}

const decodeTextMap = (bytes: Uint8Array): Record<string, CborValue> | null => {
  try {
    const decoded = decodeCbor(bytes);
    return decoded instanceof Map ? cborTextMap(decoded) : null;
  } catch {
    return null;
  }
};

const asCertificateBytes = (value: CborValue | undefined): string | Uint8Array | null =>
  typeof value === "string" || value instanceof Uint8Array ? value : null;

const statementOf = (object: Record<string, CborValue>): Record<string, CborValue> | null => {
  const statement = object["attStmt"];
  return statement instanceof Map ? cborTextMap(statement) : null;
};

const attestationObject = (bytes: Uint8Array): AttestationObject | null => {
  const object = decodeTextMap(bytes);
  if (object?.["fmt"] !== "apple-appattest") {
    return null;
  }
  const statement = statementOf(object);
  const authData = object["authData"];
  if (!statement || !Buffer.isBuffer(authData)) {
    return null;
  }
  const certificates = statement["x5c"];
  if (!Array.isArray(certificates) || certificates.length < 2) {
    return null;
  }
  return { authData, certificates };
};

const credentialOf = (
  authData: Buffer,
  input: AttestationInput,
): Credential | AppAttestFailure<"bad_attestation" | "bad_app"> => {
  const parsed = parseAuthenticatorData(authData);
  if (!parsed?.credentialId || !parsed.aaguid || !parsed.cose) {
    return fail("bad_attestation");
  }
  if (parsed.counter !== 0 || !knownAaguid(parsed.aaguid)) {
    return fail("bad_attestation");
  }
  if (!sameBytes(parsed.rpIdHash, appIdHash(input.teamId, input.bundleId))) {
    return fail("bad_app");
  }
  return { aaguid: parsed.aaguid, credentialId: parsed.credentialId, cose: parsed.cose };
};

const nonceMatches = (chain: VerifiedChain, nonce: Buffer): boolean => {
  try {
    const extension = certExtensionValue(chain.leaf.raw, APP_ATTEST_NONCE_OID);
    const embedded = extension && octetStringInsideSequence(extension);
    return embedded !== null && sameBytes(embedded, nonce);
  } catch {
    return false;
  }
};

const certificatePoint = (chain: VerifiedChain): Buffer | null => {
  try {
    const jwk = chain.leaf.publicKey.export({ format: "jwk" });
    if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
      return null;
    }
    return uncompressedPoint(Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url"));
  } catch {
    return null;
  }
};

const attestationChain = (
  object: AttestationObject,
  input: AttestationInput,
): VerifiedChain | null => {
  const leafDer = asCertificateBytes(object.certificates[0]);
  const intermediateDer = asCertificateBytes(object.certificates[1]);
  if (leafDer === null || intermediateDer === null) {
    return null;
  }
  return verifyChain({
    leafDer,
    intermediateDer,
    roots: input.roots,
    now: input.now ?? Date.now(),
    leafOid: APP_ATTEST_NONCE_OID,
  });
};

const certificateFailure = (
  object: AttestationObject,
  point: Buffer,
  input: AttestationInput,
): AppAttestFailure<AttestationErrorCode> | null => {
  const nonce = sha256(Buffer.concat([object.authData, sha256(input.challenge)]));
  const chain = attestationChain(object, input);
  if (!chain) {
    return fail("bad_attestation");
  }
  if (!nonceMatches(chain, nonce)) {
    return fail("bad_challenge");
  }
  const certPoint = certificatePoint(chain);
  return certPoint && sameBytes(certPoint, point) ? null : fail("bad_key");
};

const attestedKey = (
  object: AttestationObject,
  credential: Credential,
  input: AttestationInput,
): AttestationResult => {
  const coords = coseCoords(credential.cose);
  if (!coords) {
    return fail("bad_key");
  }
  const point = pointOf(coords);
  const digest = sha256(point);
  if (!sameBytes(credential.credentialId, digest) || !sameBytes(input.keyId, digest)) {
    return fail("bad_key");
  }
  const failure = certificateFailure(object, point, input);
  if (failure) {
    return failure;
  }
  return {
    ok: true,
    publicKey: { x: bytesToBase64Url(coords.x), y: bytesToBase64Url(coords.y) },
    environment: environmentOf(credential.aaguid),
    counter: 0,
  };
};

export const verifyAttestation = (input: AttestationInput): AttestationResult => {
  if (!input.roots) {
    return fail("unconfigured");
  }
  const object = attestationObject(input.attestation);
  if (!object) {
    return fail("bad_attestation");
  }
  const credential = credentialOf(object.authData, input);
  if ("error" in credential) {
    return credential;
  }
  return attestedKey(object, credential, input);
};

export const assertionSigned = (input: AssertionSignatureInput): boolean => {
  const nonce = sha256(Buffer.concat([input.authenticatorData, input.clientDataHash]));
  try {
    return verifySignature("sha256", nonce, input.key, input.signature);
  } catch {
    return false;
  }
};

interface AssertionObject {
  readonly signature: Buffer;
  readonly authenticatorData: Buffer;
}

const assertionObject = (bytes: Uint8Array): AssertionObject | null => {
  const object = decodeTextMap(bytes);
  if (!object) {
    return null;
  }
  const signature = object["signature"];
  const authenticatorData = object["authenticatorData"];
  if (!Buffer.isBuffer(signature) || !Buffer.isBuffer(authenticatorData)) {
    return null;
  }
  if (signature.length < 8 || signature.length > 200 || authenticatorData.length < 37) {
    return null;
  }
  return { signature, authenticatorData };
};

const counterFailure = (
  authenticatorData: Buffer,
  input: AssertionInput,
): AppAttestFailure<"bad_app" | "bad_assertion" | "replay"> | null => {
  const rpIdHash = authenticatorData.subarray(0, 32);
  if (!sameBytes(rpIdHash, appIdHash(input.teamId, input.bundleId))) {
    return fail("bad_app");
  }
  if (!Number.isInteger(input.counter) || input.counter < 0) {
    return fail("bad_assertion");
  }
  return authenticatorData.readUInt32BE(33) <= input.counter ? fail("replay") : null;
};

const clientDataHashOf = (input: AssertionInput): Uint8Array => {
  if (input.clientDataHash !== undefined) {
    return input.clientDataHash;
  }
  return sha256(input.clientData);
};

export const verifyAssertion = (input: AssertionInput): AssertionResult => {
  const object = assertionObject(input.assertion);
  if (!object) {
    return fail("bad_assertion");
  }
  const { signature, authenticatorData } = object;
  const failure = counterFailure(authenticatorData, input);
  if (failure) {
    return failure;
  }
  const key = keyFromCoords(input.publicKey.x, input.publicKey.y);
  if (!key) {
    return fail("bad_key");
  }
  const clientDataHash = clientDataHashOf(input);
  if (!assertionSigned({ authenticatorData, clientDataHash, key, signature })) {
    return fail("bad_signature");
  }
  return { ok: true, counter: authenticatorData.readUInt32BE(33) };
};
