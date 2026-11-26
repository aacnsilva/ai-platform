import type { RequestContext } from "../gateway/context";
import { Rejection } from "../http/respond";
import type { AppAttestAuthn, Tenant } from "../tenants/schema";
import type { CertificateInput } from "./apple";
import {
  bytesToBase64Url,
  decodeBase64,
  defaultAttestRoots,
  defaultStoreRoots,
  verifyAppTransaction,
  verifyAssertion,
  verifyTransaction,
} from "./apple";
import { principalFor } from "./authenticate";
import type { KnownDevice } from "./device";
import type { Principal } from "./principal";

export interface DeviceRequest {
  tenant: Tenant;
  authn: AppAttestAuthn;
  rawBody: Uint8Array;
}

const KEY_ID_BYTES = 32;
const MAX_JWS_CHARS = 20_000;
const STORE_ENVIRONMENTS = ["Production", "Sandbox"];

const deny = (status: number, code: string): never => {
  throw new Rejection(status, code);
};

export const keyIdFrom = (value: string | null): Uint8Array | null => {
  const bytes = decodeBase64(value ?? "");
  return bytes?.length === KEY_ID_BYTES ? bytes : null;
};

export const deviceName = (tenantId: string, keyId: Uint8Array): string =>
  `device:${tenantId}:${bytesToBase64Url(keyId)}`;

export const attestRoots = (authn: AppAttestAuthn): readonly CertificateInput[] | null =>
  authn.roots === undefined ? defaultAttestRoots() : [authn.roots.attest];

const storeRoots = (authn: AppAttestAuthn): readonly CertificateInput[] | null =>
  authn.roots === undefined ? defaultStoreRoots() : authn.roots.store;

interface Presented {
  keyId: Uint8Array;
  assertion: Uint8Array;
  jws: string;
  isAppTransaction: boolean;
}

const transactionFrom = (
  request: Request,
  authn: AppAttestAuthn,
): Pick<Presented, "jws" | "isAppTransaction"> => {
  const subscription = request.headers.get("X-Store-Transaction") ?? "";
  if (subscription !== "") {
    return { jws: subscription, isAppTransaction: false };
  }
  const acceptsInstalls = authn.storeEnvironment === "Sandbox" && authn.installPlan !== undefined;
  const install = acceptsInstalls ? (request.headers.get("X-App-Transaction") ?? "") : "";
  return { jws: install, isAppTransaction: install !== "" };
};

const presentedBy = (request: Request, authn: AppAttestAuthn): Presented => {
  const keyId = keyIdFrom(request.headers.get("X-Device-Key-Id"));
  const assertion = decodeBase64(request.headers.get("X-Device-Assertion") ?? "");
  if (keyId === null || assertion === null) {
    return deny(401, "missing_assertion");
  }
  const transaction = transactionFrom(request, authn);
  if (/\s/.test(transaction.jws) || transaction.jws.length > MAX_JWS_CHARS) {
    return deny(401, "missing_transaction");
  }
  return { keyId, assertion, ...transaction };
};

const signedData = (rawBody: Uint8Array, jws: string): Uint8Array => {
  const tail = new TextEncoder().encode(`\n${jws}`);
  const data = new Uint8Array(rawBody.length + tail.length);
  data.set(rawBody, 0);
  data.set(tail, rawBody.length);
  return data;
};

const assertedCounter = (
  input: DeviceRequest,
  presented: Presented,
  device: KnownDevice,
): number => {
  const asserted = verifyAssertion({
    assertion: presented.assertion,
    clientData: signedData(input.rawBody, presented.jws),
    publicKey: device.publicKey,
    counter: device.counter,
    teamId: input.authn.teamId,
    bundleId: input.authn.bundleId,
  });
  return asserted.ok
    ? asserted.counter
    : deny(401, asserted.error === "replay" ? "replay" : "bad_assertion");
};

const installPrincipal = (input: DeviceRequest, presented: Presented): Principal => {
  const { authn, tenant } = input;
  const app = verifyAppTransaction({
    jws: presented.jws,
    bundleId: authn.bundleId,
    environments: ["Sandbox"],
    roots: storeRoots(authn),
    now: Date.now(),
  });
  if (!app.ok || authn.installPlan === undefined) {
    return deny(401, "bad_transaction");
  }
  const install = app.appTransactionId ?? `key-${bytesToBase64Url(presented.keyId)}`;
  return principalFor(tenant, `tester-${install}`, authn.installPlan);
};

const subscriberPrincipal = (input: DeviceRequest, presented: Presented): Principal => {
  const { authn, tenant } = input;
  const transaction = verifyTransaction({
    jws: presented.jws,
    bundleId: authn.bundleId,
    productIds: Object.keys(authn.products),
    environments: STORE_ENVIRONMENTS,
    roots: storeRoots(authn),
    now: Date.now(),
  });
  if (!transaction.ok) {
    return transaction.error === "entitlement_inactive"
      ? deny(403, "entitlement_inactive")
      : deny(401, "bad_transaction");
  }
  const plan = authn.products[transaction.productId];
  if (plan === undefined) {
    return deny(403, "entitlement_inactive");
  }
  return transaction.environment === authn.storeEnvironment
    ? principalFor(tenant, transaction.originalTransactionId, plan)
    : deny(404, "not_found");
};

const developerPlan = (authn: AppAttestAuthn, device: KnownDevice, jws: string): string | null => {
  const allowed = authn.storeEnvironment === "Sandbox" && device.environment === "development";
  return allowed && jws === "" ? (authn.developmentPlan ?? null) : null;
};

export const authenticateDevice = async (
  context: RequestContext,
  input: DeviceRequest,
): Promise<Principal> => {
  const { env, request } = context;
  const { authn, tenant } = input;
  const presented = presentedBy(request, authn);
  const store = env.SUBJECT.get(env.SUBJECT.idFromName(deviceName(tenant.id, presented.keyId)));
  const device = (await store.readDevice()) ?? deny(401, "unknown_device");
  const developer = developerPlan(authn, device, presented.jws);
  if (presented.jws === "" && developer === null) {
    return deny(401, "missing_transaction");
  }
  const counter = assertedCounter(input, presented, device);
  if (!(await store.bumpCounter(counter))) {
    return deny(401, "replay");
  }
  if (developer !== null) {
    return principalFor(tenant, `developer-${bytesToBase64Url(presented.keyId)}`, developer);
  }
  return presented.isAppTransaction
    ? installPrincipal(input, presented)
    : subscriberPrincipal(input, presented);
};
