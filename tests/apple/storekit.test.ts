import { createSign } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AppTransactionResult, TransactionResult } from "../../src/authn/apple";
import { verifyAppTransaction, verifyTransaction } from "../../src/authn/apple";
import { Buffer } from "../../src/authn/apple/buffer";
import type { TestChain, TestKey } from "./cert-fixture";
import { derToRaw, makeChain, makeP256, withUndecodableKey } from "./cert-fixture";

const BUNDLE = "com.example.app";
const MONTHLY = "example.plan.monthly";
const YEARLY = "example.plan.yearly";
const PRODUCTS = [MONTHLY, YEARLY];
const ENVIRONMENTS = ["Production", "Sandbox"];
const DAY_MS = 24 * 60 * 60 * 1000;

type Payload = Record<string, unknown>;

interface Fixture {
  readonly chain: TestChain;
  readonly jws: string;
}

const sign = (key: TestKey, chain: TestChain, payload: Payload): string => {
  const header = {
    alg: "ES256",
    x5c: [chain.leafDer.toString("base64"), chain.intermediateDer.toString("base64")],
  };
  const signingInput = [
    Buffer.from(JSON.stringify(header)).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
  ].join(".");
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${derToRaw(signer.sign(key.privateKey)).toString("base64url")}`;
};

const appStoreChain = (key: TestKey): TestChain =>
  makeChain({
    leafKeyPem: key.pem,
    leafExt: ["basicConstraints=CA:FALSE", "1.2.840.113635.100.6.11.1=critical,DER:05:00"],
    intermediateExt: [
      "basicConstraints=critical,CA:TRUE",
      "1.2.840.113635.100.6.2.1=critical,DER:05:00",
    ],
  });

const plainChain = (key: TestKey): TestChain =>
  makeChain({
    leafKeyPem: key.pem,
    leafExt: ["basicConstraints=CA:FALSE"],
    intermediateExt: ["basicConstraints=critical,CA:TRUE"],
  });

const transactionPayload = (overrides: Payload = {}): Payload => ({
  bundleId: BUNDLE,
  productId: MONTHLY,
  originalTransactionId: "1000001234567890",
  expiresDate: Date.now() + 30 * DAY_MS,
  signedDate: Date.now() - 60_000,
  type: "Auto-Renewable Subscription",
  environment: "Sandbox",
  ...overrides,
});

const appPayload = (overrides: Payload = {}): Payload => ({
  bundleId: BUNDLE,
  receiptCreationDate: Date.now() - 60_000,
  receiptType: "Sandbox",
  ...overrides,
});

const issuedPayload = (payload: Payload): Fixture => {
  const key = makeP256();
  const chain = appStoreChain(key);
  return { chain, jws: sign(key, chain, payload) };
};

const issued = (overrides: Payload = {}): Fixture => issuedPayload(transactionPayload(overrides));

const check = (fixture: Fixture, extra: Partial<Parameters<typeof verifyTransaction>[0]> = {}) =>
  verifyTransaction({
    jws: fixture.jws,
    bundleId: BUNDLE,
    productIds: PRODUCTS,
    environments: ENVIRONMENTS,
    roots: [fixture.chain.rootPem],
    now: Date.now(),
    ...extra,
  });

const checkApp = (
  fixture: Fixture,
  extra: Partial<Parameters<typeof verifyAppTransaction>[0]> = {},
) =>
  verifyAppTransaction({
    jws: fixture.jws,
    bundleId: BUNDLE,
    environments: ENVIRONMENTS,
    roots: [fixture.chain.rootPem],
    ...extra,
  });

const rejection = (result: TransactionResult | AppTransactionResult): string =>
  result.ok ? "accepted" : `${result.error}/${result.reason}`;

describe("storekit transaction", () => {
  it("an active subscription transaction verifies", () => {
    const result = check(issued());
    expect(result).toMatchObject({
      ok: true,
      originalTransactionId: "1000001234567890",
      environment: "Sandbox",
    });
    expect(check(issued({ productId: YEARLY }))).toMatchObject({
      ok: true,
      originalTransactionId: "1000001234567890",
    });
    expect(check(issued(), { productIds: new Set(PRODUCTS) }).ok).toBe(true);
  });

  it("expired, revoked, or the wrong product is not an active entitlement", () => {
    const inactive = "entitlement_inactive/entitlement_inactive";
    expect(rejection(check(issued({ expiresDate: Date.now() - 60_000 })))).toBe(inactive);
    expect(rejection(check(issued({ revocationDate: Date.now() - 60_000 })))).toBe(inactive);
    expect(rejection(check(issued({ productId: "example.other.monthly" })))).toBe(inactive);
    expect(rejection(check(issued({ type: "Non-Consumable" })))).toBe(inactive);
    expect(rejection(check(issued({ expiresDate: "never" })))).toBe(inactive);
    expect(rejection(check(issued(), { productIds: [] }))).toBe(inactive);
  });

  it("a bad signature, the wrong app, or an untrusted root is rejected", () => {
    const fixture = issued();
    const [header = "", payload = "", signature = ""] = fixture.jws.split(".");
    const flipped = Buffer.from(signature, "base64url");
    flipped.writeUInt8(flipped.readUInt8(0) ^ 0xff, 0);
    const tampered = `${header}.${payload}.${flipped.toString("base64url")}`;
    expect(rejection(check({ ...fixture, jws: tampered }))).toBe("bad_transaction/signature");
    const bad = "bad_transaction/bad_transaction";
    expect(rejection(check(issued({ bundleId: "com.example.other" })))).toBe(bad);
    expect(rejection(check(issued({ environment: "Xcode" })))).toBe(bad);
    expect(rejection(check(issued({ originalTransactionId: "not valid!" })))).toBe(bad);
    const other = plainChain(makeP256());
    expect(rejection(check(fixture, { roots: [other.rootPem] }))).toBe("bad_transaction/chain");
  });

  it("an intermediate whose key cannot be decoded is a chain failure, not a throw", () => {
    const key = makeP256();
    const genuine = appStoreChain(key);
    const chain = { ...genuine, intermediateDer: withUndecodableKey(genuine.intermediateDer) };
    const jws = sign(key, chain, transactionPayload());
    expect(rejection(check({ jws, chain }))).toBe("bad_transaction/chain");
    expect(rejection(checkApp({ jws: sign(key, chain, appPayload()), chain }))).toBe(
      "bad_transaction/chain",
    );
  });

  it("the allowed environments are the caller's choice", () => {
    const sandbox = issued();
    expect(rejection(check(sandbox, { environments: ["Production"] }))).toBe(
      "bad_transaction/bad_transaction",
    );
    expect(check(sandbox, { environments: new Set(["Sandbox"]) }).ok).toBe(true);
  });

  it("a payload signed by a key other than the leaf's is rejected", () => {
    const fixture = issued();
    const forged = sign(makeP256(), fixture.chain, transactionPayload());
    expect(rejection(check({ ...fixture, jws: forged }))).toBe("bad_transaction/signature");
  });

  it("a chain without the App Store OIDs is rejected", () => {
    const key = makeP256();
    const chain = plainChain(key);
    const jws = sign(key, chain, transactionPayload({ environment: "Production" }));
    expect(rejection(check({ jws, chain }))).toBe("bad_transaction/chain");
  });

  it("the chain is checked on the day Apple signed, so a leaf that expired since still verifies", () => {
    const later = Date.now() + 60 * DAY_MS;
    const fixture = issued({ expiresDate: later + 300 * DAY_MS });
    expect(check(fixture, { now: later }).ok).toBe(true);
  });

  it("a transaction without a signed date, or signed in the future, is rejected", () => {
    const undated = "bad_transaction/signed_date";
    expect(rejection(check(issued({ signedDate: undefined })))).toBe(undated);
    expect(rejection(check(issued({ signedDate: "yesterday" })))).toBe(undated);
    expect(rejection(check(issued({ signedDate: Date.now() + 60 * 60 * 1000 })))).toBe(undated);
  });

  it("a malformed JWS is rejected before any certificate is read", () => {
    const fixture = issued();
    const [header = "", payload = "", signature = ""] = fixture.jws.split(".");
    const encode = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    expect(rejection(check({ ...fixture, jws: "short" }))).toBe("bad_transaction/jws_shape");
    expect(rejection(check(fixture, { jws: 42 }))).toBe("bad_transaction/jws_shape");
    expect(rejection(check({ ...fixture, jws: `${fixture.jws}\n` }))).toBe(
      "bad_transaction/jws_shape",
    );
    expect(rejection(check({ ...fixture, jws: `${header}.${payload}` }))).toBe(
      "bad_transaction/jws_parts",
    );
    expect(
      rejection(check({ ...fixture, jws: `${encode({ alg: "none" })}.${payload}.${signature}` })),
    ).toBe("bad_transaction/jws_header");
    expect(rejection(check({ ...fixture, jws: `${header}.${encode(null)}.${signature}` }))).toBe(
      "bad_transaction/jws_header",
    );
    expect(rejection(check({ ...fixture, jws: `${header}.${payload}.AAAA` }))).toBe(
      "bad_transaction/signature_length",
    );
    expect(rejection(check(fixture, { roots: null }))).toBe("unconfigured/unconfigured");
  });
});

describe("storekit app transaction", () => {
  it("a TestFlight AppTransaction is dated by receiptCreationDate and names its install", () => {
    const app = issuedPayload(appPayload({ appTransactionId: "705000000000001" }));
    expect(checkApp(app)).toEqual({
      ok: true,
      appTransactionId: "705000000000001",
      environment: "Sandbox",
    });
  });

  it("before iOS 18.4 there is no appTransactionId", () => {
    expect(checkApp(issuedPayload(appPayload()))).toEqual({
      ok: true,
      appTransactionId: null,
      environment: "Sandbox",
    });
  });

  it("a signedDate dates an AppTransaction only when receiptCreationDate is absent", () => {
    const fallback = appPayload({
      receiptCreationDate: undefined,
      signedDate: Date.now() - 60_000,
    });
    expect(checkApp(issuedPayload(fallback)).ok).toBe(true);
    const future = appPayload({
      receiptCreationDate: Date.now() + 60 * 60 * 1000,
      signedDate: Date.now() - 60_000,
    });
    expect(rejection(checkApp(issuedPayload(future)))).toBe("bad_transaction/signed_date");
    const undated = appPayload({ receiptCreationDate: undefined });
    expect(rejection(checkApp(issuedPayload(undated)))).toBe("bad_transaction/signed_date");
  });

  it("the wrong app, receipt type, install id or root is rejected", () => {
    const app = issuedPayload(appPayload({ appTransactionId: "705000000000001" }));
    expect(rejection(checkApp(app, { bundleId: "com.example.other" }))).toBe(
      "bad_transaction/bundle_id",
    );
    expect(rejection(checkApp(app, { environments: ["Production"] }))).toBe(
      "bad_transaction/receipt_type",
    );
    expect(rejection(checkApp(issued()))).toBe("bad_transaction/receipt_type");
    expect(rejection(checkApp(issuedPayload(appPayload({ appTransactionId: 7 }))))).toBe(
      "bad_transaction/app_transaction_id",
    );
    expect(rejection(checkApp(app, { roots: [issued().chain.rootPem] }))).toBe(
      "bad_transaction/chain",
    );
    expect(rejection(checkApp(app, { roots: undefined }))).toBe("unconfigured/unconfigured");
  });
});
