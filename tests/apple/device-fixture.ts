import { Buffer as RuntimeBuffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import type { KeyObject } from "node:crypto";
import { createHash, createSign, generateKeyPairSync, randomInt } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isBufferConstructor = (value: unknown): value is BufferConstructor =>
  typeof value === "function";

const loadedBuffer: unknown = RuntimeBuffer;

if (!isBufferConstructor(loadedBuffer)) {
  throw new TypeError("node:buffer is unavailable");
}

const Buffer: BufferConstructor = loadedBuffer;

const DAY_MS = 24 * 60 * 60 * 1000;
const PROD_AAGUID = Buffer.concat([Buffer.from("appattest"), Buffer.alloc(7)]);
const DEV_AAGUID = Buffer.from("appattestdevelop");
const CA_EXTENSION = "basicConstraints=critical,CA:TRUE";
const LEAF_EXTENSION = "basicConstraints=CA:FALSE";
const NONCE_OID = "1.2.840.113635.100.8.2";
const STORE_LEAF_OID = "1.2.840.113635.100.6.11.1";
const STORE_INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";

export interface TestKey {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  readonly pem: string;
  readonly jwk: { readonly x: string; readonly y: string };
}

export interface TestChain {
  readonly rootPem: string;
  readonly intermediatePem: string;
  readonly leafPem: string;
  readonly leafDer: Buffer;
  readonly intermediateDer: Buffer;
}

export interface ChainOptions {
  readonly leafKeyPem: string;
  readonly leafExt: readonly string[];
  readonly intermediateExt: readonly string[];
}

export interface TestLeaf {
  readonly leafPem: string;
  readonly leafDer: Buffer;
}

export interface TestAuthority {
  readonly rootPem: string;
  readonly intermediatePem: string;
  readonly intermediateDer: Buffer;
  readonly issueLeaf: (leafKeyPem: string, leafExt: readonly string[]) => TestLeaf;
}

export interface FakeDeviceOptions {
  readonly teamId: string;
  readonly bundleId: string;
  readonly development?: boolean;
}

export interface FakeDevice {
  readonly keyId: string;
  readonly rootPem: string;
  readonly attest: (challenge: Uint8Array) => string;
  readonly assert: (clientData: Uint8Array) => string;
}

export interface FakeStoreOptions {
  readonly bundleId: string;
}

export interface FakeStore {
  readonly rootPem: string;
  readonly transaction: (overrides?: Record<string, unknown>) => string;
  readonly appTransaction: (overrides?: Record<string, unknown>) => string;
}

type CborInput = number | string | Uint8Array | CborInput[] | Map<CborInput, CborInput>;

const sha256 = (bytes: Uint8Array | string): Buffer => createHash("sha256").update(bytes).digest();

export const makeP256 = (): TestKey => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const { x, y } = publicKey.export({ format: "jwk" });
  if (x === undefined || y === undefined) {
    throw new Error("generated key has no coordinates");
  }
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  return { publicKey, privateKey, pem, jwk: { x, y } };
};

const openssl = (args: readonly string[], cwd: string): Buffer =>
  execFileSync("openssl", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });

const inTempDir = <Result>(work: (dir: string) => Result): Result => {
  const dir = mkdtempSync(join(tmpdir(), "apple-test-cert-"));
  try {
    return work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const extensionFile = (dir: string, name: string, lines: readonly string[]): string => {
  writeFileSync(join(dir, name), ["[v3]", ...lines, ""].join("\n"));
  return name;
};

const issueRoot = (dir: string): void => {
  writeFileSync(join(dir, "root.key"), makeP256().pem);
  openssl(
    [
      ...["req", "-x509", "-new", "-key", "root.key", "-sha256", "-days", "3650"],
      ...["-subj", "/CN=Example Test Root", "-out", "root.pem"],
      ...["-addext", CA_EXTENSION],
    ],
    dir,
  );
};

const issueIntermediate = (dir: string, extensions: readonly string[]): void => {
  openssl(
    ["req", "-new", "-key", "int.key", "-subj", "/CN=Example Test Intermediate", "-out", "int.csr"],
    dir,
  );
  const file = extensionFile(dir, "int.ext", extensions);
  openssl(
    [
      ...["x509", "-req", "-in", "int.csr", "-CA", "root.pem", "-CAkey", "root.key"],
      ...["-set_serial", "2", "-out", "int.pem", "-days", "365", "-sha256"],
      ...["-extfile", file, "-extensions", "v3"],
    ],
    dir,
  );
};

const issueLeafIn = (dir: string, extensions: readonly string[]): TestLeaf => {
  openssl(
    ["req", "-new", "-key", "leaf.key", "-subj", "/CN=Example Test Leaf", "-out", "leaf.csr"],
    dir,
  );
  const file = extensionFile(dir, "leaf.ext", extensions);
  openssl(
    [
      ...["x509", "-req", "-in", "leaf.csr", "-CA", "int.pem", "-CAkey", "int.key"],
      ...["-set_serial", String(randomInt(3, 2 ** 31)), "-out", "leaf.pem", "-days", "30"],
      ...["-sha256", "-extfile", file, "-extensions", "v3"],
    ],
    dir,
  );
  return {
    leafPem: openssl(["x509", "-in", "leaf.pem"], dir).toString("utf8"),
    leafDer: openssl(["x509", "-in", "leaf.pem", "-outform", "DER"], dir),
  };
};

export const makeAuthority = (intermediateExt: readonly string[]): TestAuthority => {
  const intermediateKeyPem = makeP256().pem;
  const issued = inTempDir((dir) => {
    issueRoot(dir);
    writeFileSync(join(dir, "int.key"), intermediateKeyPem);
    issueIntermediate(dir, intermediateExt);
    return {
      rootPem: openssl(["x509", "-in", "root.pem"], dir).toString("utf8"),
      intermediatePem: openssl(["x509", "-in", "int.pem"], dir).toString("utf8"),
      intermediateDer: openssl(["x509", "-in", "int.pem", "-outform", "DER"], dir),
    };
  });
  const issueLeaf = (leafKeyPem: string, leafExt: readonly string[]): TestLeaf =>
    inTempDir((dir) => {
      writeFileSync(join(dir, "int.key"), intermediateKeyPem);
      writeFileSync(join(dir, "int.pem"), issued.intermediatePem);
      writeFileSync(join(dir, "leaf.key"), leafKeyPem);
      return issueLeafIn(dir, leafExt);
    });
  return { ...issued, issueLeaf };
};

export const makeChain = (options: ChainOptions): TestChain => {
  const authority = makeAuthority(options.intermediateExt);
  const leaf = authority.issueLeaf(options.leafKeyPem, options.leafExt);
  return {
    rootPem: authority.rootPem,
    intermediatePem: authority.intermediatePem,
    intermediateDer: authority.intermediateDer,
    ...leaf,
  };
};

const P256_POINT_HEADER = Buffer.from([0x03, 0x42, 0x00, 0x04]);

export const withUndecodableKey = (certificateDer: Uint8Array): Buffer => {
  const der = Buffer.from(certificateDer);
  const header = der.indexOf(P256_POINT_HEADER);
  if (header < 0) {
    throw new Error("certificate has no P-256 key");
  }
  const x = header + P256_POINT_HEADER.length;
  return Buffer.concat([der.subarray(0, x), Buffer.alloc(32, 0xff), der.subarray(x + 32)]);
};

const padded = (body: Buffer): Buffer => {
  const trimmed = body[0] === 0x00 ? body.subarray(1) : body;
  const out = Buffer.alloc(32);
  trimmed.copy(out, 32 - trimmed.length);
  return out;
};

export const derToRaw = (der: Buffer): Buffer => {
  if (der[0] !== 0x30) {
    throw new Error("signature sequence");
  }
  const lengthByte = der.readUInt8(1);
  let offset = (lengthByte & 0x80) === 0 ? 2 : 2 + (lengthByte & 0x7f);
  const readInt = (): Buffer => {
    if (der[offset] !== 0x02) {
      throw new Error("signature integer");
    }
    const length = der.readUInt8(offset + 1);
    const body = der.subarray(offset + 2, offset + 2 + length);
    offset += 2 + length;
    return padded(body);
  };
  return Buffer.concat([readInt(), readInt()]);
};

const cborHead = (major: number, value: number): Buffer => {
  if (value < 24) {
    return Buffer.from([(major << 5) | value]);
  }
  if (value <= 0xff) {
    return Buffer.from([(major << 5) | 24, value]);
  }
  if (value > 0xffff) {
    throw new Error("fixture value too large for this encoder");
  }
  const head = Buffer.alloc(3);
  head.writeUInt8((major << 5) | 25, 0);
  head.writeUInt16BE(value, 1);
  return head;
};

const cborMap = (map: Map<CborInput, CborInput>): Buffer => {
  const parts = [cborHead(5, map.size)];
  for (const [key, item] of map) {
    parts.push(cbor(key), cbor(item));
  }
  return Buffer.concat(parts);
};

function cbor(value: CborInput): Buffer {
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([cborHead(2, value.length), value]);
  }
  if (value instanceof Map) {
    return cborMap(value);
  }
  return Buffer.concat([cborHead(4, value.length), ...value.map(cbor)]);
}

const signDer = (key: TestKey, message: Uint8Array | string): Buffer => {
  const signer = createSign("SHA256");
  signer.update(message);
  signer.end();
  return signer.sign(key.privateKey);
};

const authenticatorHead = (appId: string, flags: number, counter: number): Buffer => {
  const tail = Buffer.alloc(5);
  tail.writeUInt8(flags, 0);
  tail.writeUInt32BE(counter, 1);
  return Buffer.concat([sha256(appId), tail]);
};

const coseKey = (x: Buffer, y: Buffer): Buffer =>
  cbor(
    new Map<CborInput, CborInput>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );

const nonceExtension = (nonce: Buffer): string[] => [
  `${NONCE_OID}=critical,ASN1:SEQUENCE:nonce_seq`,
  "",
  "[nonce_seq]",
  `nonce=EXPLICIT:1,FORMAT:HEX,OCTETSTRING:${nonce.toString("hex")}`,
];

export const createFakeDevice = (options: FakeDeviceOptions): FakeDevice => {
  const appId = `${options.teamId}.${options.bundleId}`;
  const key = makeP256();
  const authority = makeAuthority([CA_EXTENSION]);
  const x = Buffer.from(key.jwk.x, "base64url");
  const y = Buffer.from(key.jwk.y, "base64url");
  const credentialId = sha256(Buffer.concat([Buffer.from([0x04]), x, y]));
  const aaguid = options.development === true ? DEV_AAGUID : PROD_AAGUID;
  let counter = 0;

  const attest = (challenge: Uint8Array): string => {
    const length = Buffer.from([0x00, credentialId.length]);
    const authData = Buffer.concat([
      authenticatorHead(appId, 0x40, 0),
      ...[aaguid, length, credentialId, coseKey(x, y)],
    ]);
    const nonce = sha256(Buffer.concat([authData, sha256(challenge)]));
    const leaf = authority.issueLeaf(key.pem, [LEAF_EXTENSION, ...nonceExtension(nonce)]);
    const statement = new Map<CborInput, CborInput>([
      ["x5c", [leaf.leafDer, authority.intermediateDer]],
      ["receipt", Buffer.from([0x30])],
    ]);
    const object = new Map<CborInput, CborInput>([
      ["fmt", "apple-appattest"],
      ["attStmt", statement],
      ["authData", authData],
    ]);
    return cbor(object).toString("base64");
  };

  const assert = (clientData: Uint8Array): string => {
    counter += 1;
    const authenticatorData = authenticatorHead(appId, 0x00, counter);
    const nonce = sha256(Buffer.concat([authenticatorData, sha256(clientData)]));
    const object = new Map<CborInput, CborInput>([
      ["signature", signDer(key, nonce)],
      ["authenticatorData", authenticatorData],
    ]);
    return cbor(object).toString("base64");
  };

  return { keyId: credentialId.toString("base64"), rootPem: authority.rootPem, attest, assert };
};

const numericId = (): string => String(randomInt(10 ** 13, 10 ** 14));

export const createFakeStore = (options: FakeStoreOptions): FakeStore => {
  const key = makeP256();
  const authority = makeAuthority([CA_EXTENSION, `${STORE_INTERMEDIATE_OID}=critical,DER:05:00`]);
  const leaf = authority.issueLeaf(key.pem, [
    LEAF_EXTENSION,
    `${STORE_LEAF_OID}=critical,DER:05:00`,
  ]);
  const header = {
    alg: "ES256",
    x5c: [leaf.leafDer.toString("base64"), authority.intermediateDer.toString("base64")],
  };
  const originalTransactionId = numericId();
  const appTransactionId = numericId();

  const sign = (payload: Record<string, unknown>): string => {
    const signingInput = [header, payload]
      .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
      .join(".");
    return `${signingInput}.${derToRaw(signDer(key, signingInput)).toString("base64url")}`;
  };

  const transaction = (overrides: Record<string, unknown> = {}): string =>
    sign({
      bundleId: options.bundleId,
      productId: "example.plan.monthly",
      originalTransactionId,
      transactionId: numericId(),
      expiresDate: Date.now() + 30 * DAY_MS,
      signedDate: Date.now() - 60_000,
      type: "Auto-Renewable Subscription",
      environment: "Production",
      ...overrides,
    });

  const appTransaction = (overrides: Record<string, unknown> = {}): string =>
    sign({
      bundleId: options.bundleId,
      receiptCreationDate: Date.now() - 60_000,
      receiptType: "Sandbox",
      appTransactionId,
      ...overrides,
    });

  return { rootPem: authority.rootPem, transaction, appTransaction };
};
